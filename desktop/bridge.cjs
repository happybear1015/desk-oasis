/* 桌面端核心服务（内嵌于 Electron 主进程）
   1. 局域网手机伴侣：只提供 mobile 页面静态资源 + 带配对码的 WebSocket
   2. 中心服同步：权益 / 好友 / 消息 / 反馈回复 / 支付 / 兑换码
   桌面商城窗口与手机伴侣共用这里的同一套动作（试看 / 购买 / 兑换 / 鱼友），保证两端行为一致 */
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');
const catalog = require('../shared/catalog.cjs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
const MESSAGE_TTL = 24 * 60 * 60 * 1000;
const BREEDS = (catalog.skins || []).map((s) => s.id).concat(['guppy', 'neon']);
const SKIN_IDS = (catalog.skins || []).map((s) => s.id);
const INTERACT_KINDS = ['poke', 'feed', 'clean', 'heart', 'plane', 'urge'];

function getServerBase() {
  return (process.env.DESK_OASIS_SERVER || catalog.brand.site).replace(/\/+$/, '');
}

function getLanIps() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) candidates.push({ ip: info.address, name });
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  candidates.sort((a, b) => rank(a.ip) - rank(b.ip));
  return candidates.length ? candidates : [{ ip: '127.0.0.1', name: 'localhost' }];
}
const getLanIp = () => getLanIps()[0].ip;

/* config 是主进程持有的配置对象（引用），这里直接读写并通过 onConfigChange 触发保存 */
function startBridge({ devUrl, distDir, dataDir, config, version, onConfigChange, onEvent }) {
  if (!config.pairToken || config.pairToken.length < 12) config.pairToken = crypto.randomBytes(6).toString('hex').toUpperCase();
  const token = config.pairToken;
  const serverBase = getServerBase();
  const sockets = new Set();
  let tank = { lightOn: true, eggs: 0, roam: false };
  let friends = [];
  let visitors = []; // 正在我缸里串门的好友：只有他们的鱼会出现在鱼缸里
  let visiting = null; // 我的鱼正在谁家串门
  let requests = [];
  let messages = []; // { id, friendId, from: 'me' | 'friend', text, ts }，仅内存，24 小时清理
  let livePricing = null; // 管理员后台动态定价覆盖
  let lastSeenRelease = version;
  let previewTimer = null;
  let activePreviewTheme = null;
  let activePreviewSkin = null;
  let syncTimer = null;
  let activeUntil = 0;
  let closed = false;

  const feedbackFile = path.join(dataDir, 'feedback.json');
  let feedbacks = [];
  try { feedbacks = JSON.parse(fs.readFileSync(feedbackFile, 'utf8')); } catch {}
  const saveFeedbacks = () => {
    try { fs.writeFileSync(feedbackFile, JSON.stringify(feedbacks.slice(0, 50), null, 2)); } catch {}
  };

  const emit = (msg) => onEvent?.(msg);
  const changed = () => { onConfigChange?.(); pushState(); };
  const friendList = () => friends;
  const visitorList = () => visitors;

  function getStore() {
    const now = Date.now();
    messages = messages.filter((m) => now - m.ts < MESSAGE_TTL);
    const skin = SKIN_IDS.includes(config.breed) ? config.breed : 'goldfish';
    return {
      profile: { userId: config.userId, nickname: config.nickname, account: config.account, breed: skin, allowRequests: config.allowRequests !== false },
      cloud: config.cloud !== false,
      version,
      theme: config.theme,
      skin,
      unlockedThemes: config.unlockedThemes,
      unlockedSkins: Array.isArray(config.unlockedSkins) ? config.unlockedSkins : [...(catalog.freeSkins || ['goldfish'])],
      unlockedFeatures: Array.isArray(config.unlockedFeatures) ? config.unlockedFeatures : [],
      previewedThemes: Array.isArray(config.previewedThemes) ? config.previewedThemes : [],
      previewedSkins: Array.isArray(config.previewedSkins) ? config.previewedSkins : [],
      previewedFeatures: Array.isArray(config.previewedFeatures) ? config.previewedFeatures : [],
      screensaverTrialDate: config.screensaverTrialDate || '',
      roamTrialDate: config.roamTrialDate || '',
      roamTrialUsedSec: Number(config.roamTrialUsedSec) || 0,
      roamRemainingSec: getFeatureRemainingSec('roam'),
      featureRemaining: getAllFeatureRemaining(),
      growth: getGrowthStatus(),
      autoScreensaver: Boolean(config.autoScreensaver),
      screensaverIdleMinutes: Math.max(1, Number(config.screensaverIdleMinutes) || 3),
      hasScreensaverPin: Boolean(config.screensaverPin),
      screensaverLockWin: Boolean(config.screensaverLockWin),
      multiScreen: config.multiScreen !== false,
      pricing: livePricing,
      ...tank,
      friends: friendList(),
      visitors: visitorList().map((f) => f.id),
      visiting,
      requests,
      messages,
      feedbacks: feedbacks.slice(0, 20)
    };
  }

  function broadcast(payload) {
    const raw = JSON.stringify(payload);
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
  function pushState() {
    broadcast({ type: 'state', ...getStore() });
    emit({ type: 'store:changed' });
  }

  /* ---------- 中心服 ---------- */
  async function api(route, body = {}) {
    try {
      const res = await fetch(`${serverBase}/api/oasis/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: config.userId, key: config.userKey, ...body }),
        signal: AbortSignal.timeout(8000)
      });
      return await res.json();
    } catch {
      return { ok: false, offline: true, message: '网络异常，稍后再试' };
    }
  }

  function unlock(themes, features, skins) {
    let changedAny = false;
    if (Array.isArray(themes)) {
      const merged = Array.from(new Set([...config.unlockedThemes, ...themes]));
      if (merged.length !== config.unlockedThemes.length) {
        config.unlockedThemes = merged;
        changedAny = true;
      }
    }
    if (Array.isArray(skins)) {
      const curS = Array.isArray(config.unlockedSkins) ? config.unlockedSkins : [...(catalog.freeSkins || ['goldfish'])];
      const mergedS = Array.from(new Set([...curS, ...skins]));
      if (mergedS.length !== curS.length) {
        config.unlockedSkins = mergedS;
        changedAny = true;
      }
    }
    if (Array.isArray(features)) {
      const cur = Array.isArray(config.unlockedFeatures) ? config.unlockedFeatures : [];
      const mergedF = Array.from(new Set([...cur, ...features]));
      if (mergedF.length !== cur.length) {
        config.unlockedFeatures = mergedF;
        changedAny = true;
      }
    }
    return changedAny;
  }

  function applySync(data) {
    let dirty = unlock(data.unlockedThemes, data.unlockedFeatures, data.unlockedSkins);
    if (Array.isArray(data.previewedThemes)) {
      const merged = Array.from(new Set([...(config.previewedThemes || []), ...data.previewedThemes]));
      if (merged.length !== (config.previewedThemes || []).length) {
        config.previewedThemes = merged;
        dirty = true;
      }
    }
    if (Array.isArray(data.previewedSkins)) {
      const mergedS = Array.from(new Set([...(config.previewedSkins || []), ...data.previewedSkins]));
      if (mergedS.length !== (config.previewedSkins || []).length) {
        config.previewedSkins = mergedS;
        dirty = true;
      }
    }
    if (Array.isArray(data.previewedFeatures)) {
      const mergedF = Array.from(new Set([...(config.previewedFeatures || []), ...data.previewedFeatures]));
      if (mergedF.length !== (config.previewedFeatures || []).length) {
        config.previewedFeatures = mergedF;
        dirty = true;
      }
    }
    if (data.pricing && typeof data.pricing === 'object') {
      if (JSON.stringify(livePricing) !== JSON.stringify(data.pricing)) {
        livePricing = data.pricing;
        dirty = true;
      }
    }
    if (data.latestVersion && data.latestVersion !== lastSeenRelease) {
      lastSeenRelease = data.latestVersion;
      if (data.latestVersion !== version) emit({ type: 'release:new', latestVersion: data.latestVersion });
    }
    if (Array.isArray(data.friends)) {
      const before = new Map(visitorList().map((f) => [f.id, f]));
      const prevVisiting = visiting;
      friends = data.friends;
      visitors = Array.isArray(data.visitors) ? data.visitors : [];
      visiting = data.visiting || null;
      const after = visitorList();
      for (const f of after) {
        if (!before.has(f.id)) {
          emit({ type: 'friend:add', friend: f, enter: true });
          emit({ type: 'notice', kind: 'info', title: `${f.name} 来串门了`, body: '点鱼可发水泡', duration: 3600 });
        }
      }
      for (const [id, oldFriend] of before.entries()) {
        if (!after.some((f) => f.id === id)) {
          emit({ type: 'friend:remove', friendId: id, exit: true });
          if (oldFriend?.name) {
            emit({ type: 'notice', kind: 'info', title: `${oldFriend.name} 回家了`, body: '', duration: 3000 });
          }
        }
      }
      const visitingChanged =
        (prevVisiting?.id || null) !== (visiting?.id || null) ||
        Boolean(prevVisiting?.roam) !== Boolean(visiting?.roam) ||
        (prevVisiting?.theme || '') !== (visiting?.theme || '') ||
        Boolean(prevVisiting?.lightOn) !== Boolean(visiting?.lightOn) ||
        (prevVisiting?.breed || '') !== (visiting?.breed || '');
      if (visitingChanged) {
        emit({ type: 'visit:self', visiting, prev: prevVisiting, breed: config.breed });
      }
      dirty = true;
    }
    if (Array.isArray(data.requests)) {
      const known = new Set(requests.map((r) => r.id));
      const fresh = data.requests.filter((r) => !known.has(r.id));
      requests = data.requests;
      if (fresh.length) {
        broadcast({ type: 'toast', ok: true, message: `${fresh[0].name} 想加你好友` });
        emit({
          type: 'notice',
          kind: 'request',
          title: '新好友申请',
          body: `${fresh[0].name} 想加你好友`,
          sub: fresh[0].id,
          friendId: fresh[0].id
        });
        dirty = true;
      }
    }
    for (const m of data.inbox || []) {
      activeUntil = Date.now() + 5 * 60 * 1000;
      if (m.kind === 'text') {
        const senderName = (data.friends || friends).find((f) => f.id === m.from)?.name || m.from;
        const cleanText = Array.from(String(m.text || '').trim()).slice(0, 20).join('');
        const item = { id: m.id, friendId: m.from, friendName: senderName, from: 'friend', text: cleanText, ts: m.ts || Date.now() };
        messages.push(item);
        broadcast({ type: 'chat:msg', item });
        emit({ type: 'chat:incoming', item });
        dirty = true;
      } else if (m.kind === 'visit') {
        const name = (data.friends || friends).find((f) => f.id === m.from)?.name || '鱼友';
        broadcast({ type: 'toast', ok: true, message: name + ' 的鱼来你家串门了' });
        emit({ type: 'action', action: 'visitor' });
      } else if (INTERACT_KINDS.includes(m.kind)) {
        emit({ type: 'chat:interact', friendId: m.from, kind: m.kind });
        broadcast({ type: 'chat:interact', friendId: m.from, kind: m.kind });
      }
    }
    for (const reply of data.feedbackReplies || []) {
      const local = feedbacks.find((f) => f.id === reply.id);
      if (local && (local.status !== reply.status || local.reply !== reply.reply)) {
        local.status = reply.status;
        local.reply = reply.reply;
        saveFeedbacks();
        dirty = true;
      }
    }
    if (dirty) changed();
  }

  async function sync() {
    if (config.cloud === false) return;
    const data = await api('heartbeat', {
      nickname: config.nickname,
      account: config.account,
      breed: config.breed,
      theme: config.theme,
      lightOn: tank.lightOn,
      roam: Boolean(tank.roam),
      previewedThemes: Array.isArray(config.previewedThemes) ? config.previewedThemes : [],
      previewedSkins: Array.isArray(config.previewedSkins) ? config.previewedSkins : [],
      previewedFeatures: Array.isArray(config.previewedFeatures) ? config.previewedFeatures : [],
      allowRequests: config.allowRequests !== false,
      client: 'desktop',
      version
    });
    if (data?.ok) applySync(data);
  }

  /* SSE 实时通道：服务端有新串门、水泡消息或支付到账时秒级唤醒 sync() */
  let sseController = null;
  let sseRetryTimer = null;
  function stopSse() {
    clearTimeout(sseRetryTimer);
    if (sseController) { sseController.abort(); sseController = null; }
  }
  async function connectSse() {
    stopSse();
    if (closed || config.cloud === false) return;
    const ctrl = new AbortController();
    sseController = ctrl;
    try {
      const res = await fetch(`${serverBase}/api/oasis/events?userId=${encodeURIComponent(config.userId)}`, {
        headers: { 'X-Oasis-Key': config.userKey, Accept: 'text/event-stream' },
        signal: ctrl.signal
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!closed && !ctrl.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('event: sync')) {
          buf = '';
          syncSoon();
        } else if (buf.length > 4096) {
          buf = buf.slice(-256);
        }
      }
    } catch {}
    if (!closed && config.cloud !== false && sseController === ctrl) {
      sseRetryTimer = setTimeout(connectSse, 8000);
    }
  }
  function scheduleSync() {
    if (closed) return;
    /* 有手机连着、正在串门或最近在互动时 5 秒一拉，平时 15 秒；配合 SSE 保证串门与消息秒达 */
    const fast = sockets.size > 0 || Boolean(visiting) || visitors.length > 0 || Date.now() < activeUntil;
    syncTimer = setTimeout(async () => {
      await sync();
      scheduleSync();
    }, fast ? 5000 : 15000);
  }
  function syncSoon() {
    activeUntil = Date.now() + 5 * 60 * 1000;
    clearTimeout(syncTimer);
    sync().finally(scheduleSync);
  }
  /* 付费、兑换、加好友都依赖云端账号，用户发起这些操作时自动恢复同步 */
  function ensureCloud() {
    if (config.cloud === false) {
      config.cloud = true;
      changed();
    }
  }

  /* ---------- 动作 ---------- */
  function applyTheme(themeId) {
    if (!config.unlockedThemes.includes(themeId)) return false;
    clearTimeout(previewTimer);
    activePreviewTheme = null;
    config.theme = themeId;
    emit({ type: 'action', action: `theme:${themeId}` });
    changed();
    return true;
  }
  /* 每套未解锁造景仅限试看 1 次（15 秒），试看结束后不能再试看 */
  function previewTheme(themeId) {
    if (!catalog.themes.some((t) => t.id === themeId)) return { ok: false, message: '造景不存在' };
    if (config.unlockedThemes.includes(themeId)) return { ok: false, message: '已拥有，可直接使用' };
    config.previewedThemes = Array.isArray(config.previewedThemes) ? config.previewedThemes : [];
    if (config.previewedThemes.includes(themeId)) {
      return { ok: false, message: '已试看过，解锁后可用' };
    }
    config.previewedThemes.push(themeId);
    activePreviewTheme = themeId;
    clearTimeout(previewTimer);
    emit({ type: 'action', action: `theme:${themeId}` });
    changed();
    if (config.cloud !== false) syncSoon();
    previewTimer = setTimeout(() => {
      activePreviewTheme = null;
      emit({ type: 'action', action: `theme:${config.theme}` });
      emit({ type: 'preview:ended', skuId: themeId });
    }, catalog.previewSeconds * 1000);
    return { ok: true, seconds: catalog.previewSeconds };
  }

  let skinPreviewTimer = null;
  function applySkin(skinId) {
    const unlocked = Array.isArray(config.unlockedSkins) ? config.unlockedSkins : [...(catalog.freeSkins || ['goldfish'])];
    if (!unlocked.includes(skinId)) return false;
    clearTimeout(skinPreviewTimer);
    activePreviewSkin = null;
    config.breed = skinId;
    emit({ type: 'action', action: `skin:${skinId}` });
    changed();
    if (config.cloud !== false) syncSoon();
    return true;
  }
  function previewSkin(skinId) {
    if (!(catalog.skins || []).some((s) => s.id === skinId)) return { ok: false, message: '皮肤不存在' };
    const unlocked = Array.isArray(config.unlockedSkins) ? config.unlockedSkins : [...(catalog.freeSkins || ['goldfish'])];
    if (unlocked.includes(skinId)) return { ok: false, message: '已拥有，可直接换上' };
    config.previewedSkins = Array.isArray(config.previewedSkins) ? config.previewedSkins : [];
    if (config.previewedSkins.includes(skinId)) {
      return { ok: false, message: '已试穿过，解锁后可用' };
    }
    config.previewedSkins.push(skinId);
    activePreviewSkin = skinId;
    clearTimeout(skinPreviewTimer);
    emit({ type: 'action', action: `skin:${skinId}` });
    changed();
    if (config.cloud !== false) syncSoon();
    skinPreviewTimer = setTimeout(() => {
      activePreviewSkin = null;
      emit({ type: 'action', action: `skin:${config.breed || 'goldfish'}` });
      emit({ type: 'preview:ended', skuId: skinId });
    }, catalog.previewSeconds * 1000);
    return { ok: true, seconds: catalog.previewSeconds };
  }

  async function redeem(code) {
    ensureCloud();
    const data = await api('redeem', { code: String(code || '').trim().toUpperCase() });
    if (data?.ok) {
      unlock(data.unlockedThemes, data.unlockedFeatures, data.unlockedSkins);
      changed();
    }
    return { ok: Boolean(data?.ok), message: data?.message || '兑换失败' };
  }

  /* 独立功能每日 20 分钟活跃使用计时引擎（screensaver / roam / multiscreen / growth 统一管理，仅在使用期间计时） */
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const FEATURE_DAILY_LIMIT_SEC = (Number(catalog.featureTrialMinutes) || 20) * 60;
  const TRACKED_FEATURES = ['screensaver', 'wallpaper', 'roam', 'multiscreen', 'growth'];

  function ensureFeatureTrials() {
    if (!config.featureTrials || typeof config.featureTrials !== 'object') config.featureTrials = {};
    // 兼容旧版 roamTrialDate / roamTrialUsedSec 迁移
    if (config.roamTrialDate && !config.featureTrials.roam) {
      config.featureTrials.roam = { date: config.roamTrialDate, usedSec: Number(config.roamTrialUsedSec) || 0 };
    }
    return config.featureTrials;
  }

  function isFeatureOwned(featureId) {
    const owned = Array.isArray(config.unlockedFeatures) && config.unlockedFeatures.includes(featureId);
    const feat = (catalog.features || []).find((f) => f.id === featureId);
    const liveCents = livePricing?.features?.[featureId] ?? feat?.cents ?? 300;
    return owned || liveCents === 0;
  }

  function getFeatureRemainingSec(featureId) {
    if (isFeatureOwned(featureId)) return Infinity;
    const trials = ensureFeatureTrials();
    const today = todayStr();
    const rec = trials[featureId];
    if (!rec || rec.date !== today) {
      trials[featureId] = { date: today, usedSec: 0 };
      return FEATURE_DAILY_LIMIT_SEC;
    }
    return Math.max(0, FEATURE_DAILY_LIMIT_SEC - (Number(rec.usedSec) || 0));
  }

  function addFeatureUsageSec(featureId, sec = 1) {
    if (isFeatureOwned(featureId)) return Infinity;
    const trials = ensureFeatureTrials();
    const today = todayStr();
    if (!trials[featureId] || trials[featureId].date !== today) {
      trials[featureId] = { date: today, usedSec: 0 };
    }
    trials[featureId].usedSec = Math.min(FEATURE_DAILY_LIMIT_SEC, (Number(trials[featureId].usedSec) || 0) + Math.max(0, sec));
    if (featureId === 'roam') {
      config.roamTrialDate = today;
      config.roamTrialUsedSec = trials[featureId].usedSec;
    }
    onConfigChange?.();
    return Math.max(0, FEATURE_DAILY_LIMIT_SEC - trials[featureId].usedSec);
  }

  function getAllFeatureRemaining() {
    const out = {};
    for (const id of TRACKED_FEATURES) {
      const r = getFeatureRemainingSec(id);
      out[id] = Number.isFinite(r) ? r : null; // null 代表已永久解锁不限时
    }
    return out;
  }

  const getRoamRemainingSec = () => getFeatureRemainingSec('roam');
  const addRoamUsageSec = (sec = 1) => addFeatureUsageSec('roam', sec);

  /* 主鱼治愈轻成长系统（永远不会饿死或生病；喂食与陪伴积累经验，5 档阶段，支持锁定体型） */
  const GROWTH_STAGES = [
    { level: 1, name: '幼苗', minExp: 0, scaleMul: 0.94, aura: 0 },
    { level: 2, name: '灵动', minExp: 60, scaleMul: 1.0, aura: 0.25 },
    { level: 3, name: '舒展', minExp: 180, scaleMul: 1.08, aura: 0.52 },
    { level: 4, name: '丰盈', minExp: 400, scaleMul: 1.15, aura: 0.78 },
    { level: 5, name: '锦瑞光晕', minExp: 800, scaleMul: 1.22, aura: 1.0 }
  ];

  function ensureGrowth() {
    const today = todayStr();
    if (!config.growth || typeof config.growth !== 'object') {
      config.growth = { enabled: true, exp: 0, feedCount: 0, days: 1, lastDay: today, lockSize: false };
    }
    if (config.growth.lastDay !== today) {
      config.growth.lastDay = today;
      config.growth.days = Math.max(1, (Number(config.growth.days) || 0) + 1);
      config.growth.exp = (Number(config.growth.exp) || 0) + 30;
    }
    return config.growth;
  }

  function getGrowthStatus() {
    const g = ensureGrowth();
    const exp = Math.max(0, Number(g.exp) || 0);
    let stage = GROWTH_STAGES[0];
    let nextStage = GROWTH_STAGES[1];
    for (let i = 0; i < GROWTH_STAGES.length; i += 1) {
      if (exp >= GROWTH_STAGES[i].minExp) {
        stage = GROWTH_STAGES[i];
        nextStage = GROWTH_STAGES[i + 1] || null;
      }
    }
    const rem = getFeatureRemainingSec('growth');
    const active = Boolean(g.enabled) && (!Number.isFinite(rem) || rem > 0);
    return {
      enabled: Boolean(g.enabled),
      active,
      lockSize: Boolean(g.lockSize),
      exp,
      feedCount: Number(g.feedCount) || 0,
      days: Number(g.days) || 1,
      level: stage.level,
      stageName: stage.name,
      scaleMul: active && !g.lockSize ? stage.scaleMul : 1.0,
      aura: active ? stage.aura : 0,
      nextMinExp: nextStage ? nextStage.minExp : null,
      remainingSec: Number.isFinite(rem) ? rem : null
    };
  }

  let lastFeedExpAt = 0;
  function addGrowthExp(points, { isFeed = false } = {}) {
    const g = ensureGrowth();
    const rem = getFeatureRemainingSec('growth');
    if (!g.enabled || (Number.isFinite(rem) && rem <= 0)) return getGrowthStatus();
    if (isFeed) {
      const now = Date.now();
      if (now - lastFeedExpAt < 8000) return getGrowthStatus();
      lastFeedExpAt = now;
      g.feedCount = (Number(g.feedCount) || 0) + 1;
    }
    const prevLevel = getGrowthStatus().level;
    g.exp = (Number(g.exp) || 0) + Math.max(1, Number(points) || 1);
    const next = getGrowthStatus();
    changed();
    if (next.level > prevLevel) {
      emit({ type: 'notice', kind: 'info', title: `主鱼成长至 Lv.${next.level} ${next.stageName}`, body: '体态更舒展，解锁新微光', duration: 4200 });
      emit({ type: 'action', action: 'celebrate' });
    }
    return next;
  }

  function claimFeaturePreview(featureId) {
    const rem = getFeatureRemainingSec(featureId);
    if (!Number.isFinite(rem)) return { ok: true, owned: true, remainingSec: Infinity };
    if (rem <= 0) {
      return { ok: false, owned: false, remainingSec: 0, message: '今日 20 分钟体验已用完，解锁后不限时' };
    }
    return { ok: true, owned: false, preview: true, remainingSec: rem };
  }

  const payPolls = new Set();
  async function createPayment(skuId, device = 'desktop') {
    ensureCloud();
    const data = await api('pay/create', { skuId, device });
    if (!data?.ok || !data.payUrl) return { ok: false, message: data?.message || '下单失败，请稍后再试' };
    /* 付款后 3 秒一查，最长 10 分钟，到账立刻解锁并通知两端 */
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > 10 * 60 * 1000) { clearInterval(timer); payPolls.delete(timer); return; }
      try {
        const res = await fetch(`${serverBase}/api/oasis/pay/status?outTradeNo=${encodeURIComponent(data.outTradeNo)}`, { signal: AbortSignal.timeout(5000) });
        const status = await res.json();
        if (status?.status !== 'paid') return;
        clearInterval(timer);
        payPolls.delete(timer);
        unlock(status.unlockedThemes, status.unlockedFeatures, status.unlockedSkins);
        changed();
        const message = `支付成功，已永久解锁「${data.skuName}」`;
        broadcast({ type: 'toast', ok: true, message, paid: true });
        emit({ type: 'store:paid', message });
      } catch {}
    }, 3000);
    payPolls.add(timer);
    return { ok: true, payUrl: data.payUrl, qrUrl: data.qrUrl || data.payUrl, amountYuan: data.amountYuan, skuName: data.skuName };
  }

  function updateProfile({ nickname, account, breed, allowRequests }) {
    if (nickname !== undefined) config.nickname = String(nickname).trim().slice(0, 16) || '桌边渔友';
    if (account !== undefined) config.account = String(account).trim().slice(0, 48);
    const unlockedSkins = Array.isArray(config.unlockedSkins) ? config.unlockedSkins : [...(catalog.freeSkins || ['goldfish'])];
    if (SKIN_IDS.includes(breed) && unlockedSkins.includes(breed)) config.breed = breed;
    if (typeof allowRequests === 'boolean') config.allowRequests = allowRequests;
    changed();
    if (config.cloud !== false) syncSoon();
  }

  async function checkNickname(nickname) {
    const name = String(nickname || '').trim().slice(0, 16);
    if (name.length < 2) return { ok: true, available: false, message: '昵称至少 2 个字哦' };
    return await api('nickname/check', { nickname: name });
  }

  async function claimNickname(nickname, breed) {
    const name = String(nickname || '').trim().slice(0, 16);
    if (name.length < 2) return { ok: false, message: '昵称至少 2 个字哦' };
    const data = await api('nickname/claim', { nickname: name, breed: BREEDS.includes(breed) ? breed : config.breed });
    if (data?.ok || data?.offline) {
      config.nickname = name;
      if (BREEDS.includes(breed)) config.breed = breed;
      config.named = true;
      changed();
      if (config.cloud !== false) syncSoon();
      return { ok: true, nickname: name, message: data?.message || `欢迎你，${name}！` };
    }
    return { ok: false, message: data?.message || '这个名字已被占用，换一个吧' };
  }

  function addFeedback({ category = '功能建议', content = '', message = '', contact = '', source = 'desktop' }) {
    const body = String(content || message || '').trim().slice(0, 500);
    if (!body) return { ok: false, message: '请填写内容' };
    const item = {
      id: crypto.randomUUID(),
      userId: config.userId,
      nickname: config.nickname,
      account: String(contact || config.account || '').slice(0, 48),
      category: String(category).slice(0, 16),
      content: body,
      source,
      status: '待处理',
      reply: '',
      createdAt: new Date().toISOString()
    };
    feedbacks.unshift(item);
    saveFeedbacks();
    pushState();
    /* 反馈是用户主动提交的内容，即使关闭了云同步也会送达 */
    api('feedback', item);
    return { ok: true, message: '已收到反馈', item };
  }

  async function friendAction(action, body) {
    if (!['request', 'respond', 'remove', 'visit', 'leave'].includes(action)) return { ok: false, message: '未知操作' };
    ensureCloud();
    let data = await api(`friends/${action}`, body);
    /* 刚开启云同步或首次启动尚未完成心跳时，先补一次心跳再重试，避免误报「账号校验失败」 */
    if (!data?.ok && data?.message === '账号校验失败') {
      await sync();
      data = await api(`friends/${action}`, body);
    }
    if (data?.ok && Array.isArray(data.friends)) applySync(data);
    else if (data?.ok) syncSoon();
    return { ok: Boolean(data?.ok), message: data?.message || (data?.ok ? '' : '操作失败') };
  }

  async function sendChat(friendId, rawText) {
    const content = Array.from(String(rawText || '').trim()).slice(0, 20).join('');
    if (!content || !friendId) return { ok: false, message: '请输入 1～20 字内容' };
    const targetName = friends.find((f) => f.id === friendId)?.name || String(friendId);
    const item = { id: crypto.randomUUID(), friendId: String(friendId), friendName: targetName, from: 'me', text: content, ts: Date.now() };
    messages.push(item);
    broadcast({ type: 'chat:msg', item });
    emit({ type: 'chat:send', item });
    changed();
    activeUntil = Date.now() + 5 * 60 * 1000;
    const data = await api('friends/send', { friendId: item.friendId, kind: 'text', text: content });
    if (!data?.ok) broadcast({ type: 'toast', ok: false, message: data?.message || '消息没送达' });
    else if (!data.delivered) broadcast({ type: 'toast', ok: true, message: '对方离线，24h 内上线可见' });
    return { ok: Boolean(data?.ok), message: data?.message || '' };
  }

  async function interact(friendId, kind) {
    if (!INTERACT_KINDS.includes(kind)) return;
    /* 自己的缸里先看到效果，再把同样的互动送到对方桌面 */
    emit({ type: 'chat:interact', friendId: String(friendId), kind });
    activeUntil = Date.now() + 5 * 60 * 1000;
    const data = await api('friends/send', { friendId, kind });
    if (!data?.ok) broadcast({ type: 'toast', ok: false, message: data?.message || '互动没送达' });
  }

  function setCloud(on) {
    config.cloud = Boolean(on);
    changed();
    if (config.cloud) { syncSoon(); connectSse(); }
    else stopSse();
  }

  /* 账号恢复码：把 userId + userKey 编码为一串可复制的凭证，用于换电脑自助找回已购造景与鱼友 */
  function exportRecoveryCode() {
    const raw = Buffer.from(`${config.userId}:${config.userKey}`, 'utf8').toString('base64url');
    return `DO-RECOVERY-${raw}`;
  }
  async function importRecoveryCode(rawInput) {
    const trimmed = String(rawInput || '').trim();
    const match = trimmed.match(/^DO-RECOVERY-([A-Za-z0-9_-]+)$/);
    if (!match) return { ok: false, message: '恢复码格式不对' };
    let decoded = '';
    try { decoded = Buffer.from(match[1], 'base64url').toString('utf8'); } catch { return { ok: false, message: '恢复码无效' }; }
    const sep = decoded.indexOf(':');
    const nextId = sep > 0 ? decoded.slice(0, sep).trim().toUpperCase() : '';
    const nextKey = sep > 0 ? decoded.slice(sep + 1).trim() : '';
    if (!/^DO-[0-9A-F]{6,12}$/.test(nextId) || nextKey.length < 16) return { ok: false, message: '恢复码无效' };
    try {
      const res = await fetch(`${serverBase}/api/oasis/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: nextId, key: nextKey, client: 'desktop', version }),
        signal: AbortSignal.timeout(8000)
      });
      const data = await res.json();
      if (!data?.ok) return { ok: false, message: data?.message || '恢复码无效' };
      config.userId = nextId;
      config.userKey = nextKey;
      config.cloud = true;
      unlock(data.unlockedThemes, data.unlockedFeatures, data.unlockedSkins);
      applySync(data);
      changed();
      connectSse();
      return { ok: true, message: `已恢复账号 ${nextId}` };
    } catch {
      return { ok: false, message: '连不上服务器' };
    }
  }

  /* 删除云端数据并停止同步；本机已解锁的造景保留在本地继续可用 */
  async function deleteCloudData() {
    const data = await api('user/delete');
    if (!data?.ok && !data?.offline && data?.message !== '账号校验失败') return { ok: false, message: data?.message || '删除失败' };
    if (data?.offline) return { ok: false, message: '连不上服务器' };
    for (const f of visitorList()) emit({ type: 'friend:remove', friendId: f.id });
    if (visiting) emit({ type: 'visit:self', visiting: null, prev: visiting, breed: config.breed });
    friends = [];
    visitors = [];
    visiting = null;
    requests = [];
    messages = [];
    config.account = '';
    config.cloud = false;
    changed();
    return { ok: true, message: '云端资料已删除' };
  }

  /* ---------- 局域网 HTTP：只放行手机伴侣页面需要的静态文件 ---------- */
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

    if (devUrl) {
      try {
        const upstream = await fetch(`${devUrl}${url.pathname}${url.search}`);
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      } catch {
        // Vite 不可用时回退到本地 dist
      }
    }

    const reqPath = url.pathname === '/' ? '/mobile.html' : url.pathname;
    const allowed = reqPath === '/mobile.html' || reqPath === '/manifest.webmanifest' || reqPath.startsWith('/assets/') || reqPath.startsWith('/icons/');
    const filePath = path.resolve(distDir, `.${reqPath}`);
    if (!allowed || !filePath.startsWith(distDir + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(filePath).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  wss.on('error', (err) => {
    if (err?.code !== 'EADDRINUSE') console.warn('[bridge:wss]', err?.message || err);
  });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const room = String(url.searchParams.get('room') || '');
    if (room.length !== token.length || !crypto.timingSafeEqual(Buffer.from(room), Buffer.from(token)) || sockets.size >= 5) {
      ws.close(4001, 'Invalid room');
      return;
    }
    sockets.add(ws);
    ws.send(JSON.stringify({ type: 'state', ...getStore() }));
    emit({ type: 'phone:count', count: sockets.size });
    syncSoon();

    const reply = (payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); };
    const toast = (result) => reply({ type: 'toast', ok: result.ok, message: result.message });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      switch (msg?.type) {
        case 'action':
          if (['feed', 'clean', 'light', 'hatch'].includes(msg.action)) emit({ type: 'action', action: msg.action });
          break;
        case 'toilet:start': emit({ type: 'action', action: 'hideout:on' }); break;
        case 'toilet:end': emit({ type: 'action', action: 'hideout:off' }); break;
        case 'theme:apply': applyTheme(String(msg.themeId)); break;
        case 'theme:preview': {
          const r = previewTheme(String(msg.themeId));
          if (!r?.ok) toast(r || { ok: false, message: '无法试看' });
          break;
        }
        case 'skin:apply': applySkin(String(msg.skinId)); break;
        case 'skin:preview': {
          const r = previewSkin(String(msg.skinId));
          if (!r?.ok) toast(r || { ok: false, message: '无法试看' });
          break;
        }
        case 'theme:redeem': toast(await redeem(msg.code)); break;
        case 'pay:create': reply({ type: 'pay:url', ...await createPayment(String(msg.skuId), 'mobile') }); break;
        case 'profile:update': updateProfile(msg); break;
        case 'feedback:submit': addFeedback({ ...msg, source: 'mobile' }); break;
        case 'friend:request': toast(await friendAction('request', { friendId: String(msg.code || '').trim().toUpperCase() })); break;
        case 'friend:respond': toast(await friendAction('respond', { friendId: String(msg.friendId), accept: Boolean(msg.accept) })); break;
        case 'friend:remove': toast(await friendAction('remove', { friendId: String(msg.friendId) })); break;
        case 'friend:visit': toast(await friendAction('visit', { friendId: String(msg.friendId) })); break;
        case 'friend:leave': toast(await friendAction('leave', {})); break;
        case 'chat:send': sendChat(msg.friendId, msg.text); break;
        case 'chat:interact': interact(String(msg.friendId), String(msg.kind)); break;
        case 'cloud:set': setCloud(msg.on); break;
        case 'cloud:delete': toast(await deleteCloudData()); break;
      }
    });

    ws.on('close', () => {
      sockets.delete(ws);
      emit({ type: 'phone:count', count: sockets.size });
    });
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
    };
    server.once('error', (err) => {
      if (err?.code === 'EADDRINUSE') {
        server.listen(0, '0.0.0.0', finish);
      } else {
        console.warn('[bridge:http]', err?.message || err);
        server.listen(0, '0.0.0.0', finish);
      }
    });
    server.on('error', (err) => {
      if (err?.code !== 'EADDRINUSE') console.warn('[bridge:http]', err?.message || err);
    });
    server.listen(18787, '0.0.0.0', finish);

    function done() {
      const port = server.address().port;
      sync().finally(() => { scheduleSync(); connectSse(); });

      resolve({
        getPairInfo: async (preferredIp) => {
          const ips = getLanIps();
          const chosen = ips.some((i) => i.ip === preferredIp) ? preferredIp : ips[0].ip;
          const url = `http://${chosen}:${port}/mobile.html?room=${token}`;
          return {
            url,
            ip: chosen,
            ips,
            qrDataUrl: await QRCode.toDataURL(url, { width: 320, margin: 1, color: { dark: '#0f282c', light: '#ffffffff' } }),
            connected: sockets.size
          };
        },
        updateTank: (patch) => {
          const prevRoam = Boolean(tank.roam);
          tank = { ...tank, ...patch };
          broadcast({ type: 'state', ...getStore() });
          if (patch?.roam !== undefined && Boolean(patch.roam) !== prevRoam && config.cloud !== false) syncSoon();
        },
        getStore,
        getActiveTheme: () => activePreviewTheme || config.theme,
        getActiveSkin: () => activePreviewSkin || config.breed || 'goldfish',
        getInitialFriends: visitorList,
        friendAction,
        applyTheme,
        previewTheme,
        applySkin,
        previewSkin,
        claimFeaturePreview,
        isFeatureOwned,
        getFeatureRemainingSec,
        addFeatureUsageSec,
        getAllFeatureRemaining,
        getGrowthStatus,
        addGrowthExp,
        getRoamRemainingSec,
        addRoamUsageSec,
        redeem,
        createPayment,
        updateProfile,
        checkNickname,
        claimNickname,
        addFeedback,
        sendChat,
        interact,
        setCloud,
        exportRecoveryCode,
        importRecoveryCode,
        deleteCloudData,
        syncNow: syncSoon,
        close: () => {
          closed = true;
          stopSse();
          clearTimeout(syncTimer);
          clearTimeout(previewTimer);
          clearTimeout(skinPreviewTimer);
          payPolls.forEach(clearInterval);
          wss.close();
          server.close();
        }
      });
    }
  });
}

module.exports = { startBridge, getServerBase };
