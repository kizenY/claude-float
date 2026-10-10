# Send Ctrl+V + Enter to the current foreground window (the session terminal just
# focused by focus-window.ps1). Text rides the clipboard instead of SendKeys typing:
# SendKeys needs escaping for +^%{}~ and mangles CJK/emoji; paste has none of that.
# Fallback path for quick reply: Claude Code 2.1.x silently drops
# notifications/claude/channel (upstream issue #44181), reply.js uses this when the
# channel push does not land.
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 300  # let the focus settle, or the paste hits the wrong window
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output 'ok'
