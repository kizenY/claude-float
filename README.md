# claude-float

[English](README.md) · [简体中文](README.zh-CN.md)

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Built with](https://img.shields.io/badge/built%20with-Electron-47848f)

An always-on-top floating widget for **Claude Code** and **Codex** (the CLIs) on Windows. See all your sessions at a glance, have the latest reply read aloud, and answer without ever leaving your current window.

<p align="center"><img src="docs/screenshot.png" width="320" alt="claude-float screenshot"></p>

## Why

Claude Code runs in a terminal, which means switching windows just to check whether Claude finished, what it said, or to type back one sentence. This widget stays pinned in a corner and does the three things you actually do all the time:

1. **Glance** — is Claude working, waiting for my answer, or done?
2. **Listen** — read the latest reply aloud while you keep typing in your editor
3. **Reply** — send one-liners straight into the session, no window switch

## Features

- **Claude / Codex, one click apart** — the header toggle switches the whole widget between the two: session list, theme color, quick-launch command and reply plumbing
- **Session list** — reads `~/.claude/projects/*/*.jsonl` (read-only), shows your recent sessions
- **Live status** per session: **Working** / **Waiting for you** (Claude asked a question, plan approval, long-running tool call) / how long ago the last reply came. Prefers the status Claude Code itself writes to `~/.claude/sessions/<pid>.json`; falls back to guessing from the transcript when the session isn't running
- **Click a row**:
  - session still running → toggle its terminal between foreground/background (click again while in front to minimize)
  - session already exited → opens a fresh PowerShell terminal in the session's original directory and runs `claude --resume <id>`
- **Read aloud** (speaker icon) — speaks the latest reply; click again, click the stop button, or press `Esc` to stop. Markdown is cleaned up before speaking: code blocks become "code omitted", links speak their text only, paths speak just the filename, tables are read row by row
- **Quick reply** (orange arrow, sessions started with `cf`) — type in the widget, `Enter` to send / `Shift+Enter` newline / `Esc` cancel. Messages go into the session through Claude Code's official [Channels](https://code.claude.com/docs/en/channels) (research preview) — no window switching, no keystroke simulation into your terminal. Idle Claude replies immediately; a busy Claude gets it on the next turn
- **Quick launch** — bottom buttons start a new `cf` session in your favorite directories (new PowerShell window; the window stays at the prompt after Claude exits so you can scroll back)
- **Widget niceties** — pin / collapse to a 40px bar / hide to tray; position, size and pinned state are remembered. Tray icon toggles visibility; tray menu has optional "run at login" (off by default)
- **Text-to-speech**: online neural voices by default (same voices as Edge "Read Aloud" — natural-sounding), or offline system voices as fallback

### Codex mode

The same widget, pointed at Codex CLI sessions (`~/.codex/sessions/**/rollout-*.jsonl`, read-only; honors `CODEX_HOME`):

- **Session list + status** — Codex has no live-session registry, so status (working / waiting for approval / idle) is inferred from the transcript tail, same heuristics spirit as the Claude fallback
- **Titles** — prefers the official thread names the desktop app writes to `~/.codex/session_index.jsonl`; pure-CLI sessions fall back to the first prompt
- **Click a row** — live session → focus/minimize its terminal; exited session → fresh PowerShell in the original directory running `codex resume <id>`
- **Quick reply** — Codex has no channels equivalent; while the session is still running in a terminal, the widget types straight into its console via `WriteConsoleInputW` (no focus steal, no clipboard). A session is matched to its process by comparing the rollout's session-creation timestamp with `codex` process start times (the process must predate the session by ≤15 min — the first launch in a new directory waits on a trust prompt, which delays session creation by minutes); sessions started from the Codex Desktop app have no console and can't be quick-replied — resume them instead
- **Quick launch** — the bottom buttons start `codex` in your quick-launch directories

## Quick start

**Prerequisites**: Windows 10/11, Node.js 20+, [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview) installed and working in a terminal. Codex support needs the [Codex CLI](https://developers.openai.com/codex/) on `PATH` (optional).

```bash
git clone https://github.com/kizenY/claude-float.git
cd claude-float
npm install
claude mcp add -s user claude-float -- node <path-to-repo>/channel/server.js   # enables quick reply
npm start
```

For daily use, launch `start.vbs` (no console window flashes). To start it at login, use the tray menu → 「开机自动运行」(writes to `HKCU\...\CurrentVersion\Run`, uncheck to remove).

> The `claude mcp add` line registers the channel server at user scope, so every Claude session can load it. Only sessions started via `cf` (below) actually enable the channel — the widget only shows the reply button for those. To unregister: `claude mcp remove claude-float`.

### The `cf` launcher

`cf.cmd` in the repo starts Claude Code with the channel enabled:

```
cf [any normal claude arguments]
```

The first launch shows a one-time development-channels warning — pick "I am using this for local development". Sessions not started with `cf` show a dimmed reply button; there's no way to attach a channel to an already-running session.

## Configuration

### Quick-launch directories

`~/.claude-float/quick-dirs.json`:

```json
[
  { "name": "proj-a", "path": "D:\\work\\proj-a" },
  { "name": "lab", "path": "D:\\lab" }
]
```

Without this file you get a single `home` button. Restart the widget after editing.

### Environment variables

| Variable | Purpose |
|---|---|
| `CLAUDE_FLOAT_PROJECTS` | Comma-separated keywords; only show sessions whose project directory name matches, e.g. `pawkit,lab` |
| `CLAUDE_FLOAT_CODEX_EXCLUDE` | Codex mode: comma-separated keywords; hide sessions whose working directory matches. Defaults to the author's `e:\agent-cluster` (other agents on the same machine share `~/.codex/sessions`) |
| `CLAUDE_FLOAT_SPAWN_CMD` | Debug: launch this instead of `cf.cmd` from quick-launch |
| `CLAUDE_FLOAT_SNAPSHOT` | Debug: save a screenshot to this path on startup |
| `CLAUDE_FLOAT_QUIT_AFTER_SNAPSHOT` | Debug: quit right after saving the screenshot (scripted smoke tests) |

### Voices

Pick voice and rate at the bottom. Online neural voices go to Microsoft's speech service (`speech.platform.bing.com`) — the same unofficial endpoint Edge's Read Aloud uses, so it may break when Microsoft changes it. If unreachable, the widget automatically finishes the sentence with an offline system voice and shows a notice; it tries direct connection first, then `HTTPS_PROXY`.

## How quick reply works

`channel/server.js` is an MCP server that Claude Code launches with the session. It listens on a random `127.0.0.1` port and registers the session in `~/.claude-float/channels/<pid>.json` with a one-time secret. The widget reads those registration files, and pushes your text into the session via the `notifications/claude/channel` MCP notification. Everything stays on localhost; the secret is per-session and single-use.

If the channel notification doesn't land (some Claude Code versions silently drop it — [issue #44181](https://github.com/anthropics/claude-code/issues/44181)), the widget automatically falls back to typing into the session's real console via `WriteConsoleInputW` (no focus steal, no clipboard), and only then to focus + paste + Enter.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Reply button is dimmed | The session wasn't started with `cf`. Close it and start again with `cf` |
| A warning about development channels on `cf` launch | Expected once per session; choose "I am using this for local development" |
| Reply sent but Claude never answers | Check your Claude Code version against [issue #44181](https://github.com/anthropics/claude-code/issues/44181); the widget falls back to console typing, which needs the session's terminal window to still exist |
| No sessions listed | The widget reads `~/.claude/projects/*/*.jsonl` — make sure you've run `claude` at least once, and check `CLAUDE_FLOAT_PROJECTS` isn't filtering everything out |
| Codex reply button dimmed | The Codex session isn't running in a terminal anymore (or was started from the Desktop app). Click the row to `codex resume` it, then reply |
| No Codex sessions listed | Make sure you've run `codex` at least once; check `CLAUDE_FLOAT_CODEX_EXCLUDE` / `CLAUDE_FLOAT_PROJECTS` aren't filtering them out |
| Codex session in a new directory shows as "not running" | The first launch in a new directory shows a trust prompt and the session is only created after you confirm. Confirm once in the terminal and the directory works normally from then on |
| Online voice stopped working | The unofficial Edge endpoint changed or is blocked; the widget falls back to system voices automatically. Check `HTTPS_PROXY` if you're behind a proxy |
| Window won't appear | Look for the orange tray icon; single-click toggles visibility |

## Development

```bash
npm test        # plain Node tests, no Electron needed
npm start       # launch the widget
```

```
main.js             Electron main process: window, tray, IPC
renderer.js         widget UI + speech orchestration
sessions.js         reads ~/.claude/projects transcripts + status guessing
codex-sessions.js   reads ~/.codex/sessions rollouts + status guessing + live-process matching
channel/server.js   Claude Code channel server (quick-reply entry point)
cf.cmd / spawn-cf.vbs / start.vbs   launchers (several Windows console-handle
                    pitfalls are documented in code comments)
```

## License

[MIT](LICENSE)
