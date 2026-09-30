@echo off
rem Start Claude Code with the Claude float channel, so the widget can quick-reply to this session.
rem Usage: cc [any normal claude arguments]
claude --mcp-config "%~dp0channel\mcp.json" --dangerously-load-development-channels server:claude-float %*
