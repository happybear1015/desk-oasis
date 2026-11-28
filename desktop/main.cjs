/* 桌面生态 · DeskOasis（Electron 主进程）
   透明无边框窗口 + 点击穿透 + 右键菜单 + 托盘 + 全局老板键 */
const { app, BrowserWindow, Menu, Tray, ipcMain, screen, globalShortcut, nativeImage, powerMonitor, shell, dialog } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const catalog = require('../shared/catalog.cjs');
const { startBridge } = require('./bridge.cjs');
const { checkUpdate, downloadAndInstall, cancelDownload } = require('./updater.cjs');
const { attachWallpaper, detachWallpaper } = require('./wallpaper.cjs');
const { checkWindowsAuth, verifyWindowsAuth } = require('./winauth.cjs');

const BRAND = catalog.brand.name;
const DEV_URL = process.env.DESK_OASIS_DEV_URL;
const SIZES = { mini: 260, standard: 380, large: 520, huge: 700 };
const SIZE_LABEL = { mini: '迷你', standard: '标准', large: '大', huge: '特大' };
const ASPECT = 0.86; // 高 / 宽
const BOSS_KEY = 'CommandOrControl+Alt+M';
const WALLPAPER_EXIT_KEY = 'CommandOrControl+Alt+W';
const LOCK_SCREEN_KEY = 'CommandOrControl+Alt+L';

let win = null;
const dialogs = {}; // pair / feedback / update / store / notify 小窗
let pendingUpdate = null;
let pendingNotice = null;
let pendingUpgradeTarget = null;
let forceUpgradeLocked = false;
let peeking = false; // 正在观光好友鱼缸（锁定窗口移动、缩放与铺满）
let peekingFriend = null;
let peekRestore = null;
let screensaverMode = null; // null | 'foreground' | 'wallpaper'
let screensaverRestore = null;
let screensaverTimer = null;
let screensaverExtras = []; // 多屏锁屏时的副屏窗口列表
let macWallpaperWin = null; // macOS 真·桌面壁纸专用 desktop 层级窗口
let winAuthAvailable = false; // 系统是否已配置 Windows Hello / Touch ID
let verifyingUnlock = false;
let roamMode = false;
let roamMultiActive = false;
let roamRestore = null;
let roamTrialTimer = null;
let growthExpAccSec = 0;
let growthUpsellShownDate = '';
let tray = null;
let config = null;
let bridge = null;
const configPath = () => path.join(app.getPath('userData'), 'desk-config.json');

function loadConfig() {
  const freeSkins = catalog.freeSkins || ['goldfish'];
  const allSkinIds = (catalog.skins || []).map((s) => s.id);
  const defaults = {
    userId: `DO-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    userKey: crypto.randomBytes(24).toString('hex'),
    nickname: '桌边渔友',
    account: '',
    breed: freeSkins[0],
    allowRequests: true,
    cloud: true,
    size: 'standard',
    width: SIZES.standard,
    x: null,
    y: null,
    alwaysOnTop: true,
    opacity: 0.92,
    brightness: 0.55,
    roamFishRatio: 0.125,
    muted: false,
    autoLaunch: false,
    quality: 'high',
    theme: catalog.freeThemes[0],
    unlockedThemes: [...catalog.freeThemes],
    unlockedSkins: [...freeSkins],
    unlockedFeatures: [],
    previewedThemes: [],
    previewedSkins: [],
    previewedFeatures: [],
    screensaverTrialDate: '',
    roamTrialDate: '',
    roamTrialUsedSec: 0,
    featureTrials: {},
    autoScreensaver: false,
    screensaverIdleMinutes: 3,
    screensaverRequireAuth: true,
    screensaverPin: '',
    screensaverLockWin: false,
    multiScreen: true,
    growth: { enabled: true, exp: 0, feedCount: 0, days: 1, lastDay: '', lockSize: false },
    skipVersion: '',
    onboarded: false,
    named: false
  };
  let loaded = {};
  try { loaded = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
  const merged = { ...defaults, ...loaded };
  if (loaded.named === undefined && loaded.nickname && loaded.nickname !== '桌边渔友') merged.named = true;
  for (const key of ['userId', 'userKey']) if (!merged[key]) merged[key] = defaults[key];
  merged.unlockedThemes = Array.from(new Set([...catalog.freeThemes, ...(Array.isArray(loaded.unlockedThemes) ? loaded.unlockedThemes : [])]));
  merged.unlockedSkins = Array.from(new Set([...freeSkins, ...(Array.isArray(loaded.unlockedSkins) ? loaded.unlockedSkins : [])]));
  merged.unlockedFeatures = Array.from(new Set(Array.isArray(loaded.unlockedFeatures) ? loaded.unlockedFeatures : []));
  merged.previewedThemes = Array.from(new Set(Array.isArray(loaded.previewedThemes) ? loaded.previewedThemes : []));
  merged.previewedSkins = Array.from(new Set(Array.isArray(loaded.previewedSkins) ? loaded.previewedSkins : []));
  merged.previewedFeatures = Array.from(new Set(Array.isArray(loaded.previewedFeatures) ? loaded.previewedFeatures : []));
  if (!merged.unlockedThemes.includes(merged.theme)) merged.theme = catalog.freeThemes[0];
  if (!allSkinIds.includes(merged.breed) || !merged.unlockedSkins.includes(merged.breed)) merged.breed = freeSkins[0];
  return merged;
}
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
    } catch (error) {
      console.warn('config save failed', error);
    }
  }, 300);
}

function windowSize(width) {
  return { width: Math.round(width), height: Math.round(width * ASPECT) };
}

/* 鱼缸实体（含灯架与木底座）在透明窗口里的占比，由渲染进程按真实 3D 投影上报；上报前用经验值 */
let tankRect = { left: 0.14, right: 0.86, top: 0.21, bottom: 0.84 };
let tankRectReady = false;
const CORNER_GAP = 10; // 放回右下角时与屏幕右边缘留的缝

const isFill = () => config.size === 'fill';
const displayOf = (bounds) => screen.getDisplayMatching({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) });

/* 右下角：鱼缸木底座贴住任务栏上沿，右侧贴近屏幕边缘（扣除透明留白，而不是窗口外框） */
function defaultPosition(size, display = screen.getPrimaryDisplay()) {
  const area = display.workArea;
  return {
    x: Math.round(area.x + area.width - size.width * tankRect.right - CORNER_GAP),
    y: Math.round(area.y + area.height - size.height * tankRect.bottom)
  };
}

function clampToWorkArea(x, y, width, height) {
  // 使用显示器完整 bounds，并扣除画布四周透明留白，让鱼缸灯架可紧贴屏幕最顶端、木底座可紧贴屏幕最底端
  const area = displayOf({ x, y, width, height }).bounds;
  const minX = area.x - Math.round(width * tankRect.left);
  const maxX = Math.max(minX, area.x + area.width - Math.round(width * tankRect.right));
  const minY = area.y - Math.round(height * tankRect.top);
  const maxY = Math.max(minY, area.y + area.height - Math.round(height * tankRect.bottom));
  return {
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, minY), maxY))
  };
}

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false
});

function loadPage(target, page) {
  if (DEV_URL) target.loadURL(`${DEV_URL}/${page}.html`);
  else target.loadFile(path.join(__dirname, '..', 'dist', `${page}.html`));
  /* 应用内页面不允许跳转或弹新窗口，外链统一交给系统浏览器 */
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', (event) => event.preventDefault());
}

function createWindow() {
  let bounds;
  if (isFill()) {
    const anchor = config.restore?.x != null ? { x: config.restore.x, y: config.restore.y, width: 1, height: 1 } : screen.getPrimaryDisplay().bounds;
    bounds = displayOf(anchor).workArea;
  } else {
    const size = windowSize(config.width);
    const pos = config.x != null && config.y != null ? clampToWorkArea(config.x, config.y, size.width, size.height) : defaultPosition(size);
    bounds = { ...size, ...pos };
  }
  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    roundedCorners: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    backgroundColor: '#00000000',
    show: false,
    title: BRAND,
    webPreferences: { ...webPreferences(), backgroundThrottling: true }
  });
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.setOpacity(config.opacity);
  win.setIgnoreMouseEvents(true, { forward: true });
  loadPage(win, 'desktop');
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[desk] did-fail-load:', code, desc, url);
  });
  win.webContents.on('console-message', (_e, level, msg, line, source) => {
    if (level >= 2) console.error(`[desk:renderer:${level}] ${msg} (${source}:${line})`);
  });
  win.once('ready-to-show', () => {
    win.showInactive();
    if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
    pushConfig();
    bridge?.getInitialFriends().forEach((friend) => {
      win.webContents.send('desk:friend', { type: 'friend:add', friend });
    });
    const visiting = bridge?.getStore().visiting;
    if (visiting) win.webContents.send('desk:friend', { type: 'visit:self', visiting, breed: config.breed, initial: true });
  });
  win.on('closed', () => {
    win = null;
  });
  win.on('moved', () => {
    if (isFill() || roamMode || peeking || screensaverMode) return;
    const [x, y] = win.getPosition();
    config.x = x;
    config.y = y;
    saveConfig();
  });
}

/* Windows 上 resizable:false 的无边框透明窗口直接 setBounds 可能被系统拦截或裁剪，临时放开 resizable 再恢复 */
function setWindowBounds(target, bounds) {
  if (!target || target.isDestroyed()) return;
  const clean = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(100, Math.round(bounds.width)),
    height: Math.max(100, Math.round(bounds.height))
  };
  const wasResizable = target.isResizable();
  if (!wasResizable) target.setResizable(true);
  target.setBounds(clean);
  if (!wasResizable) target.setResizable(false);
}

const rendererConfig = () => ({
  muted: config.muted,
  quality: config.quality,
  size: config.size,
  brightness: Number(config.brightness) || 0.55,
  roamFishRatio: Number(config.roamFishRatio) || 0.125,
  theme: bridge?.getActiveTheme?.() || config.theme,
  skin: bridge?.getActiveSkin?.() || config.breed || 'goldfish',
  growth: bridge?.getGrowthStatus?.() || { enabled: false, active: false, level: 1, scaleMul: 1, aura: 0 },
  onboarded: Boolean(config.onboarded || !config.named)
});
function pushConfig() {
  const cfg = rendererConfig();
  if (win && !win.isDestroyed()) win.webContents.send('desk:config', cfg);
  if (macWallpaperWin && !macWallpaperWin.isDestroyed()) macWallpaperWin.webContents.send('desk:config', cfg);
}

function placeAt(bounds) {
  setWindowBounds(win, bounds);
  if (!isFill()) {
    config.x = Math.round(bounds.x);
    config.y = Math.round(bounds.y);
  }
  saveConfig();
}

/* 铺满屏幕：窗口覆盖当前屏幕的工作区（不挡任务栏），鱼缸在渲染端按屏幕比例放到最大；透明处照常点击穿透 */
function enterFill() {
  if (!win || isFill()) return;
  const b = win.getBounds();
  config.restore = { width: config.width, size: config.size, x: b.x, y: b.y };
  config.size = 'fill';
  placeAt(displayOf(b).workArea);
  pushConfig();
}

function exitFill(placeCorner = false) {
  if (!win || !isFill()) return;
  const restore = config.restore || {};
  const width = Number(restore.width) || SIZES.standard;
  const size = windowSize(width);
  const display = displayOf(win.getBounds());
  config.size = SIZES[restore.size] ? restore.size : 'custom';
  config.width = size.width;
  const pos = !placeCorner && restore.x != null ? clampToWorkArea(restore.x, restore.y, size.width, size.height) : defaultPosition(size, display);
  placeAt({ ...pos, ...size });
  pushConfig();
}

/* 通用功能水下气泡邀约（15 秒无操作渲染端自动轻盈消散） */
function sendFeatureUpsell(featureId, title) {
  const feat = (catalog.features || []).find((f) => f.id === featureId);
  const liveCents = bridge?.getStore()?.pricing?.features?.[featureId] ?? feat?.cents ?? 300;
  const friendlyMap = {
    roam: '小鱼逛累啦，想一直陪你逛桌面～',
    screensaver: '想让这片水景一直为你守屏吗？',
    wallpaper: '想让这片水景一直留在桌面壁纸吗？',
    multiscreen: '想让小鱼继续在多块屏幕间自由穿梭吗？',
    growth: '想陪小鱼继续长出璀璨光晕吗？'
  };
  win?.webContents.send('desk:upsell', {
    skuId: featureId,
    title: friendlyMap[featureId] || title || `喜欢「${feat?.name || '这项体验'}」吗？`,
    btnText: '解锁'
  });
}

function getDisplayUnion(useWorkArea = true) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of displays) {
    const r = useWorkArea ? d.workArea : d.bounds;
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  const union = {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.max(100, Math.round(maxX - minX)),
    height: Math.max(100, Math.round(maxY - minY))
  };
  return { displays, primary, union, count: displays.length };
}

function lockWindowsWorkstation() {
  if (process.platform === 'win32') {
    execFile('rundll32.exe', ['user32.dll,LockWorkStation'], () => {});
  } else if (process.platform === 'darwin') {
    execFile('pmset', ['displaysleepnow'], () => {});
  }
}

/* 桌面漫游模式：未解锁每日可体验 20 分钟（使用期间计时）；多显示器下自动支持跨屏游动（单独计费，同样每日体验 20 分钟） */
function enterRoam(dropPt, restoreBounds = null) {
  if (!win || roamMode || peeking) return;
  const rem = bridge ? bridge.getFeatureRemainingSec('roam') : Infinity;
  if (Number.isFinite(rem) && rem <= 0) {
    showCornerNotice({ kind: 'info', title: '今天不能漫游了欧！', body: '', duration: 3200 });
    sendFeatureUpsell('roam', '今日漫游 20 分钟已用完');
    return;
  }
  if (screensaverMode) exitScreensaver();
  roamMode = true;
  const old = restoreBounds || win.getBounds();
  const safeOld = { ...clampToWorkArea(old.x, old.y, old.width, old.height), width: old.width, height: old.height };
  roamRestore = { bounds: safeOld, opacity: config.opacity, alwaysOnTop: config.alwaysOnTop };
  const disp = screen.getDisplayNearestPoint(dropPt || { x: safeOld.x + safeOld.width / 2, y: safeOld.y + safeOld.height / 2 });
  const multi = getDisplayUnion(true);
  const msRem = bridge ? bridge.getFeatureRemainingSec('multiscreen') : Infinity;
  roamMultiActive = multi.count > 1 && config.multiScreen !== false && (!Number.isFinite(msRem) || msRem > 0);

  const area = roamMultiActive ? multi.union : disp.workArea;
  const singleScreenRatio = roamMultiActive ? (disp.workArea.width / Math.max(1, area.width)) : 1;
  const normX = dropPt ? Math.min(0.95, Math.max(0.05, (dropPt.x - area.x) / Math.max(1, area.width))) : 0.5;
  const normY = dropPt ? Math.min(0.9, Math.max(0.1, (dropPt.y - area.y) / Math.max(1, area.height))) : 0.5;
  setWindowBounds(win, area);
  win.setOpacity(config.opacity ?? 0.92);
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.showInactive();
  win.webContents.send('desk:roam', { active: true, startX: normX, startY: normY, singleScreenRatio, multiScreen: roamMultiActive });
  bridge?.updateTank({ roam: true });
  sendTo('menu', 'desk:menu-state', menuState());

  if (Number.isFinite(rem)) {
    const mins = Math.max(1, Math.ceil(rem / 60));
    showCornerNotice({ kind: 'info', title: roamMultiActive ? `🐟 小鱼正在 ${multi.count} 块屏幕漫游` : '🐟 小鱼出来逛桌面了', body: `今日剩 ${mins} 分钟 · 点小鱼回鱼缸`, duration: 3200 });
  } else {
    showCornerNotice({ kind: 'info', title: roamMultiActive ? `🐟 小鱼正在 ${multi.count} 块屏幕漫游` : '🐟 小鱼出来逛桌面了', body: '点小鱼变回鱼缸', duration: 3200 });
  }

  clearInterval(roamTrialTimer);
  roamTrialTimer = setInterval(() => {
    if (!roamMode) { clearInterval(roamTrialTimer); roamTrialTimer = null; return; }
    if (roamMultiActive && Number.isFinite(bridge?.getFeatureRemainingSec('multiscreen'))) {
      const msLeft = bridge.addFeatureUsageSec('multiscreen', 1);
      if (msLeft <= 0) {
        roamMultiActive = false;
        const primaryArea = screen.getPrimaryDisplay().workArea;
        setWindowBounds(win, primaryArea);
        win.webContents.send('desk:roam', { active: true, singleScreenRatio: 1, multiScreen: false });
        sendFeatureUpsell('multiscreen', '多屏畅游今日 20 分钟已用完');
        sendTo('menu', 'desk:menu-state', menuState());
      }
    }
    if (Number.isFinite(bridge?.getFeatureRemainingSec('roam'))) {
      const left = bridge.addFeatureUsageSec('roam', 1);
      if (left <= 0) {
        clearInterval(roamTrialTimer);
        roamTrialTimer = null;
        exitRoam();
        sendFeatureUpsell('roam', '今日 20 分钟漫游结束');
      }
    }
  }, 1000);
}

function exitRoam() {
  if (!roamMode) return;
  roamMode = false;
  roamMultiActive = false;
  clearInterval(roamTrialTimer);
  roamTrialTimer = null;
  if (win && !win.isDestroyed()) {
    const b = roamRestore?.bounds || { ...defaultPosition(windowSize(config.width)), ...windowSize(config.width) };
    const safe = clampToWorkArea(b.x, b.y, b.width, b.height);
    setWindowBounds(win, { x: safe.x, y: safe.y, width: b.width, height: b.height });
    win.setOpacity(roamRestore?.opacity ?? config.opacity);
    win.setAlwaysOnTop(roamRestore?.alwaysOnTop ?? config.alwaysOnTop, 'floating');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.send('desk:roam', { active: false });
  }
  roamRestore = null;
  bridge?.updateTank({ roam: false });
  sendTo('menu', 'desk:menu-state', menuState());
}

const toggleFill = () => { if (!peeking) startScreensaver('foreground'); };

function closeScreensaverExtras() {
  for (const w of screensaverExtras) {
    try { if (w && !w.isDestroyed()) w.close(); } catch {}
  }
  screensaverExtras = [];
}

function openScreensaverExtras(primaryDisp) {
  closeScreensaverExtras();
  const displays = screen.getAllDisplays().filter((d) => d.id !== primaryDisp.id);
  for (const d of displays) {
    const extra = new BrowserWindow({
      x: Math.round(d.bounds.x),
      y: Math.round(d.bounds.y),
      width: Math.round(d.bounds.width),
      height: Math.round(d.bounds.height),
      transparent: false,
      frame: false,
      resizable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#061b1e',
      show: false,
      title: BRAND,
      webPreferences: { ...webPreferences(), backgroundThrottling: false }
    });
    const pageUrl = DEV_URL
      ? `${DEV_URL}/desktop.html?mirror=1`
      : `file://${path.join(__dirname, '..', 'dist', 'desktop.html').replace(/\\/g, '/')}?mirror=1`;
    extra.loadURL(pageUrl);
    extra.once('ready-to-show', () => {
      if (!screensaverMode) { extra.close(); return; }
      extra.setAlwaysOnTop(true, 'screen-saver');
      extra.showInactive();
      extra.webContents.send('desk:config', rendererConfig());
      extra.webContents.send('desk:screensaver', { active: true, mode: 'foreground', mirror: true });
    });
    screensaverExtras.push(extra);
  }
}

/* 锁屏屏保 / 动态壁纸模式（每日免费体验 20 分钟，使用期间计时）：
   - mode='foreground'：锁屏式巨幕屏保（防鼠标误触退出，显示磨砂大时钟，支持滑动/点击或 4~6 位 PIN 密码解锁 + 可选同步 Windows 系统锁屏）
   - mode='wallpaper' ：真·桌面壁纸（嵌入所有桌面图标后方，持久存在不挡任何图标） */
async function enterScreensaver({ mode = 'foreground', autoLock = false } = {}) {
  if (!win || peeking) return;
  if (screensaverMode) await exitScreensaver();
  screensaverMode = mode;
  const b = win.getBounds();
  const disp = displayOf(b);
  screensaverRestore = { bounds: b, opacity: config.opacity, alwaysOnTop: config.alwaysOnTop };
  const featKey = mode === 'wallpaper' ? 'wallpaper' : 'screensaver';
  const ssRem = bridge ? bridge.getFeatureRemainingSec(featKey) : Infinity;
  const multi = getDisplayUnion(false);
  const msRem = bridge ? bridge.getFeatureRemainingSec('multiscreen') : Infinity;
  const useMultiLock = mode === 'foreground' && multi.count > 1 && config.multiScreen !== false && (!Number.isFinite(msRem) || msRem > 0);

  if (mode === 'wallpaper') {
    if (process.platform === 'darwin') {
      if (macWallpaperWin && !macWallpaperWin.isDestroyed()) {
        try { macWallpaperWin.close(); } catch {}
      }
      macWallpaperWin = new BrowserWindow({
        x: Math.round(disp.bounds.x),
        y: Math.round(disp.bounds.y),
        width: Math.round(disp.bounds.width),
        height: Math.round(disp.bounds.height),
        type: 'desktop',
        transparent: false,
        frame: false,
        resizable: false,
        hasShadow: false,
        focusable: false,
        skipTaskbar: true,
        enableLargerThanScreen: true,
        backgroundColor: '#061b1e',
        show: false,
        title: BRAND,
        webPreferences: { ...webPreferences(), backgroundThrottling: false }
      });
      macWallpaperWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      macWallpaperWin.setIgnoreMouseEvents(true);
      const pageUrl = DEV_URL
        ? `${DEV_URL}/desktop.html?mirror=1`
        : `file://${path.join(__dirname, '..', 'dist', 'desktop.html').replace(/\\/g, '/')}?mirror=1`;
      macWallpaperWin.loadURL(pageUrl);
      macWallpaperWin.once('ready-to-show', () => {
        if (screensaverMode !== 'wallpaper' || !macWallpaperWin || macWallpaperWin.isDestroyed()) return;
        macWallpaperWin.showInactive();
        macWallpaperWin.webContents.send('desk:config', rendererConfig());
        macWallpaperWin.webContents.send('desk:screensaver', { active: true, mode: 'wallpaper', mirror: true });
      });
      win.hide();
    } else {
      win.setAlwaysOnTop(false);
      win.setOpacity(1);
      win.setFocusable(false);
      win.setIgnoreMouseEvents(true, { forward: true });
      setWindowBounds(win, disp.bounds);
      win.showInactive();
      const scale = disp.scaleFactor || 1;
      await attachWallpaper(win, {
        x: 0,
        y: 0,
        width: Math.round(disp.bounds.width * scale),
        height: Math.round(disp.bounds.height * scale)
      });
    }
    if (!Number.isFinite(ssRem)) {
      config.wallpaperPersistent = true;
      saveConfig();
    }
  } else {
    win.setFocusable(true);
    setWindowBounds(win, disp.bounds);
    win.setOpacity(1);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(false);
    win.show();
    win.focus();
    if (useMultiLock) openScreensaverExtras(disp);
  }

  const useWinAuth = winAuthAvailable && config.screensaverRequireAuth !== false;
  const isPaidScreensaver = Boolean(bridge && !Number.isFinite(ssRem));
  win.webContents.send('desk:screensaver', {
    active: true,
    mode,
    lockMode: mode === 'foreground',
    autoLock: Boolean(autoLock),
    isPaidScreensaver,
    authMode: useWinAuth ? 'windows' : 'none',
    remainingSec: Number.isFinite(ssRem) ? ssRem : null
  });
  sendTo('menu', 'desk:menu-state', menuState());

  clearInterval(screensaverTimer);
  screensaverTimer = setInterval(() => {
    if (!screensaverMode) { clearInterval(screensaverTimer); screensaverTimer = null; return; }
    if (screensaverExtras.length > 0 && Number.isFinite(bridge?.getFeatureRemainingSec('multiscreen'))) {
      const msLeft = bridge.addFeatureUsageSec('multiscreen', 1);
      if (msLeft <= 0) {
        closeScreensaverExtras();
        sendFeatureUpsell('multiscreen', '多屏锁屏今日 20 分钟体验已用完');
        sendTo('menu', 'desk:menu-state', menuState());
      }
    }
    if (Number.isFinite(bridge?.getFeatureRemainingSec(featKey))) {
      const left = bridge.addFeatureUsageSec(featKey, 1);
      if (left <= 0) {
        clearInterval(screensaverTimer);
        screensaverTimer = null;
        exitScreensaver();
        sendFeatureUpsell(featKey, featKey === 'wallpaper' ? '动态壁纸今日 20 分钟体验已用完' : '锁屏屏保今日 20 分钟体验已用完');
      }
    }
  }, 1000);
}

async function exitScreensaver({ triggerWinLock = false } = {}) {
  if (!screensaverMode) return;
  const wasWallpaper = screensaverMode === 'wallpaper';
  const wasForeground = screensaverMode === 'foreground';
  screensaverMode = null;
  clearInterval(screensaverTimer);
  screensaverTimer = null;
  closeScreensaverExtras();
  if (macWallpaperWin && !macWallpaperWin.isDestroyed()) {
    try { macWallpaperWin.close(); } catch {}
  }
  macWallpaperWin = null;
  if (config.wallpaperPersistent) {
    config.wallpaperPersistent = false;
    saveConfig();
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('desk:screensaver', { active: false });
    if (wasWallpaper && process.platform === 'win32') await detachWallpaper(win);
    win.setFocusable(true);
    if (screensaverRestore) {
      setWindowBounds(win, screensaverRestore.bounds);
      win.setOpacity(screensaverRestore.opacity);
      win.setAlwaysOnTop(screensaverRestore.alwaysOnTop, 'floating');
    }
    win.setIgnoreMouseEvents(true, { forward: true });
    win.showInactive();
  }
  screensaverRestore = null;
  sendTo('menu', 'desk:menu-state', menuState());
  if (wasForeground && (triggerWinLock || config.screensaverLockWin)) {
    lockWindowsWorkstation();
  }
}

function startScreensaver(mode = 'foreground') {
  if (screensaverMode && screensaverMode === mode) {
    exitScreensaver();
    return { ok: true, exited: true };
  }
  if (peeking) {
    showCornerNotice({ kind: 'info', title: '请先退出观光', body: '', duration: 2800 });
    return { ok: false, message: '请先退出观光' };
  }
  const featKey = mode === 'wallpaper' ? 'wallpaper' : 'screensaver';
  const res = bridge?.claimFeaturePreview(featKey);
  if (!res?.ok) {
    const msg = featKey === 'wallpaper' ? '动态壁纸今日 20 分钟已用完' : '锁屏屏保今日 20 分钟已用完';
    showCornerNotice({ kind: 'info', title: msg, body: '', duration: 3200 });
    sendFeatureUpsell(featKey, msg);
    return res || { ok: false, message: '今日体验已用完' };
  }
  if (roamMode) exitRoam();
  enterScreensaver({ mode });
  return res;
}

function placeCorner() {
  if (!win || peeking) return;
  if (isFill()) return exitFill(true);
  const b = win.getBounds();
  placeAt({ ...defaultPosition(b, displayOf(b)), width: b.width, height: b.height });
}

function setWidth(width, key = 'custom') {
  if (peeking) return;
  if (isFill()) exitFill();
  const old = win.getBounds();
  const size = windowSize(width);
  // 以底边中点为锚缩放，并始终限制在屏幕工作区内不超出边界
  const rawX = old.x + old.width / 2 - size.width / 2;
  const rawY = old.y + old.height - size.height;
  const { x, y } = clampToWorkArea(rawX, rawY, size.width, size.height);
  setWindowBounds(win, { x, y, ...size });
  config.width = size.width;
  config.size = key;
  config.x = x;
  config.y = y;
  saveConfig();
  pushConfig();
}

function toggleVisible(force) {
  if (!win || forceUpgradeLocked) return;
  if (screensaverMode === 'wallpaper') {
    openCustomMenu(); // 壁纸模式持久常驻，不隐藏，点托盘直接弹出菜单供退出
    return;
  }
  const show = force ?? !win.isVisible();
  if (show) win.showInactive();
  else win.hide();
}

function buildMenu() {
  const sizeItems = Object.keys(SIZES).map((key) => ({
    label: `${SIZE_LABEL[key]}`,
    type: 'radio',
    checked: config.size === key,
    click: () => setWidth(SIZES[key], key)
  }));
  sizeItems.push({ type: 'separator' });
  sizeItems.push({ label: '大一点', accelerator: 'Plus', click: () => setWidth(Math.min(900, config.width * 1.1)) });
  sizeItems.push({ label: '小一点', accelerator: 'Minus', click: () => setWidth(Math.max(200, config.width / 1.1)) });
  sizeItems.push({ type: 'separator' });
  sizeItems.push({ label: '铺满屏幕（双击鱼缸切换）', type: 'radio', checked: isFill(), click: () => enterFill() });

  const opacityItems = [1, 0.85, 0.7, 0.5].map((value) => ({
    label: `${Math.round(value * 100)}%`,
    type: 'radio',
    checked: Math.abs(config.opacity - value) < 0.01,
    click: () => {
      config.opacity = value;
      win.setOpacity(value);
      saveConfig();
    }
  }));

  const themeItems = catalog.themes.map((t) => {
    const unlocked = config.unlockedThemes.includes(t.id);
    return {
      label: unlocked ? `${t.emoji} ${t.name}` : `${t.emoji} ${t.name} · 试看 ${catalog.previewSeconds} 秒`,
      type: 'radio',
      checked: config.theme === t.id,
      click: () => (unlocked ? bridge?.applyTheme(t.id) : bridge?.previewTheme(t.id))
    };
  });
  const hasLocked = catalog.themes.some((t) => !config.unlockedThemes.includes(t.id));
  themeItems.push({ type: 'separator' });
  themeItems.push({
    label: hasLocked ? `解锁更多造景（单套 ¥${catalog.yuan(catalog.paidThemes[0].cents)} · 全套 ¥${catalog.yuan(catalog.bundle.cents)}）…` : '造景商城…',
    click: () => openDialog('store')
  });

  return Menu.buildFromTemplate([
    { label: '喂鱼', click: () => win.webContents.send('desk:action', 'feed') },
    { label: '擦玻璃', click: () => win.webContents.send('desk:action', 'clean') },
    { label: '开灯 / 关灯', click: () => win.webContents.send('desk:action', 'light') },
    { label: '生态造景', submenu: themeItems },
    { type: 'separator' },
    { label: isFill() ? '还原窗口大小' : '铺满屏幕', click: () => toggleFill() },
    { label: '大小', submenu: sizeItems },
    { label: '透明度', submenu: opacityItems },
    {
      label: '画质',
      submenu: [
        { label: '精致', type: 'radio', checked: config.quality === 'high', click: () => { config.quality = 'high'; saveConfig(); pushConfig(); } },
        { label: '省电', type: 'radio', checked: config.quality === 'low', click: () => { config.quality = 'low'; saveConfig(); pushConfig(); } }
      ]
    },
    {
      label: '总在最前',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => {
        config.alwaysOnTop = item.checked;
        win.setAlwaysOnTop(item.checked, 'floating');
        saveConfig();
      }
    },
    {
      label: '声音',
      type: 'checkbox',
      checked: !config.muted,
      click: (item) => {
        config.muted = !item.checked;
        saveConfig();
        pushConfig();
      }
    },
    {
      label: '开机自动摆上桌',
      type: 'checkbox',
      checked: config.autoLaunch,
      click: (item) => {
        config.autoLaunch = item.checked;
        app.setLoginItemSettings({ openAtLogin: item.checked });
        saveConfig();
      }
    },
    { type: 'separator' },
    { label: '造景商城 · 鱼友 · 账号', click: () => openDialog('store') },
    { label: '配对手机', click: () => openDialog('pair') },
    { label: '意见反馈', click: () => openDialog('feedback') },
    { label: `检查更新（当前 v${app.getVersion()}）`, click: () => runUpdateCheck(true) },
    { label: '放回右下角', click: () => placeCorner() },
    { label: `收起（${process.platform === 'darwin' ? '⌘' : 'Ctrl'}+Alt+M）`, click: () => toggleVisible(false) },
    { label: '退出', click: () => app.quit() }
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'public', 'icons', 'icon-192.png');
  let image = nativeImage.createFromPath(iconPath);
  const traySize = process.platform === 'darwin' ? 18 : 16;
  if (!image.isEmpty()) image = image.resize({ width: traySize, height: traySize });
  tray = new Tray(image);
  tray.setToolTip(`${BRAND} · ${catalog.brand.en}`);
  tray.on('click', () => (process.platform === 'darwin' ? openCustomMenu() : toggleVisible()));
  tray.on('right-click', () => openCustomMenu());
}

/* ---------- 小窗（配对 / 反馈 / 升级 / 商城 / 通知 / 欢迎起名 / 自定义右键菜单） ---------- */
const DIALOG_SIZE = {
  pair: { width: 310, height: 420 },
  feedback: { width: 330, height: 370 },
  update: { width: 350, height: 320 },
  store: { width: 472, height: 650 },
  upgrade: { width: 720, height: 520 },
  console: { width: 820, height: 560 },
  welcome: { width: 400, height: 430 },
  menu: { width: 214, height: 336 }
};

let menuFlipLeft = false;
let menuAnchor = { x: 100, y: 100, right: 314, mainW: 214, fullW: 214, maxW: 214, height: 336 };
function menuState(extra = {}) {
  const st = bridge?.getStore();
  const feat = (catalog.features || []).find((f) => f.id === 'screensaver');
  const ssCents = st?.pricing?.features?.screensaver ?? feat?.cents ?? 100;
  return {
    ...extra,
    userId: config.userId,
    nickname: config.nickname,
    account: config.account || '',
    allowRequests: config.allowRequests !== false,
    cloud: config.cloud !== false,
    profile: st?.profile || { userId: config.userId, nickname: config.nickname, account: config.account || '', breed: config.breed || 'goldfish', allowRequests: config.allowRequests !== false },
    feedbacks: st?.feedbacks || [],
    version: app.getVersion(),
    bossKey: `${process.platform === 'darwin' ? '⌘' : 'Ctrl'}+Alt+M`,
    flipLeft: menuFlipLeft,
    theme: config.theme,
    skin: config.breed || 'goldfish',
    unlockedThemes: config.unlockedThemes,
    unlockedSkins: config.unlockedSkins || [...(catalog.freeSkins || ['goldfish'])],
    previewedThemes: config.previewedThemes || [],
    previewedSkins: config.previewedSkins || [],
    unlockedFeatures: config.unlockedFeatures || [],
    previewedFeatures: config.previewedFeatures || [],
    screensaverTrialDate: config.screensaverTrialDate || '',
    roamRemainingSec: bridge ? bridge.getFeatureRemainingSec('roam') : Infinity,
    featureRemaining: bridge ? bridge.getAllFeatureRemaining() : {},
    displayCount: screen.getAllDisplays().length,
    multiScreen: config.multiScreen !== false,
    screensaverMode,
    roamMode,
    peeking,
    autoScreensaver: Boolean(config.autoScreensaver),
    screensaverIdleMinutes: Math.max(1, Number(config.screensaverIdleMinutes) || 3),
    winAuthAvailable,
    screensaverRequireAuth: config.screensaverRequireAuth !== false,
    hasScreensaverPin: Boolean(config.screensaverPin),
    screensaverLockWin: Boolean(config.screensaverLockWin),
    growth: bridge ? bridge.getGrowthStatus() : { enabled: true, active: true, level: 1, stageName: '幼苗', exp: 0, days: 1, feedCount: 0, lockSize: false, scaleMul: 1, aura: 0 },
    screensaverPrice: catalog.yuan(ssCents),
    pricing: st?.pricing || null,
    friends: st?.friends || [],
    visitors: st?.visitors || [],
    visiting: st?.visiting || null,
    requests: st?.requests || [],
    messages: st?.messages || [],
    themes: catalog.themes,
    skins: catalog.skins || [],
    size: config.size,
    opacity: config.opacity ?? 0.92,
    brightness: config.brightness ?? 0.55,
    roamFishRatio: config.roamFishRatio ?? 0.125,
    alwaysOnTop: config.alwaysOnTop,
    muted: config.muted,
    quality: config.quality,
    autoLaunch: config.autoLaunch
  };
}

function applyMenuBounds(widthOrSub = false) {
  const target = dialogs.menu;
  if (!target || target.isDestroyed()) return;
  const width = typeof widthOrSub === 'number'
    ? Math.max(menuAnchor.mainW, Math.min(menuAnchor.maxW, Math.round(widthOrSub)))
    : (widthOrSub ? menuAnchor.fullW : menuAnchor.mainW);
  const area = screen.getDisplayNearestPoint({ x: menuAnchor.x, y: menuAnchor.y }).workArea;
  const rawX = menuFlipLeft ? (menuAnchor.right - width) : menuAnchor.x;
  const x = Math.round(Math.min(Math.max(rawX, area.x + 6), area.x + area.width - width - 6));
  setWindowBounds(target, { x, y: Math.round(menuAnchor.y), width, height: menuAnchor.height });
}

function openCustomMenu() {
  const pt = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(pt).workArea;
  const width = DIALOG_SIZE.menu.width;
  const height = DIALOG_SIZE.menu.height;
  const x = Math.round(Math.min(Math.max(pt.x + 6, area.x + 6), area.x + area.width - width - 6));
  const y = Math.round(Math.min(Math.max(pt.y - 12, area.y + 6), area.y + area.height - height - 6));
  menuAnchor = { x, y, right: x + width, mainW: width, fullW: width, maxW: width, height };
  const existing = dialogs.menu;
  if (existing && !existing.isDestroyed()) {
    setWindowBounds(existing, { x, y, width, height });
    existing.show();
    existing.focus();
    sendTo('menu', 'desk:menu-state', menuState({ resetSub: true }));
    return existing;
  }
  const target = openDialog('menu', { x, y, width, height, skipTaskbar: true, show: false });
  target.once('ready-to-show', () => {
    setWindowBounds(target, { x, y, width, height });
    target.show();
    target.focus();
    target.setAlwaysOnTop(true, 'pop-up-menu');
    sendTo('menu', 'desk:menu-state', menuState({ resetSub: true }));
  });
  target.on('blur', () => {
    if (!target.isDestroyed()) target.hide();
  });
  return target;
}

function openDialog(name, options = {}) {
  const existing = dialogs[name];
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const target = new BrowserWindow({
    ...DIALOG_SIZE[name],
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    title: BRAND,
    webPreferences: webPreferences(),
    ...options
  });
  dialogs[name] = target;
  loadPage(target, name);
  target.on('closed', () => {
    dialogs[name] = null;
    if (name === 'update' && forceUpgradeLocked) app.quit();
  });
  return target;
}
const sendTo = (name, channel, payload) => {
  const target = dialogs[name];
  if (target && !target.isDestroyed()) target.webContents.send(channel, payload);
  if (name === 'menu') {
    const con = dialogs.console;
    if (con && !con.isDestroyed()) con.webContents.send(channel, payload);
  }
};

/* ---------- 渲染进程通信 ---------- */
ipcMain.on('desk:hit', (_event, inside) => {
  if (screensaverMode === 'foreground') {
    win?.setIgnoreMouseEvents(false);
    return;
  }
  win?.setIgnoreMouseEvents(!inside, { forward: true });
});
ipcMain.on('desk:menu', () => {
  openCustomMenu();
});
ipcMain.on('desk:open-console', (_event, tab) => {
  if (dialogs.menu && !dialogs.menu.isDestroyed()) dialogs.menu.hide();
  const target = openDialog('console');
  const t = String(tab || 'look');
  if (target.webContents.isLoading()) {
    target.webContents.once('did-finish-load', () => {
      sendTo('console', 'desk:menu-state', menuState());
      sendTo('console', 'desk:console-tab', t);
    });
  } else {
    sendTo('console', 'desk:menu-state', menuState());
    sendTo('console', 'desk:console-tab', t);
  }
});
ipcMain.on('desk:open-upgrade', (_event, skuId) => {
  if (dialogs.menu && !dialogs.menu.isDestroyed()) dialogs.menu.hide();
  pendingUpgradeTarget = { skuId: skuId ? String(skuId) : null };
  const target = openDialog('upgrade');
  if (target.webContents.isLoading()) {
    target.webContents.once('did-finish-load', () => sendTo('upgrade', 'desk:upgrade-target', pendingUpgradeTarget));
  } else {
    sendTo('upgrade', 'desk:upgrade-target', pendingUpgradeTarget);
  }
});
ipcMain.handle('desk:upgrade-target', () => pendingUpgradeTarget);
ipcMain.on('desk:set-upgrade-width', (_event, width) => {
  const target = dialogs.upgrade;
  if (!target || target.isDestroyed()) return;
  const w = Math.max(720, Math.min(1020, Math.round(Number(width) || 720)));
  const b = target.getBounds();
  if (b.width === w) return;
  const cx = b.x + Math.round(b.width / 2);
  const area = displayOf(b).workArea;
  const nx = Math.round(Math.min(Math.max(cx - Math.round(w / 2), area.x + 8), area.x + area.width - w - 8));
  setWindowBounds(target, { x: nx, y: b.y, width: w, height: b.height });
});
ipcMain.on('desk:menu-sub', (_event, open) => {
  applyMenuBounds(Boolean(open));
});
ipcMain.on('desk:menu-width', (_event, width) => {
  applyMenuBounds(Number(width) || menuAnchor.mainW);
});
ipcMain.handle('desk:menu-state', () => menuState());
ipcMain.on('desk:menu-exec', (_event, cmd, value) => {
  const hideMenu = () => { if (dialogs.menu && !dialogs.menu.isDestroyed()) dialogs.menu.hide(); };
  if (cmd === 'action:feed') {
    win?.webContents.send('desk:action', 'feed');
    bridge?.addGrowthExp?.(12, { isFeed: true });
    pushConfig();
    hideMenu();
  }
  else if (cmd === 'action:clean') { win?.webContents.send('desk:action', 'clean'); hideMenu(); }
  else if (cmd === 'action:light') { win?.webContents.send('desk:action', 'light'); hideMenu(); }
  else if (cmd === 'screensaver' || cmd === 'toggle-fill') { hideMenu(); startScreensaver('foreground'); }
  else if (cmd === 'wallpaper') { hideMenu(); startScreensaver('wallpaper'); }
  else if (cmd === 'roam') { hideMenu(); if (roamMode) exitRoam(); else enterRoam(); }
  else if (cmd === 'corner') { if (roamMode) exitRoam(); placeCorner(); hideMenu(); }
  else if (cmd === 'hide') { hideMenu(); toggleVisible(false); }
  else if (cmd === 'quit') { app.quit(); }
  else if (cmd === 'check-update') { hideMenu(); runUpdateCheck(true); }
  else if (cmd?.startsWith('open:')) {
    hideMenu();
    const raw = cmd.slice(5);
    const [dlg, tab] = raw.split(':');
    const w = openDialog(dlg);
    if (tab) {
      if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => sendTo(dlg, 'desk:store-tab', tab));
      else sendTo(dlg, 'desk:store-tab', tab);
    }
  }
  else if (cmd === 'theme') {
    const id = String(value || '');
    if (config.unlockedThemes.includes(id)) bridge?.applyTheme(id);
    else {
      const r = bridge?.previewTheme(id);
      const t = catalog.themes.find((x) => x.id === id);
      if (r?.ok) {
        if (t) showCornerNotice({ kind: 'info', title: `试看「${t.name}」`, body: `${catalog.previewSeconds} 秒后恢复`, duration: 3000 });
      } else {
        showCornerNotice({ kind: 'info', title: '已试看过', body: '点「单买」或 PRO 解锁', duration: 3200 });
        return;
      }
    }
    sendTo('menu', 'desk:menu-state', menuState());
  } else if (cmd === 'skin') {
    const id = String(value || '');
    const unlockedSkins = config.unlockedSkins || [...(catalog.freeSkins || ['goldfish'])];
    if (unlockedSkins.includes(id)) bridge?.applySkin(id);
    else {
      const r = bridge?.previewSkin(id);
      const s = (catalog.skins || []).find((x) => x.id === id);
      if (r?.ok) {
        if (s) showCornerNotice({ kind: 'info', title: `试穿「${s.name}」`, body: `${catalog.previewSeconds} 秒后恢复`, duration: 3000 });
      } else {
        showCornerNotice({ kind: 'info', title: '已试穿过', body: '点「单买」或 PRO 解锁', duration: 3200 });
        return;
      }
    }
    sendTo('menu', 'desk:menu-state', menuState());
  } else if (cmd === 'size' && SIZES[value]) {
    if (peeking) { showCornerNotice({ kind: 'info', title: '观光中不可调整', body: '', duration: 2600 }); return; }
    setWidth(SIZES[value], value);
    sendTo('menu', 'desk:menu-state', menuState());
  } else if (cmd === 'opacity') {
    const v = Number(value);
    if (v >= 0.3 && v <= 1) {
      config.opacity = Math.round(v * 100) / 100;
      win?.setOpacity(config.opacity);
      saveConfig();
    }
  } else if (cmd === 'brightness') {
    const v = Number(value);
    if (v >= 0.2 && v <= 1) {
      config.brightness = Math.round(v * 100) / 100;
      saveConfig();
      pushConfig();
    }
  } else if (cmd === 'roam-scale') {
    const v = Number(value);
    if (Number.isFinite(v)) {
      config.roamFishRatio = Math.min(0.5, Math.max(1 / 16, v));
      saveConfig();
      pushConfig();
    }
  } else if (cmd === 'toggle') {
    if (value === 'alwaysOnTop') { config.alwaysOnTop = !config.alwaysOnTop; win?.setAlwaysOnTop(config.alwaysOnTop, 'floating'); }
    else if (value === 'sound') { config.muted = !config.muted; }
    else if (value === 'powerSave') { config.quality = config.quality === 'low' ? 'high' : 'low'; }
    else if (value === 'autoLaunch') { config.autoLaunch = !config.autoLaunch; app.setLoginItemSettings({ openAtLogin: config.autoLaunch }); }
    else if (value === 'multiScreen') {
      const next = config.multiScreen === false;
      if (next && bridge && Number.isFinite(bridge.getFeatureRemainingSec('multiscreen')) && bridge.getFeatureRemainingSec('multiscreen') <= 0) {
        showCornerNotice({ kind: 'info', title: '多屏畅游今日 20 分钟已用完', body: '', duration: 3000 });
        sendFeatureUpsell('multiscreen', '多屏畅游今日 20 分钟已用完');
        return;
      }
      config.multiScreen = next;
    }
    saveConfig();
    pushConfig();
    sendTo('menu', 'desk:menu-state', menuState());
  }
});
let dragFrom = null;
ipcMain.on('desk:drag-start', () => {
  if (isFill() || peeking || roamMode) return; // 铺满、观光或漫游小鱼时不拖动
  const pt = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragFrom = { mouseX: pt.x, mouseY: pt.y, x: b.x, y: b.y, width: b.width, height: b.height, lastX: pt.x, lastY: pt.y, hitEdge: false };
});
ipcMain.on('desk:drag-move', () => {
  if (!dragFrom) return;
  const pt = screen.getCursorScreenPoint();
  dragFrom.lastX = pt.x;
  dragFrom.lastY = pt.y;
  const disp = screen.getDisplayNearestPoint(pt).bounds;
  const rawX = dragFrom.x + pt.x - dragFrom.mouseX;
  const rawY = dragFrom.y + pt.y - dragFrom.mouseY;
  const pos = clampToWorkArea(rawX, rawY, dragFrom.width, dragFrom.height);
  const pushedPastEdge = (
    rawX < pos.x - 42 ||
    rawX > pos.x + 42 ||
    rawY < pos.y - 42
  );
  dragFrom.hitEdge = (
    pushedPastEdge ||
    pt.x <= disp.x + 14 ||
    pt.x >= disp.x + disp.width - 14 ||
    pt.y <= disp.y + 14
  );
  win.setPosition(pos.x, pos.y);
});
ipcMain.on('desk:drag-end', () => {
  if (!dragFrom) return;
  const { hitEdge, x: startWinX, y: startWinY, width: startW, height: startH } = dragFrom;
  const pt = screen.getCursorScreenPoint();
  dragFrom = null;
  /* 拖到屏幕边缘释放时：化作小鱼在桌面工作区自由游动，并记住拖前安全位置 */
  if (hitEdge) {
    enterRoam(pt, { x: startWinX, y: startWinY, width: startW, height: startH });
    return;
  }
  // 靠近任务栏上沿、屏幕最底边或左右边缘时轻柔吸附
  const b = win.getBounds();
  const disp = displayOf(b);
  const bottomPad = Math.round(b.height * (1 - tankRect.bottom));
  const workSnapY = disp.workArea.y + disp.workArea.height - b.height + bottomPad;
  const screenSnapY = disp.bounds.y + disp.bounds.height - b.height + bottomPad;
  const rightSnapX = disp.workArea.x + disp.workArea.width - Math.round(b.width * tankRect.right) - CORNER_GAP;
  const leftSnapX = disp.workArea.x - Math.round(b.width * tankRect.left) + CORNER_GAP;
  let targetY = b.y;
  let targetX = b.x;
  if (Math.abs(b.y - screenSnapY) < 28) targetY = screenSnapY;
  else if (Math.abs(b.y - workSnapY) < 28) targetY = workSnapY;
  if (Math.abs(b.x - rightSnapX) < 28) targetX = rightSnapX;
  else if (Math.abs(b.x - leftSnapX) < 28) targetX = leftSnapX;
  const pos = clampToWorkArea(targetX, targetY, b.width, b.height);
  win.setPosition(pos.x, pos.y);
});
ipcMain.on('desk:tank-rect', (_event, rect) => {
  const ok = rect && ['left', 'right', 'top', 'bottom'].every((k) => Number.isFinite(rect[k]) && rect[k] >= -0.5 && rect[k] <= 1.5);
  if (!ok || rect.right - rect.left < 0.1 || rect.bottom - rect.top < 0.1) return;
  if (isFill()) return; // 铺满时比例不同，不覆盖常规窗口的留白比例
  tankRect = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  if (!tankRectReady) {
    tankRectReady = true;
    /* 首次启动没有保存过位置：拿到真实比例后精确放到右下角 */
    if (config.x == null || config.y == null) placeCorner();
  }
});
ipcMain.on('desk:toggle-fill', () => {
  if (screensaverMode === 'foreground') return;
  startScreensaver('foreground');
});
ipcMain.handle('desk:start-screensaver', (_event, mode) => startScreensaver(mode === 'wallpaper' ? 'wallpaper' : 'foreground'));
ipcMain.on('desk:exit-screensaver', (_event, opts) => exitScreensaver(opts || {}));
ipcMain.handle('desk:verify-unlock', async () => {
  if (!screensaverMode) return { ok: true };
  if (verifyingUnlock) return { ok: false, busy: true };
  if (!winAuthAvailable || config.screensaverRequireAuth === false) {
    await exitScreensaver();
    return { ok: true };
  }
  verifyingUnlock = true;
  try {
    // 临时让出 screen-saver 层级，确保 Windows Hello 原生 PIN / 指纹弹窗完整呈现在最前端
    win?.setAlwaysOnTop(false);
    for (const ex of screensaverExtras) { try { ex?.setAlwaysOnTop(false); } catch {} }
    const authPrompt = process.platform === 'darwin'
      ? '验证触控 ID 以解锁桌面生态'
      : '桌面生态 · 验证 Windows PIN 或指纹以解锁';
    const res = await verifyWindowsAuth(authPrompt);
    if (res?.ok) {
      await exitScreensaver();
      return { ok: true };
    }
    if (screensaverMode === 'foreground') {
      win?.setAlwaysOnTop(true, 'screen-saver');
      win?.focus();
      for (const ex of screensaverExtras) { try { ex?.setAlwaysOnTop(true, 'screen-saver'); } catch {} }
    }
    return { ok: false, canceled: Boolean(res?.canceled), message: res?.message || '验证未通过' };
  } finally {
    verifyingUnlock = false;
  }
});
ipcMain.on('desk:lock-windows', () => lockWindowsWorkstation());
ipcMain.on('desk:roam-exit', () => exitRoam());
ipcMain.on('desk:record-feed', () => {
  bridge?.addGrowthExp?.(12, { isFeed: true });
  pushConfig();
});
ipcMain.handle('desk:set-auto-screensaver', (_event, on) => {
  if (on && (!bridge || Number.isFinite(bridge.getFeatureRemainingSec('screensaver')))) {
    return { ok: false, message: '自定义自动锁屏需解锁锁屏屏保后使用' };
  }
  config.autoScreensaver = Boolean(on);
  saveConfig();
  sendTo('menu', 'desk:menu-state', menuState());
  return { ok: true, autoScreensaver: config.autoScreensaver };
});
ipcMain.handle('desk:set-screensaver-config', (_event, patch = {}) => {
  const paidSS = Boolean(bridge && !Number.isFinite(bridge.getFeatureRemainingSec('screensaver')));
  if (patch.autoScreensaver !== undefined && (!patch.autoScreensaver || paidSS)) {
    config.autoScreensaver = Boolean(patch.autoScreensaver);
  }
  if (patch.idleMinutes !== undefined && paidSS) {
    const mins = Math.max(1, Math.round(Number(patch.idleMinutes) || 1));
    config.screensaverIdleMinutes = mins;
  }
  if (patch.requireAuth !== undefined) config.screensaverRequireAuth = Boolean(patch.requireAuth);
  if (patch.pin !== undefined) {
    const clean = String(patch.pin || '').replace(/\D/g, '').slice(0, 6);
    config.screensaverPin = clean.length >= 4 ? clean : '';
  }
  if (patch.lockWin !== undefined) config.screensaverLockWin = Boolean(patch.lockWin);
  saveConfig();
  sendTo('menu', 'desk:menu-state', menuState());
  return {
    ok: true,
    autoScreensaver: config.autoScreensaver,
    screensaverIdleMinutes: config.screensaverIdleMinutes,
    winAuthAvailable,
    screensaverRequireAuth: config.screensaverRequireAuth !== false,
    hasScreensaverPin: Boolean(config.screensaverPin),
    screensaverLockWin: Boolean(config.screensaverLockWin)
  };
});
ipcMain.handle('desk:set-growth-config', (_event, patch = {}) => {
  if (!config.growth || typeof config.growth !== 'object') {
    config.growth = { enabled: true, exp: 0, feedCount: 0, days: 1, lastDay: '', lockSize: false };
  }
  if (patch.enabled !== undefined) {
    if (patch.enabled && bridge && Number.isFinite(bridge.getFeatureRemainingSec('growth')) && bridge.getFeatureRemainingSec('growth') <= 0) {
      sendFeatureUpsell('growth', '主鱼轻成长今日 20 分钟体验已用完');
      return { ok: false, message: '主鱼轻成长今日 20 分钟体验已用完' };
    }
    config.growth.enabled = Boolean(patch.enabled);
  }
  if (patch.lockSize !== undefined) config.growth.lockSize = Boolean(patch.lockSize);
  saveConfig();
  pushConfig();
  sendTo('menu', 'desk:menu-state', menuState());
  return { ok: true, growth: bridge?.getGrowthStatus?.() };
});
ipcMain.on('desk:zoom-by', (_event, factor) => {
  if (peeking) return;
  const f = Number(factor);
  if (!Number.isFinite(f) || f <= 0) return;
  if (roamMode) {
    config.roamFishRatio = Math.min(0.5, Math.max(1 / 16, (config.roamFishRatio || 0.125) * f));
    saveConfig();
    pushConfig();
    sendTo('menu', 'desk:menu-state', menuState());
    return;
  }
  setWidth(Math.min(900, Math.max(200, config.width * f)));
});
ipcMain.on('desk:onboard-done', () => {
  config.onboarded = true;
  saveConfig();
  pushConfig();
});
ipcMain.handle('desk:get-config', rendererConfig);
ipcMain.on('desk:state', (_event, patch) => bridge?.updateTank({ lightOn: Boolean(patch?.lightOn ?? true), eggs: Number(patch?.eggs) || 0 }));
ipcMain.on('desk:reply', (_event, { friendId, text }) => bridge?.sendChat(friendId, text));
ipcMain.on('desk:interact', (_event, { friendId, kind }) => bridge?.interact(String(friendId || ''), String(kind || '')));
function applyPeekWindow(friend) {
  if (!win || win.isDestroyed()) return;
  if (friend) {
    if (!peeking) {
      const cur = win.getBounds();
      peekRestore = {
        bounds: roamMode && roamRestore?.bounds ? roamRestore.bounds : cur,
        opacity: config.opacity,
        alwaysOnTop: config.alwaysOnTop,
        wasRoam: roamMode
      };
    }
    peeking = true;
    peekingFriend = { ...friend };
    if (friend.roam) {
      const disp = displayOf(win.getBounds());
      setWindowBounds(win, disp.workArea);
      win.setOpacity(1);
      win.setAlwaysOnTop(true, 'floating');
      win.setIgnoreMouseEvents(true, { forward: true });
    } else {
      const base = peekRestore?.bounds || { ...defaultPosition(windowSize(config.width)), ...windowSize(config.width) };
      const safe = clampToWorkArea(base.x, base.y, base.width, base.height);
      setWindowBounds(win, { x: safe.x, y: safe.y, width: base.width, height: base.height });
      win.setOpacity(peekRestore?.opacity ?? config.opacity);
      win.setAlwaysOnTop(peekRestore?.alwaysOnTop ?? config.alwaysOnTop, 'floating');
      win.setIgnoreMouseEvents(true, { forward: true });
    }
    win.showInactive();
    win.webContents.send('desk:friend', {
      type: 'visit:peek',
      friend: peekingFriend,
      self: { name: config.nickname, breed: config.breed }
    });
  } else {
    if (!peeking) return;
    peeking = false;
    peekingFriend = null;
    const restore = peekRestore;
    peekRestore = null;
    if (restore?.wasRoam && roamMode) {
      const disp = displayOf(win.getBounds());
      setWindowBounds(win, disp.workArea);
      win.setOpacity(1);
      win.setAlwaysOnTop(true, 'floating');
    } else if (restore?.bounds) {
      const safe = clampToWorkArea(restore.bounds.x, restore.bounds.y, restore.bounds.width, restore.bounds.height);
      setWindowBounds(win, { x: safe.x, y: safe.y, width: restore.bounds.width, height: restore.bounds.height });
      win.setOpacity(restore.opacity ?? config.opacity);
      win.setAlwaysOnTop(restore.alwaysOnTop ?? config.alwaysOnTop, 'floating');
    }
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.send('desk:friend', {
      type: 'visit:peek',
      friend: null,
      self: { name: config.nickname, breed: config.breed }
    });
  }
  sendTo('menu', 'desk:menu-state', menuState());
}
ipcMain.on('desk:peek-friend', (_event, friend) => {
  applyPeekWindow(friend || null);
});
ipcMain.handle('desk:export-recovery', () => bridge?.exportRecoveryCode());
ipcMain.handle('desk:import-recovery', (_event, code) => bridge?.importRecoveryCode(code));
ipcMain.on('desk:close-dialog', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target === win) return;
  if (target === dialogs.update && forceUpgradeLocked) return;
  if (target === dialogs.menu) { target.hide(); return; }
  target.close();
});
ipcMain.on('desk:quit-app', () => app.quit());
ipcMain.on('desk:open-site', () => shell.openExternal(catalog.brand.site));

ipcMain.handle('desk:pair-info', (_event, ip) => bridge?.getPairInfo(ip));
ipcMain.handle('desk:submit-feedback', (_event, payload) => bridge?.addFeedback({ ...payload, source: 'desktop' }));

ipcMain.handle('desk:store', () => bridge?.getStore());
ipcMain.handle('desk:store-apply', (_event, themeId) => bridge?.applyTheme(String(themeId)));
ipcMain.handle('desk:store-preview', (_event, themeId) => bridge?.previewTheme(String(themeId)));
ipcMain.handle('desk:store-apply-skin', (_event, skinId) => bridge?.applySkin(String(skinId)));
ipcMain.handle('desk:store-preview-skin', (_event, skinId) => bridge?.previewSkin(String(skinId)));
ipcMain.handle('desk:store-redeem', (_event, code) => bridge?.redeem(code));
const isTrustedAlipayUrl = (u) => {
  try {
    const parsed = new URL(String(u || ''));
    return parsed.protocol === 'https:' && /(^|\.)alipay\.com$|(^|\.)alipaydev\.com$/.test(parsed.host);
  } catch {
    return false;
  }
};
ipcMain.handle('desk:store-buy', async (_event, skuId, opts = {}) => {
  const result = await bridge.createPayment(String(skuId));
  if (!result.ok) return result;
  if (!isTrustedAlipayUrl(result.payUrl)) return { ok: false, message: '支付链接异常' };
  if (opts?.inline) {
    const qrUrl = isTrustedAlipayUrl(result.qrUrl) ? result.qrUrl : result.payUrl;
    return {
      ok: true,
      payUrl: result.payUrl,
      qrUrl,
      amountYuan: result.amountYuan,
      skuName: result.skuName,
      message: `请使用支付宝扫码支付 ¥${result.amountYuan}`
    };
  }
  await shell.openExternal(result.payUrl);
  return { ok: true, message: `已打开支付宝（¥${result.amountYuan}），付款后自动解锁` };
});
ipcMain.handle('desk:open-pay-url', async (_event, url) => {
  if (!isTrustedAlipayUrl(url)) return { ok: false, message: '支付链接异常' };
  await shell.openExternal(String(url));
  return { ok: true };
});
ipcMain.handle('desk:check-nickname', (_event, nickname) => bridge?.checkNickname(nickname));
ipcMain.handle('desk:claim-nickname', async (_event, nickname, breed) => {
  const res = await bridge?.claimNickname(nickname, breed);
  if (res?.ok) {
    config.onboarded = true;
    saveConfig();
    pushConfig();
    win?.webContents.send('desk:action', 'celebrate');
    showCornerNotice({ kind: 'info', title: `欢迎，${res.nickname}`, body: '拖动摆放 · 右键菜单', duration: 3500 });
  }
  return res;
});
ipcMain.handle('desk:store-profile', (_event, patch) => { bridge?.updateProfile(patch || {}); return bridge?.getStore(); });
ipcMain.handle('desk:store-cloud', (_event, on) => { bridge?.setCloud(Boolean(on)); return bridge?.getStore(); });
ipcMain.handle('desk:store-delete', () => bridge?.deleteCloudData());
ipcMain.handle('desk:friend-action', (_event, action, friendId, accept) => bridge?.friendAction(String(action), { friendId: String(friendId || '').trim().toUpperCase(), accept: Boolean(accept) }));

ipcMain.handle('desk:start-update', (_event, opts) => downloadAndInstall(pendingUpdate, (p) => {
  sendTo('update', 'desk:update-progress', p);
  win?.webContents.send('desk:update-progress', p);
}, { silent: Boolean(opts?.background) }));
ipcMain.on('desk:cancel-update', () => cancelDownload());
ipcMain.handle('desk:update-info', () => pendingUpdate);
ipcMain.handle('desk:notice-info', () => pendingNotice);

/* 取消丑陋的独立右上角弹窗：所有提醒统一发给鱼缸主窗口，在鱼缸内部以灵动水泡呈现 */
function showCornerNotice(notice) {
  pendingNotice = notice;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('desk:notice', notice);
}
ipcMain.on('desk:skip-update', () => {
  /* 未更新版本前不永久隐藏箭头，只关闭独立弹窗（如有） */
  if (forceUpgradeLocked) return;
  dialogs.update?.close();
});

function openUpdateWindow(info) {
  pendingUpdate = info;
  if (info.forceUpdate) {
    forceUpgradeLocked = true;
    win?.hide();
  }
  const target = openDialog('update', { closable: !info.forceUpdate });
  sendTo('update', 'desk:update-data', info);
  return target;
}

async function runUpdateCheck(manual = false) {
  try {
    const info = await checkUpdate();
    const available = info?.ok && (info.needUpdate || info.forceUpdate);
    /* 只要尚未更新到最新版本，更新箭头持续显示，不再因 skipVersion 隐藏；强制更新才弹阻断窗 */
    if (available) {
      pendingUpdate = info;
      if (info.forceUpdate) {
        openUpdateWindow(info);
      } else {
        win?.webContents.send('desk:update-available', { ...info, expand: Boolean(manual) });
      }
    } else if (manual) {
      showCornerNotice({ kind: 'info', title: '已是最新版本', body: `v${app.getVersion()}`, duration: 3000 });
    }
  } catch {
    if (manual) showCornerNotice({ kind: 'info', title: '检查更新失败', body: '稍后再试', duration: 3200 });
  }
}

/* ---------- 生命周期 ---------- */
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => toggleVisible(true));

app.whenReady().then(async () => {
  config = loadConfig();
  saveConfig();
  bridge = await startBridge({
    devUrl: DEV_URL,
    distDir: path.join(__dirname, '..', 'dist'),
    dataDir: app.getPath('userData'),
    config,
    version: app.getVersion(),
    onConfigChange: () => {
      saveConfig();
      pushConfig();
    },
    onEvent: (msg) => {
      if (msg.type === 'phone:count') {
        sendTo('pair', 'desk:phone-count', msg.count);
        sendTo('menu', 'desk:phone-count', msg.count);
      }
      else if (msg.type === 'action') win?.webContents.send('desk:action', msg.action);
      else if (msg.type === 'store:changed') {
        const st = bridge?.getStore();
        sendTo('store', 'desk:store-data', st);
        sendTo('upgrade', 'desk:store-data', st);
        sendTo('menu', 'desk:menu-state', menuState());
        win?.webContents.send('desk:requests', st?.requests || []);
      }
      else if (msg.type === 'store:paid') {
        if (!Number.isFinite(bridge?.getRoamRemainingSec())) {
          clearInterval(roamTrialTimer);
          roamTrialTimer = null;
        }
        sendTo('store', 'desk:store-paid', msg.message);
        sendTo('upgrade', 'desk:store-paid', msg.message);
        win?.webContents.send('desk:action', 'celebrate');
        win?.webContents.send('desk:upsell', null);
        showCornerNotice({ kind: 'info', title: '解锁成功 ✨', body: msg.message, duration: 4000 });
      } else if (msg.type === 'preview:ended') {
        const t = catalog.themes.find((x) => x.id === msg.skuId);
        const s = (catalog.skins || []).find((x) => x.id === msg.skuId);
        if (t && !config.unlockedThemes.includes(t.id)) {
          win?.webContents.send('desk:upsell', {
            skuId: t.id,
            title: `喜欢「${t.name}」这片水景吗？`,
            btnText: '解锁'
          });
        } else if (s && !(config.unlockedSkins || []).includes(s.id)) {
          win?.webContents.send('desk:upsell', {
            skuId: s.id,
            title: `喜欢「${s.name}」陪在桌边吗？`,
            btnText: '解锁'
          });
        }
      } else if (msg.type === 'release:new') {
        runUpdateCheck(false);
      } else if (msg.type === 'notice') {
        showCornerNotice(msg);
      } else if (msg.type === 'visit:self') {
        win?.webContents.send('desk:friend', msg);
        // 若正在观光对方（桌面逛街或鱼缸），对方切换形态/造景或串门结束时，本地观光画面实时同步切换
        if (peeking) {
          if (!msg.visiting) {
            applyPeekWindow(null);
          } else if (peekingFriend && msg.visiting.id === peekingFriend.id) {
            const changed = (
              Boolean(msg.visiting.roam) !== Boolean(peekingFriend.roam) ||
              msg.visiting.theme !== peekingFriend.theme ||
              msg.visiting.lightOn !== peekingFriend.lightOn ||
              msg.visiting.breed !== peekingFriend.breed
            );
            if (changed) applyPeekWindow(msg.visiting);
          }
        }
      } else if (msg.type.startsWith('friend:') || msg.type.startsWith('chat:') || msg.type.startsWith('visit:')) win?.webContents.send('desk:friend', msg);
    }
  });
  saveConfig();

  createWindow();
  createTray();
  checkWindowsAuth().then((ok) => {
    winAuthAvailable = ok;
    sendTo('menu', 'desk:menu-state', menuState());
  }).catch(() => {});
  globalShortcut.register(BOSS_KEY, () => toggleVisible());
  globalShortcut.register(WALLPAPER_EXIT_KEY, () => {
    if (screensaverMode === 'wallpaper') exitScreensaver();
  });
  globalShortcut.register(LOCK_SCREEN_KEY, () => {
    if (!screensaverMode && !peeking) startScreensaver('foreground');
  });
  if (config.wallpaperPersistent && config.unlockedFeatures.includes('wallpaper')) {
    win.once('ready-to-show', () => setTimeout(() => enterScreensaver({ mode: 'wallpaper', preview: false }), 600));
  }
  if (!config.named) {
    setTimeout(() => openDialog('welcome'), 450);
  }

  /* 多显示器热插拔 / 分辨率变化时自动把鱼缸拉回可见区域 */
  const keepOnScreen = () => {
    if (!win || win.isDestroyed()) return;
    if (isFill()) {
      placeAt(displayOf(win.getBounds()).workArea);
      return;
    }
    const b = win.getBounds();
    const pos = clampToWorkArea(b.x, b.y, b.width, b.height);
    if (pos.x !== b.x || pos.y !== b.y) win.setPosition(pos.x, pos.y);
  };
  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);

  // 启动 4 秒后自动检测更新，之后每 30 分钟兜底检测一次（发版时也会通过 SSE 秒级触发）
  setTimeout(() => runUpdateCheck(false), 4000);
  setInterval(() => runUpdateCheck(false), 30 * 60 * 1000);

  // 每 2 秒轻量检测用户键鼠活跃度 + 自定义闲置分钟数自动锁屏屏保 + 主鱼轻成长活跃陪伴计时
  const idleTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const idle = powerMonitor.getSystemIdleTime();
    if (idle < 2) {
      win.webContents.send('desk:action', 'activity');
    } else {
      const idleTargetSec = Math.max(60, Math.round((Number(config.screensaverIdleMinutes) || 3) * 60));
      const ssRem = bridge ? bridge.getFeatureRemainingSec('screensaver') : Infinity;
      if (
        idle >= idleTargetSec &&
        config.autoScreensaver &&
        (!Number.isFinite(ssRem) || ssRem > 0) &&
        !screensaverMode &&
        !peeking
      ) {
        enterScreensaver({ mode: 'foreground', autoLock: true });
      }
    }

    // 主鱼轻成长活跃使用计时（仅在开启成长且窗口可见时计时，每满 60 秒自动陪伴 +2 成长值）
    if (config.growth?.enabled && bridge) {
      const gRem = bridge.getFeatureRemainingSec('growth');
      if (!Number.isFinite(gRem) || gRem > 0) {
        growthExpAccSec += 2;
        if (growthExpAccSec >= 60) {
          growthExpAccSec = 0;
          bridge.addGrowthExp(2, { isFeed: false });
          pushConfig();
        }
        if (Number.isFinite(gRem)) {
          const left = bridge.addFeatureUsageSec('growth', 2);
          if (left <= 0) {
            pushConfig();
            sendTo('menu', 'desk:menu-state', menuState());
            const today = new Date().toISOString().slice(0, 10);
            if (growthUpsellShownDate !== today) {
              growthUpsellShownDate = today;
              sendFeatureUpsell('growth', '主鱼轻成长今日 20 分钟体验已用完');
            }
          }
        }
      }
    }
  }, 2000);
  app.on('will-quit', () => {
    clearInterval(idleTimer);
    clearInterval(roamTrialTimer);
    clearInterval(screensaverTimer);
    closeScreensaverExtras();
    if (macWallpaperWin && !macWallpaperWin.isDestroyed()) { try { macWallpaperWin.close(); } catch {} }
    if (screensaverMode === 'wallpaper' && process.platform === 'win32' && win && !win.isDestroyed()) detachWallpaper(win);
    globalShortcut.unregisterAll();
    bridge?.close();
  });
});
app.on('activate', () => toggleVisible(true));
app.on('window-all-closed', () => app.quit());
