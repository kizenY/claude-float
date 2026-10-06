@echo off
rem Start Claude Code with the Claude float channel, so the widget can quick-reply to this session.
rem Usage: cf [any normal claude arguments]
rem (named cf - "cc" collides with MSVC's C compiler driver cc.exe, which wins in PATH)
claude --mcp-config "%~dp0channel\mcp.json" --dangerously-load-development-channels server:claude-float %*
