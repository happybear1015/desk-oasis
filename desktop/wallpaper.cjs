/* Windows 真·桌面壁纸挂载模块（Progman -> WorkerW，置于所有桌面图标后方，不挡任何图标，Win+D 持久不隐藏）
   兼容 Windows 10 / Windows 11（含 24H2） */
const { execFile } = require('node:child_process');

function getHwndStr(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
}

const CS_CODE = `
using System;
using System.Runtime.InteropServices;

public static class OasisWallpaper {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr FindWindowEx(IntPtr parentHandle, IntPtr childAfter, string className, string windowTitle);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

  public static IntPtr GetWorkerW() {
    IntPtr progman = FindWindow("Progman", null);
    if (progman == IntPtr.Zero) return IntPtr.Zero;
    UIntPtr result;
    // 通知 Explorer 在桌面图标层(SHELLDLL_DefView)后方生成 WorkerW 壁纸宿主窗口
    SendMessageTimeout(progman, 0x052C, new UIntPtr(0xD), new IntPtr(0x1), 0x0, 1000, out result);
    SendMessageTimeout(progman, 0x052C, UIntPtr.Zero, IntPtr.Zero, 0x0, 1000, out result);

    IntPtr workerw = IntPtr.Zero;
    EnumWindows((tophandle, topparamhandle) => {
      IntPtr defView = FindWindowEx(tophandle, IntPtr.Zero, "SHELLDLL_DefView", null);
      if (defView != IntPtr.Zero) {
        workerw = FindWindowEx(IntPtr.Zero, tophandle, "WorkerW", null);
      }
      return true;
    }, IntPtr.Zero);

    // Windows 11 24H2 兼容：WorkerW 有时作为 Progman 的子窗口存在
    if (workerw == IntPtr.Zero) {
      workerw = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
    }
    return workerw != IntPtr.Zero ? workerw : progman;
  }

  public static bool Attach(long hwndVal, int x, int y, int w, int h) {
    IntPtr target = new IntPtr(hwndVal);
    IntPtr workerw = GetWorkerW();
    if (workerw == IntPtr.Zero) return false;
    // 加上 WS_CHILD 确保牢固嵌入桌面图标后方
    int style = GetWindowLong(target, -16);
    SetWindowLong(target, -16, style | 0x40000000);
    SetParent(target, workerw);
    SetWindowPos(target, IntPtr.Zero, x, y, w, h, 0x0010 | 0x0040);
    return true;
  }

  public static bool Detach(long hwndVal) {
    IntPtr target = new IntPtr(hwndVal);
    int style = GetWindowLong(target, -16);
    SetWindowLong(target, -16, style & ~0x40000000);
    SetParent(target, IntPtr.Zero);
    return true;
  }
}
`;

function runPs(script) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { timeout: 6000, windowsHide: true },
      (err) => resolve(!err)
    );
  });
}

async function attachWallpaper(win, { x = 0, y = 0, width, height }) {
  const hwnd = getHwndStr(win);
  const script = `Add-Type -TypeDefinition @'\n${CS_CODE}\n'@; [OasisWallpaper]::Attach(${hwnd}, ${Math.round(x)}, ${Math.round(y)}, ${Math.round(width)}, ${Math.round(height)}) | Out-Null`;
  return runPs(script);
}

async function detachWallpaper(win) {
  const hwnd = getHwndStr(win);
  const script = `Add-Type -TypeDefinition @'\n${CS_CODE}\n'@; [OasisWallpaper]::Detach(${hwnd}) | Out-Null`;
  return runPs(script);
}

module.exports = { attachWallpaper, detachWallpaper };
