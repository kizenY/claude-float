@echo off
rem Start Claude Code with the Claude float channel, so the widget can quick-reply to this session.
rem Usage: cf [any normal claude arguments]
rem (named cf - "cc" collides with MSVC's C compiler driver cc.exe, which wins in PATH)
rem The claude-float MCP server is registered at user scope (claude mcp add -s user), so plain
rem `claude` loads it too; server.js tells channel mode apart by reading the parent claude's
rem command line (claude hands MCP children a curated env, so a set-mark here would not arrive).
rem --channels loads it from the approved list WITHOUT the interactive warning that
rem --dangerously-load-development-channels shows on every launch - that warning waits for
rem Enter and silently blocks float-spawned sessions (2026-10 issue, see git history).

rem --- optional routing-gateway hook -------------------------------------------
rem If ~/.claude-float/gateway.conf exists and the gateway answers its health check,
rem this session's API traffic goes through the gateway via --settings <profile>.
rem The conf has two lines (no quotes, ASCII):
rem   health=http://127.0.0.1:8787/health
rem   settings=C:\path\to\gateway-settings.json
rem Toggle: the widget's tray menu creates/deletes ~/.claude-float/gateway-off
rem (file exists = sessions go direct). No conf file = plain direct session, zero
rem gateway logic - that is the default for everyone else.
rem The settings profile must use ANTHROPIC_AUTH_TOKEN (NOT ANTHROPIC_API_KEY,
rem which triggers Claude Code's "custom API key" approval prompt on every session).
set "JEG_ARGS="
if exist "%USERPROFILE%\.claude-float\gateway-off" goto launch
if not exist "%USERPROFILE%\.claude-float\gateway.conf" goto launch
for /f "usebackq tokens=1,* delims==" %%a in ("%USERPROFILE%\.claude-float\gateway.conf") do (
    if /i "%%a"=="health" set "JEG_HEALTH=%%b"
    if /i "%%a"=="settings" set "JEG_SETTINGS=%%b"
)
if not defined JEG_HEALTH goto launch
if not defined JEG_SETTINGS goto launch
curl -s -m 1 -o nul "%JEG_HEALTH%" 2>nul
if not errorlevel 1 set "JEG_ARGS=--settings %JEG_SETTINGS%"
:launch
claude --channels server:claude-float %JEG_ARGS% %*
