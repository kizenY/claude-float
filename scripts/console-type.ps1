# Type text into another process's console WITHOUT touching window focus:
# attach to the target's console and push key events straight into its input
# buffer (WriteConsoleInputW). The terminal reads them exactly like real
# typing, so no window switch, no clipboard, no foreground steal.
# Used by claude-float quick reply (channels are broken upstream, #44181).
# Prints one status word on stdout: ok | empty | attach-failed | write-failed
# KEEP THIS FILE ASCII-ONLY: WinPS 5.1 misreads BOM-less non-ASCII .ps1 files.
param(
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$TextFile
)

$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$text = ($text -replace "`r`n|`r|`n", ' ').Trim()
if ($text.Length -eq 0) { Write-Output 'empty'; exit 0 }

$src = @'
using System;
using System.Runtime.InteropServices;
public static class ConType {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEY_EVENT_RECORD {
    public int bKeyDown;
    public ushort wRepeatCount;
    public ushort wVirtualKeyCode;
    public ushort wVirtualScanCode;
    public ushort UnicodeChar;
    public uint dwControlKeyState;
  }
  [StructLayout(LayoutKind.Explicit, Pack=4)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buf, uint len, out uint written);
  [DllImport("user32.dll")] public static extern short VkKeyScanW(char ch);
}
'@
Add-Type -TypeDefinition $src

# powershell inherited our own console; detach first or AttachConsole fails
[ConType]::FreeConsole() | Out-Null
if (-not [ConType]::AttachConsole([uint32]$TargetPid)) {
  Write-Output 'attach-failed'
  exit 0
}
try {
  # open CONIN$ of the freshly attached console (GetStdHandle can hand back a stale cached handle)
  $h = [ConType]::CreateFileW('CONIN$', [uint32]3221225472, [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)  # GENERIC_READ|GENERIC_WRITE
  if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr]::op_Explicit(-1)) {
    Write-Output "conin-failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    exit 0
  }
  # NOTE: PowerShell silently drops field writes on NESTED value-type structs
  # ($r.KeyEvent.bKeyDown = x sets a copy). Build KEY_EVENT_RECORD separately
  # and assign it whole.
  function New-KeyEvent([int]$down, [uint16]$vk, [uint16]$ch) {
    $ke = New-Object 'ConType+KEY_EVENT_RECORD'
    $ke.bKeyDown = $down
    $ke.wRepeatCount = 1
    $ke.wVirtualKeyCode = $vk
    $ke.UnicodeChar = $ch
    $r = New-Object 'ConType+INPUT_RECORD'
    $r.EventType = 1  # KEY_EVENT
    $r.KeyEvent = $ke
    return $r
  }
  $chars = $text.ToCharArray()
  $recs = New-Object 'ConType+INPUT_RECORD[]' (($chars.Length + 1) * 2)
  $i = 0
  foreach ($ch in $chars) {
    $vk = [ConType]::VkKeyScanW($ch)
    if ($vk -lt 0) { $vk = 0 }  # not on keyboard layout (CJK etc.) - UnicodeChar still carries it
    $recs[$i++] = New-KeyEvent 1 ([uint16]($vk -band 0xff)) ([uint16]$ch)
    $recs[$i++] = New-KeyEvent 0 ([uint16]($vk -band 0xff)) ([uint16]$ch)
  }
  # Enter: VK_RETURN + carriage return char, like a real Enter keypress
  $recs[$i++] = New-KeyEvent 1 0x0D 0x0D
  $recs[$i++] = New-KeyEvent 0 0x0D 0x0D
  $written = 0
  $okCall = [ConType]::WriteConsoleInputW($h, $recs, [uint32]$i, [ref]$written)
  if ($okCall -and $written -eq $i) {
    Write-Output 'ok'
  } else {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Output "write-failed $written/$i call=$okCall err=$err"
  }
} finally {
  [ConType]::FreeConsole() | Out-Null
}
