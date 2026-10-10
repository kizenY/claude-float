# Raw-mode test for console-type.ps1: spawn conreader.js via WMI (own console),
# inject ASCII + CJK + Enter into its console, then dump what the raw reader
# actually received. Raw ReadConsoleInput is what Claude Code's TUI consumes,
# so this is the fidelity test that matters. KEEP ASCII-ONLY (WinPS 5.1).
$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP 'cf-console-type-raw.log'
Remove-Item $log -ErrorAction SilentlyContinue
$node = (Get-Command node.exe).Source
$reader = Join-Path $PSScriptRoot 'conreader.js'
# cmd "start" creates the child with CREATE_NEW_CONSOLE on OUR window station
# (WMI/Start-Process either lands on the service winsta or shares our console).
& cmd.exe /c ('start "" /min "{0}" "{1}" "{2}"' -f $node, $reader, $log)
Start-Sleep -Milliseconds 1500
# find the node.exe child carrying our log path on its command line
$childPid = 0
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline -and -not $childPid) {
  $proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains('conreader.js') } |
    Select-Object -First 1
  if ($proc) { $childPid = [int]$proc.ProcessId }
  else { Start-Sleep -Milliseconds 300 }
}
if (-not $childPid) { Write-Output 'selftest-fail: reader process not found'; exit 1 }
try {
  Start-Sleep -Milliseconds 1500
  $textFile = Join-Path $env:TEMP 'cf-console-type-raw.txt'
  # ASCII + CJK + symbol mix: "ab <ni-hao> x>y" (CJK built from codepoints to keep this file ASCII)
  $sample = 'ab ' + [char]0x4F60 + [char]0x597D + ' x>y'
  [IO.File]::WriteAllText($textFile, $sample, [Text.Encoding]::UTF8)
  $out = & powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File "$PSScriptRoot\console-type.ps1" -TargetPid $childPid -TextFile $textFile
  Write-Output "console-type: $out"
  Start-Sleep -Milliseconds 1500
  if (Test-Path $log) {
    Write-Output '--- raw reader saw (byte arrays, UTF-8) ---'
    Get-Content $log | ForEach-Object { Write-Output $_ }
  } else {
    Write-Output 'selftest-fail: reader log missing'
    exit 1
  }
} finally {
  try { Stop-Process -Id $childPid -Force -ErrorAction Stop } catch { }
  Remove-Item (Join-Path $env:TEMP 'cf-console-type-raw.txt') -ErrorAction SilentlyContinue
}
