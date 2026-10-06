@echo off
rem Start Claude Code with the Claude float channel, so the widget can quick-reply to this session.
rem Usage: cf [any normal claude arguments]
rem (named cf - "cc" collides with MSVC's C compiler driver cc.exe, which wins in PATH)
rem The claude-float MCP server is registered at user scope (claude mcp add -s user), so plain
rem `claude` loads it too; CLAUDE_FLOAT_CHANNEL=1 marks this session as channel-enabled, and
rem --dangerously-load-development-channels is what actually lets channel messages in.
set CLAUDE_FLOAT_CHANNEL=1
claude --dangerously-load-development-channels server:claude-float %*
