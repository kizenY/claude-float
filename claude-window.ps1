# Long-running watcher: prints "open" when the Claude desktop app has a visible, non-minimized window
# on the current virtual desktop, "closed" otherwise. Prints only on change.
param([string]$Name = 'claude') # another process name is only for testing
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CW {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

  public static bool AnyOpen(HashSet<uint> pids) {
    bool found = false;
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || !IsWindowVisible(h) || IsIconic(h) || GetWindowTextLength(h) == 0) return true;
      RECT r; GetWindowRect(h, out r);
      if (r.R - r.L < 300 || r.B - r.T < 200) return true; // popups, tooltips
      int cloaked = 0;
      DwmGetWindowAttribute(h, 14, out cloaked, 4); // DWMWA_CLOAKED: other virtual desktop etc.
      if (cloaked != 0) return true;
      found = true;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$last = ''
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
$tick = 0
while ($true) {
  if ($tick % 5 -eq 0) {
    # Only the desktop app itself, not the Claude Code CLI processes it spawns
    $pids.Clear()
    Get-Process $Name -ErrorAction SilentlyContinue | Where-Object { $Name -ne 'claude' -or $_.Path -like '*\WindowsApps\Claude_*' -or $_.Path -like '*\AnthropicClaude\*' } |
      ForEach-Object { [void]$pids.Add([uint32]$_.Id) }
  }
  $state = if ($pids.Count -gt 0 -and [CW]::AnyOpen($pids)) { 'open' } else { 'closed' }
  if ($state -ne $last) { [Console]::Out.WriteLine($state); [Console]::Out.Flush(); $last = $state }
  $tick++
  Start-Sleep -Milliseconds 700
}
