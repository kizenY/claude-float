# cfh.ps1 - hand off the newest Claude session in cwd to Happy (phone control).
# Run AFTER /exit-ing the local cf/claude session. If the target session is still
# running, claude silently starts a fresh one instead (locked sessions can't resume).
$d = (Get-Location).Path -replace '[^a-zA-Z0-9]','-'
$f = Get-ChildItem "$env:USERPROFILE\.claude\projects\$d\*.jsonl" -ErrorAction SilentlyContinue |
     Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $f) { Write-Host "[cfh] No session found for this directory."; exit 1 }
Write-Host "[cfh] Resuming session $($f.BaseName) via Happy (fork)..."
# --fork-session is REQUIRED: happy prepends its own --session-id, and claude rejects
# --session-id + --resume without it (happy 0.12.0 + claude 2.1.116, 2026-10-07 实测).
# The fork lands under happy's tracked id with full history — exactly what we want.
& happy --resume $f.BaseName --fork-session
