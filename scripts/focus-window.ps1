param([int]$TargetPid, [switch]$NoToggle)
# Bring the console window (or hosting terminal window) of a process to the foreground;
# if it IS the foreground window, minimize it instead (toggle).
# -NoToggle: focus only — already-foreground is reported 'ok' without minimizing
# (quick reply pastes into the window; minimizing it would eat the paste).
# Classic console: the window belongs to conhost; AttachConsole(pid) + GetConsoleWindow
# returns its hwnd directly. Under ConPTY that hwnd is a hidden 0-size PseudoConsoleWindow,
# so RealWindow() swaps in its owner (the real terminal window). The parent-chain walk is
# the last-resort fallback.
# NOTE: this script only sees the TRUE foreground window because the float window is
# non-focusable (WS_EX_NOACTIVATE) — clicks on it don't change the foreground.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinFocus {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);

  // GetConsoleWindow under ConPTY (Windows Terminal, VS Code terminal, ...) returns the
  // hidden 0-size PseudoConsoleWindow — focusing it does nothing. Its GW_OWNER is the
  // real terminal window. Classic consoles have no owner, so this is a no-op there.
  public static IntPtr RealWindow(IntPtr h) {
    if (h == IntPtr.Zero) return h;
    IntPtr owner = GetWindow(h, 4); // GW_OWNER
    return owner != IntPtr.Zero ? owner : h;
  }

  // SetForegroundWindow has foreground-permission rules; borrowing the foreground
  // thread's input state via AttachThreadInput is the standard workaround.
  // Success is judged by GetForegroundWindow(), not the API return value.
  public static bool Focus(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    ShowWindow(h, 9); // SW_RESTORE: un-minimize first
    uint fgPid;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out fgPid);
    uint myThread = GetCurrentThreadId();
    bool attached = fgThread != myThread && AttachThreadInput(myThread, fgThread, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    SetActiveWindow(h);
    if (attached) AttachThreadInput(myThread, fgThread, false);
    if (GetForegroundWindow() == h) return true;
    SwitchToThisWindow(h, true);
    System.Threading.Thread.Sleep(50);
    return GetForegroundWindow() == h;
  }
}
'@

function Focus-Window([IntPtr]$h) {
  return [WinFocus]::Focus($h)
}

# Toggle semantics: already foreground -> minimize; otherwise focus.
# Returns 'min' / 'ok' / '' as the FUNCTION return value only —
# never Write-Output inside a function (it pollutes stdout, and callers
# compare stdout literally).
function Toggle-Window([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return '' }
  if ([WinFocus]::GetForegroundWindow() -eq $h) {
    if ($NoToggle) { return 'ok' }
    [WinFocus]::ShowWindow($h, 6) | Out-Null  # SW_MINIMIZE
    return 'min'
  }
  if (Focus-Window $h) { return 'ok' }
  return ''
}

[WinFocus]::FreeConsole() | Out-Null  # must drop our own console before attaching to another
if ([WinFocus]::AttachConsole([uint32]$TargetPid)) {
  $h = [WinFocus]::RealWindow([WinFocus]::GetConsoleWindow())
  [WinFocus]::FreeConsole() | Out-Null
  if ($h -ne [IntPtr]::Zero -and [WinFocus]::IsWindowVisible($h)) {
    $r = Toggle-Window $h
    if ($r) { Write-Output $r; exit 0 }
  }
}

$cur = $TargetPid
for ($i = 0; $i -lt 8 -and $cur; $i++) {
  $proc = Get-Process -Id $cur -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne 0) {
    $r = Toggle-Window ([IntPtr]$proc.MainWindowHandle)
    if ($r) { Write-Output $r; exit 0 }
  }
  $rec = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
  if (-not $rec) { break }
  $cur = $rec.ParentProcessId
}
Write-Output 'fail'
