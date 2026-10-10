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

rem --- jev-gateway hook (2026-10-10) ------------------------------------------
rem If the local jev-gateway is up (E:/develop/code/jev-gateway), route this session's
rem API through it: Jev scores each question, simple -> Haiku, complex -> Opus.
rem Gateway NOT running = curl fails = plain direct session, zero impact on daily use.
rem Misbehaving gateway? Run jev-gateway\stop.cmd and cf goes back to direct.
rem HOW: user settings.json's env block (bigmodel) OVERRIDES process env vars at startup,
rem so the ONLY reliable channel is --settings with a gateway profile (CLI --settings
rem outranks user settings.json). The profile uses ANTHROPIC_AUTH_TOKEN - NOT
rem ANTHROPIC_API_KEY, which triggers Claude Code's "custom API key" approval prompt
rem on every fresh session. Auth is a bearer token the gateway validates (JEG_API_KEY).
set "JEG_ARGS="
curl -s -m 1 -o nul http://127.0.0.1:8787/health 2>nul
if not errorlevel 1 (
    set "JEG_ARGS=--settings E:\develop\code\jev-gateway\claude-jeg-settings.json"
)
claude --channels server:claude-float %JEG_ARGS% %*
