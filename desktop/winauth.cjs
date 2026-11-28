/* 系统原生身份验证（Windows Hello PIN/指纹/人脸 + macOS Touch ID / 系统密码）
   - Windows：使用 UTF-16LE Base64 -EncodedCommand 调用 UserConsentVerifier
   - macOS：使用 Electron 原生 systemPreferences.promptTouchID 唤起触控 ID / 系统验证 */
const { execFile } = require('node:child_process');
const { systemPreferences } = require('electron');

let cachedAvailable = null;

function runPs(script, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve('');
        resolve(String(stdout || '').trim());
      }
    );
  });
}

async function checkWindowsAuth() {
  if (cachedAvailable !== null) return cachedAvailable;
  if (process.platform === 'darwin') {
    try {
      cachedAvailable = Boolean(systemPreferences?.canPromptTouchID?.());
    } catch {
      cachedAvailable = false;
    }
    return cachedAvailable;
  }
  if (process.platform !== 'win32') {
    cachedAvailable = false;
    return false;
  }
  const script = [
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null',
    "$m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    '$op = [Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()',
    '$t = $m.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]).Invoke($null, @($op))',
    '$t.Wait()',
    'Write-Output $t.Result'
  ].join('\n');
  const res = await runPs(script, 6000);
  cachedAvailable = res === 'Available';
  return cachedAvailable;
}

async function verifyWindowsAuth(message = '桌面生态 · 验证身份以解锁桌面') {
  if (process.platform === 'darwin') {
    if (!systemPreferences?.canPromptTouchID?.()) {
      return { ok: false, reason: 'unsupported', message: '当前 Mac 未开启触控 ID' };
    }
    try {
      await systemPreferences.promptTouchID(String(message || '验证触控 ID 以解锁桌面生态'));
      return { ok: true };
    } catch (err) {
      const msg = String(err?.message || '');
      const canceled = /cancel|user/i.test(msg);
      return { ok: false, canceled, message: canceled ? '已取消验证' : '身份验证未通过' };
    }
  }
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' };
  const safeMsg = String(message || '验证身份以解锁桌面').replace(/['"`$\r\n]/g, '');
  const script = [
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null',
    "$m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    `$op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${safeMsg}')`,
    '$t = $m.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult]).Invoke($null, @($op))',
    '$t.Wait()',
    'Write-Output $t.Result'
  ].join('\n');
  const res = await runPs(script, 120000);
  if (res === 'Verified') return { ok: true };
  if (res === 'Canceled') return { ok: false, canceled: true, message: '已取消验证' };
  return { ok: false, message: '身份验证未通过' };
}

module.exports = { checkWindowsAuth, verifyWindowsAuth };
