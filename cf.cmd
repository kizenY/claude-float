@echo off
rem Start Claude Code with the Claude float channel, so the widget can quick-reply to this session.
rem Usage: cf [any normal claude arguments]
rem (named cf - "cc" collides with MSVC's C compiler driver cc.exe, which wins in PATH)
rem The claude-float MCP server is registered at user scope (claude mcp add -s user), so plain
rem `claude` loads it too; server.js tells channel mode apart by reading the parent claude's
rem command line (claude hands MCP children a curated env, so a set-mark here would not arrive).
rem --channels loads it from the approved list WITHOUT the interactive warning that
rem --dangerously-load-development-channels shows on every launch — that warning waits for
rem Enter and silently blocks float-spawned sessions (2026-10 排查过的坑).
claude --channels server:claude-float %*
