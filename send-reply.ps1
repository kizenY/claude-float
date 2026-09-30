# Paste the clipboard into the prompt box of the Claude desktop session that is being opened, then press Enter.
# The caller has already put the message on the clipboard and fired claude://code/continue?session=local_xxx.
# Every step is checked; on any mismatch we stop without typing anything.
param(
  [string]$TitleB64 = '',
  [long]$PrevHwnd = 0,
  [int]$WaitMs = 6000,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  // Windows only lets the foreground owner hand focus away; borrow its input queue, then fall back to the Alt-key trick
  public static bool Activate(IntPtr h) {
    if (GetForegroundWindow() == h) return true;
    uint me = GetCurrentThreadId();
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fg, false);
    if (GetForegroundWindow() == h) return true;
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    SetForegroundWindow(h);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return GetForegroundWindow() == h;
  }
}
"@

function Done($obj) {
  if ($PrevHwnd -ne 0) { [W]::Activate([IntPtr]$PrevHwnd) | Out-Null }
  $obj | ConvertTo-Json -Compress
  exit 0
}

$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]::Descendants
$docCond = New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, 'RootWebArea')
$editCond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
  (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Prompt')))

$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleB64)).Trim()
$want = if ($title.Length -gt 24) { $title.Substring(0, 24) } else { $title }

# 1. Wait until the Claude window shows the target session
$deadline = (Get-Date).AddMilliseconds($WaitMs)
$hwnd = [IntPtr]::Zero; $edit = $null; $docName = ''
while ((Get-Date) -lt $deadline) {
  $p = Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) {
    $hwnd = $p.MainWindowHandle
    try {
      $doc = $A::FromHandle($hwnd).FindFirst($Scope, $docCond)
      if ($doc) {
        $docName = $doc.Current.Name
        if ($want -and $docName.StartsWith($want)) {
          $edit = $doc.FindFirst($Scope, $editCond)
          if ($edit) { break }
        }
      }
    } catch { }
  }
  Start-Sleep -Milliseconds 200
}
if (-not $edit) { Done @{ ok = $false; error = 'session-not-open'; doc = $docName } }

# 2. Refuse to overwrite a draft that is already in the box
$draft = ''
try { $draft = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { }
if ($draft -and $draft.Trim()) { Done @{ ok = $false; error = 'draft' } }

# 3. Bring Claude to front and focus the prompt box
if ([W]::IsIconic($hwnd)) { [W]::ShowWindow($hwnd, 9) | Out-Null }
for ($i = 0; $i -lt 5 -and -not [W]::Activate($hwnd); $i++) { Start-Sleep -Milliseconds 100 }
try { $edit.SetFocus() } catch { }
Start-Sleep -Milliseconds 150
if ([W]::GetForegroundWindow() -ne $hwnd) { Done @{ ok = $false; error = 'no-foreground' } }
$focused = $A::FocusedElement
if (-not $focused -or -not [System.Windows.Automation.Automation]::Compare($focused, $edit)) {
  Done @{ ok = $false; error = 'no-focus' }
}

# 4. Paste, check it landed, send
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 300
$value = ''
try { $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { }
if ($DryRun) {
  [System.Windows.Forms.SendKeys]::SendWait('^a{DEL}')
  Done @{ ok = $true; dryRun = $true; pasted = $value; doc = $docName }
}
if ([W]::GetForegroundWindow() -ne $hwnd) { Done @{ ok = $false; error = 'lost-foreground' } }
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 150
Done @{ ok = $true; doc = $docName }
