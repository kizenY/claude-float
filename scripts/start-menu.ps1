# Add or remove a Start Menu shortcut ("claude-float") so Windows search can find the widget.
# Usage:
#   powershell -File scripts\start-menu.ps1          # add (default)
#   powershell -File scripts\start-menu.ps1 -Remove  # remove
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$lnkPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\claude-float.lnk'
$vbs = Join-Path $repo 'start.vbs'

if ($Remove) {
    if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force; Write-Output "removed: $lnkPath" }
    else { Write-Output "not found: $lnkPath" }
    exit 0
}

if (-not (Test-Path $vbs)) { throw "start.vbs not found next to scripts\: $vbs" }
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($lnkPath)
$lnk.TargetPath = $vbs
$lnk.WorkingDirectory = $repo
$exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
if (Test-Path $exe) { $lnk.IconLocation = "$exe,0" }
$lnk.Description = 'Claude broadcast widget'
$lnk.Save()
Write-Output "created: $lnkPath (press Win and search claude-float)"
