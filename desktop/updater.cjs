/* 在线升级：检查版本 → 流式下载（带进度）→ 校验 SHA256 → 启动安装包并退出旧进程 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app, shell } = require('electron');
const { getServerBase } = require('./bridge.cjs');

/* 安装包只允许来自官方服务器或 GitHub Releases */
function isTrustedUrl(downloadUrl) {
  try {
    const url = new URL(downloadUrl);
    if (url.protocol !== 'https:') return false;
    return url.host === new URL(getServerBase()).host || url.host === 'github.com';
  } catch {
    return false;
  }
}

async function checkUpdate() {
  const current = app.getVersion();
  const res = await fetch(`${getServerBase()}/api/oasis/update/check?version=${encodeURIComponent(current)}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  /* 服务端版本过旧或被反代到别的站点时会返回 HTML，这里给出能看懂的提示而不是 JSON 解析报错 */
  if (!String(res.headers.get('content-type') || '').includes('json')) throw new Error('更新服务暂不可用，请稍后再试');
  const data = await res.json();
  if (data.downloadUrl && !isTrustedUrl(data.downloadUrl)) return { ...data, needUpdate: false, forceUpdate: false, currentVersion: current };
  return { ...data, currentVersion: current };
}

let activeController = null;

function cancelDownload() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

async function fetchDownload(info, signal) {
  const candidates = [];
  const base = getServerBase();
  /* 优先尝试阿里云官方直连镜像（国内满速不超时），再依次尝试加速代理与 GitHub 直连 */
  const fileName = (() => {
    try { return path.basename(new URL(info.downloadUrl).pathname); } catch { return ''; }
  })();
  if (info.sha256 && fileName && /^DeskOasis-Setup-[0-9.]+\.exe$/i.test(fileName)) {
    const mirrorUrl = `${base}/downloads/${fileName}`;
    if (mirrorUrl !== info.downloadUrl) candidates.push(mirrorUrl);
  }
  if (info.sha256 && /^https:\/\/github\.com\/.+\/releases\/download\//i.test(info.downloadUrl)) {
    candidates.push(`https://ghfast.top/${info.downloadUrl}`);
    candidates.push(`https://gh-proxy.com/${info.downloadUrl}`);
  }
  candidates.push(info.downloadUrl);

  let lastErr = null;
  for (const candidate of candidates) {
    /* 注意：连接超时只管握手阶段，拿到响应头后立刻清除，绝不能中断大文件流下载 */
    const reqCtrl = new AbortController();
    const onAbort = () => reqCtrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const connectTimer = setTimeout(() => { timedOut = true; reqCtrl.abort(); }, 15000);
    try {
      const res = await fetch(candidate, { redirect: 'follow', signal: reqCtrl.signal });
      clearTimeout(connectTimer);
      if (res.ok && res.body) {
        return { res, cleanup: () => signal?.removeEventListener('abort', onAbort) };
      }
      signal?.removeEventListener('abort', onAbort);
      lastErr = new Error(`服务器返回 ${res.status}`);
    } catch (err) {
      clearTimeout(connectTimer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw new Error('已取消下载');
      lastErr = timedOut ? new Error('连接超时，正在切换线路') : new Error('下载连接失败');
    }
  }
  throw lastErr || new Error('下载失败，请稍后重试');
}

async function downloadAndInstall(info, onProgress, { silent = false } = {}) {
  if (!info?.downloadUrl || !isTrustedUrl(info.downloadUrl)) throw new Error('更新地址无效');
  const expectedSha = String(info.sha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new Error('安装包校验信息缺失');

  cancelDownload();
  const controller = new AbortController();
  activeController = controller;

  const rawExt = (() => {
    try { return path.extname(new URL(info.downloadUrl).pathname) || (process.platform === 'darwin' ? '.dmg' : '.exe'); } catch { return process.platform === 'darwin' ? '.dmg' : '.exe'; }
  })();
  const dest = path.join(os.tmpdir(), `DeskOasis-Setup-${info.latestVersion || Date.now()}${rawExt}`);
  let file = null;
  let cleanup = null;
  try {
    const dl = await fetchDownload(info, controller.signal);
    const res = dl.res;
    cleanup = dl.cleanup;
    const total = Number(res.headers.get('content-length') || info.size || 0);
    file = fs.createWriteStream(dest);
    const hash = crypto.createHash('sha256');
    let received = 0;
    const reader = res.body.getReader();

    while (true) {
      if (controller.signal.aborted) throw new Error('已取消下载');
      let chunkTimeout;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { chunkTimeout = setTimeout(() => reject(new Error('下载超时，请重试')), 30000); })
      ]).finally(() => clearTimeout(chunkTimeout));
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      if (!file.write(chunk)) await new Promise((resolve) => file.once('drain', resolve));
      received += chunk.length;
      onProgress?.({ received, total, pct: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0 });
    }
    await new Promise((resolve, reject) => {
      file.on('finish', resolve);
      file.on('error', reject);
      file.end();
    });
    file = null;

    if (hash.digest('hex') !== expectedSha) {
      fs.rmSync(dest, { force: true });
      throw new Error('安装包校验失败，请重试');
    }
    onProgress?.({ received, total, pct: 100 });

    /* Windows 全自动静默升级：
       1. 等所有同路径 DeskOasis 进程（主进程 + GPU/渲染子进程）彻底退出释放文件锁
       2. 携带 /S /D=<当前安装目录> 精准覆盖安装（NSIS 要求 /D= 放最后且不加引号）
       3. 若静默安装返回非 0（如需要 UAC 提权），自动回退为可见安装向导，绝不悄悄失败
       4. 安装完成后自动拉起最新版主程序，并记录日志到 %TEMP%\deskoasis-update.log */
    if (process.platform === 'win32') {
      const exePath = process.execPath;
      const installDir = path.dirname(exePath);
      const logPath = path.join(os.tmpdir(), 'deskoasis-update.log');
      const pid = process.pid;
      const esc = (s) => String(s).replace(/'/g, "''");
      const psScript = [
        `$log = '${esc(logPath)}'`,
        `$dest = '${esc(dest)}'`,
        `$exe = '${esc(exePath)}'`,
        `$dir = '${esc(installDir)}'`,
        `$pidToWait = ${pid}`,
        'function Log($m) { Add-Content -Path $log -Value ("[" + (Get-Date -Format "HH:mm:ss") + "] " + $m) -ErrorAction SilentlyContinue }',
        'Log "Start update to $dest (installDir=$dir, pid=$pidToWait)"',
        'for ($i = 0; $i -lt 60; $i++) {',
        '  $mainAlive = Get-Process -Id $pidToWait -ErrorAction SilentlyContinue',
        '  $sameExe = Get-Process -Name "DeskOasis" -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq $exe } catch { $false } }',
        '  if (-not $mainAlive -and -not $sameExe) { break }',
        '  Start-Sleep -Milliseconds 250',
        '}',
        'Start-Sleep -Milliseconds 600',
        '$argStr = "/S /D=$dir"',
        'Log "Running silent installer: $dest $argStr"',
        '$p = Start-Process -FilePath $dest -ArgumentList $argStr -Wait -PassThru -WindowStyle Hidden',
        '$code = if ($p) { $p.ExitCode } else { -1 }',
        'Log "Silent installer exitCode=$code"',
        'if ($code -ne 0) {',
        '  Log "Silent install failed, falling back to interactive installer"',
        '  $p2 = Start-Process -FilePath $dest -Wait -PassThru',
        '  $code2 = if ($p2) { $p2.ExitCode } else { -1 }',
        '  Log "Interactive installer exitCode=$code2"',
        '}',
        'Start-Sleep -Milliseconds 400',
        'if (Test-Path -LiteralPath $exe) {',
        '  Log "Relaunching $exe"',
        '  Start-Process -FilePath $exe',
        '} else {',
        '  Log "Exe not found at $exe"',
        '}',
        'Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue'
      ].join('\n');
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
      setTimeout(() => app.exit(0), 250);
    } else if (process.platform === 'darwin') {
      await shell.openPath(dest);
      setTimeout(() => app.quit(), 800);
    } else {
      const args = silent ? ['/S'] : [];
      const child = spawn(dest, args, { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => app.quit(), 600);
    }
    return dest;
  } catch (err) {
    if (file) { try { file.destroy(); } catch {} }
    fs.rmSync(dest, { force: true });
    throw err;
  } finally {
    if (cleanup) { try { cleanup(); } catch {} }
    if (activeController === controller) activeController = null;
  }
}

module.exports = { checkUpdate, downloadAndInstall, cancelDownload };
