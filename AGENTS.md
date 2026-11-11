# Agent entry point

This repository is a Windows always-on-top widget for Claude Code/Codex sessions.
It can run alone, or bound to **trine** as one stack (local widget + phone/web UI).

## If you were asked to install "the whole set"

Follow **[docs/TRINE.md](docs/TRINE.md)** — it is the ordered install index:
relay → Windows trine agent → claude-float → shared extensions → `trine.json`
binding → verification. The same file contains the condensed command checklist,
config file formats and troubleshooting.

Key facts you need before starting:

- the trine half is the fork `https://github.com/kizenY/trine`, branch `web-push`
  (not upstream `smokecat/trine`): the widget's remote features assume its extra
  commits (session titles, local cost pricing, currency toggle, Windows scripts)
- the relay lives on a Linux host; the agent and widget live on the same Windows
  machine
- `exts/todos` and `exts/usage` are dual-manifest: the same directory is installed
  into both hosts (`node ext.js add` and `trine-agent ext add`)
- personal values stay out of the repository: relay URL and machine paths belong in
  `start-agent.vbs` / `trine.json`, API keys in `glm.json` or the environment

## If you were asked to change the widget

- plain Electron + Node, no bundler: `main.js` (main process), `renderer.js` (UI),
  `extensions.js` (extension host), `channel/server.js` (MCP bridge)
- tests: `npm test`
- never commit personal paths, relay URLs or credentials; this is a public repo
