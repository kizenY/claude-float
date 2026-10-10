# Self-test for console-type.ps1: spawn a hidden cmd, type a marker command
# into its console via console-type.ps1, then verify the command really ran
# (marker file appears). Proves AttachConsole + WriteConsoleInputW end-to-end
# without touching any real session window. KEEP ASCII-ONLY (WinPS 5.1).
$ErrorActionPreference = 'Stop'
$marker  = Join-Path $env:TEMP 'cf-console-type-selftest.out'
$cmdFile = Join-Path $env:TEMP 'cf-console-type-selftest.txt'
Remove-Item $marker -ErrorAction SilentlyContinue
[IO.File]::WriteAllText($cmdFile, "echo CFTEST-OK> `"$marker`"", [Text.Encoding]::UTF8)

# spawn via cmd "start" so the child gets its OWN console on our window station
# (WMI spawn lands on the service winsta where console input goes nowhere;
# Start-Process would share OUR console and make the target ambiguous).
& cmd.exe /c 'start "" /min cmd.exe /k "rem cfselftest-marker"'
Start-Sleep -Milliseconds 800
$proc = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains('cfselftest-marker') } |
  Select-Object -First 1
if (-not $proc) { Write-Output 'selftest-fail: spawned cmd not found'; exit 1 }
$childPid = [int]$proc.ProcessId
try {
  Start-Sleep -Milliseconds 800
  $out = & powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File "$PSScriptRoot\console-type.ps1" -TargetPid $childPid -TextFile $cmdFile
  if ($out -ne 'ok') { Write-Output "selftest-fail: console-type reported: $out"; exit 1 }
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $marker)) { Start-Sleep -Milliseconds 200 }
  if (Test-Path $marker) {
    Write-Output 'selftest-ok'
  } else {
    Write-Output 'selftest-fail: marker file never appeared'
    exit 1
  }
} finally {
  try { Stop-Process -Id $childPid -Force -ErrorAction Stop } catch { }
  Remove-Item $cmdFile -ErrorAction SilentlyContinue
  Remove-Item $marker -ErrorAction SilentlyContinue
}
