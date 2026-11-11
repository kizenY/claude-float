# Install claude-float + trine as one stack

This is the index for the **claude-float + trine** setup: a local always-on-top
widget for Claude Code on Windows, plus a self-hosted phone/remote UI for the
same sessions. The widget keeps the desktop half (pet, tray, quick reply); trine
owns the remote half (web/PWA, session list, task tickets, usage), and both share
the same data files.

## Two ways to install

1. **Widget only** — you want the floating panel, read-aloud and quick reply on
   one Windows machine. Follow "Quick start" in [README.md](../README.md); you
   never need trine, a server or a domain.
2. **The whole stack** — you also want the same sessions on your phone, task
   tickets and usage in a browser, with the widget reduced to the pet + tray.
   Follow this page top to bottom: relay → Windows agent → widget → extensions →
   binding. Budget ~30 minutes if you already have a domain pointed at a Linux
   VPS; the relay is the only part that needs a server.

If you are an agent asked to "install this whole set", follow the checklist at the
end in order. Everything here is Windows-agent + Linux-relay; upstream trine does
not validate Windows, this fork is the one that is actually run there daily.

## Pieces and where they live

| Piece | Repository / branch | Runs on |
| --- | --- | --- |
| Widget + MCP bridge + official extensions | `https://github.com/kizenY/claude-float` (`master`) | Windows desktop |
| trine relay (web UI + API) | `https://github.com/kizenY/trine` (`web-push`) | Linux VPS behind Caddy |
| trine agent | same fork, `web-push` | Windows desktop (same machine as claude-float) |
| `exts/todos`, `exts/usage` | inside claude-float; each directory carries both `float-extension.json` and `trine-extension.json` | both hosts |

`kizenY/trine` is a fork of [`smokecat/trine`](https://github.com/smokecat/trine).
The `web-push` branch adds the Windows-side work used here:

- session titles: reads Claude Code's `ai-title` records and generates a title for
  SDK-started sessions (they never get one upstream)
- cost: a local price table for gateway/third-party models (`deepseek-*`, `glm-*`),
  because Claude Code bills those at Anthropic rates and over-reports several times
- a USD/CNY currency toggle for every cost number
- DeepSeek models seeded in the model picker
- per-device session mute and session titles in push notifications
- PWA `launch_handler` / `handle_links`, so a deep link reuses the installed window
- Windows background-launch and restart scripts (`start-agent.example.vbs`,
  `restart-agent.cmd`)

## Prerequisites

- Windows 10/11 with [Node.js 20+](https://nodejs.org/), [Bun 1.3.11](https://bun.sh/)
  and a working Claude Code CLI in a terminal
- A Linux host (VPS is fine) with a domain pointing at it, Caddy, SQLite CLI and Bun
- Ports: the relay listens on loopback only; Caddy terminates TLS on 443

## 1. Relay

The relay is a small Bun service; it only accepts outbound connections from your
machines. It needs a Linux host (a cheap VPS is fine), a domain, Caddy and a Bun
binary at `/usr/local/bin/bun`.

Create the service account and release directory first (this is step 1 of the
upstream deploy guide), then clone the fork so the relay and the agent run the
same revision:

```bash
sudo useradd --system --home-dir /var/lib/trine --shell /usr/sbin/nologin trine
sudo install -d -m 750 -o trine -g trine /var/lib/trine /opt/trine-releases
sudo install -d -m 750 -o root -g trine /etc/trine

sudo -u trine git clone -b web-push https://github.com/kizenY/trine.git /opt/trine-releases/initial
cd /opt/trine-releases/initial
sudo -u trine -H /usr/local/bin/bun install --frozen-lockfile
sudo -u trine -H /usr/local/bin/bun run build
sudo ln -s /opt/trine-releases/initial /opt/trine
```

Then follow steps 2–3 of
[`apps/server/deploy/README.md`](https://github.com/kizenY/trine/blob/web-push/apps/server/deploy/README.md)
verbatim: the env file, the systemd unit, loopback binding, and the Caddyfile with
your domain. Check `https://<your-domain>/healthz`.

Create the first agent invitation **on the relay**, in a private SSH terminal:

```bash
cd /opt/trine
sudo -u trine /usr/local/bin/bun run agent:invite create --db /var/lib/trine/trine.sqlite
```

It prints the credential once. Treat it as a password: never put it in a command
argument, a URL, an environment variable or a chat message.

## 2. trine agent on the Windows machine

```bat
git clone -b web-push https://github.com/kizenY/trine.git C:\path\to\trine
cd /d C:\path\to\trine
bun install --frozen-lockfile
bun run build
set TRINE_DEFAULT_MODEL=sonnet
bun run dev:agent -- --server https://<your-domain> --home %USERPROFILE%\.trine --enroll --pair
```

Paste the invitation at the hidden prompt. The browser pairing payload and the
agent's short code must match before you approve. After this, start it without
`--enroll --pair`; the identity is in `~/.trine/`.

### Run it in the background

Copy the sample launcher and edit the two paths/URLs in it:

```bat
copy start-agent.example.vbs start-agent.vbs
notepad start-agent.vbs
```

Register a one-shot logon task (this is what the sample's comments call
`TrineAgent`). Run this from an **elevated** Command Prompt — `/rl highest` needs
it:

```bat
schtasks /create /tn TrineAgent /tr "wscript.exe C:\path\to\trine\start-agent.vbs" /sc onlogon /rl highest
schtasks /run /tn TrineAgent
```

If the checkout path contains spaces, create the task in Task Scheduler instead
(wscript.exe as the program, the quoted `.vbs` path as its argument); `schtasks`
mangles nested quotes.

Because the task is a one-shot launcher, not a supervisor, trine's in-app
"restart agent" is unavailable (`machine.info.restart.available=false`). After
updating the checkout, double-click `restart-agent.cmd`: it stops the running bun
agent, removes a stale `~/.trine/control.sock`, and runs the task again. Every
session hosted by the agent is a child process and is disconnected; resume them
from the session list afterwards.

`start-agent.vbs` is per-machine (it contains your relay URL and paths) and is
git-ignored in the fork. Only `start-agent.example.vbs` is committed.

## 3. claude-float

```bat
git clone https://github.com/kizenY/claude-float.git C:\path\to\claude-float
cd /d C:\path\to\claude-float
npm install
claude mcp add -s user claude-float -- node C:\path\to\claude-float\channel\server.js
npm start
```

The MCP registration is what enables quick reply (and the `todos_*` tools in any
session). `cf.cmd` is optional: put it on `PATH` and use `cf` instead of `claude`
for sessions that need the channel from launch.

## 4. Install the shared extensions on both hosts

Both extension directories are dual-manifest. Install the **same directory** into
both hosts; they read and write the same files, so a task or usage panel looks
identical on the desktop and on the phone.

```bat
:: claude-float
cd /d C:\path\to\claude-float
node ext.js add exts/todos
node ext.js add exts/usage

:: trine agent (works whether the agent is running or stopped)
cd /d C:\path\to\trine
bun run dev:agent -- ext add C:\path\to\claude-float\exts\todos --home %USERPROFILE%\.trine
bun run dev:agent -- ext add C:\path\to\claude-float\exts\usage --home %USERPROFILE%\.trine
```

Data and secrets:

- tasks: `~/.claude-float/todos.json` (shared by both hosts)
- GLM usage: `~/.claude-float/glm.json` → `{ "apiKey": "..." }`
  (Z.ai users add `"endpoint": "https://api.z.ai"`)

## 5. Bind the widget to trine

Create `~/.claude-float/trine.json`:

```json
{ "url": "https://<your-domain>" }
```

`machineId` is optional; it is read from `~/.trine/identity.json` when present.
With this file:

- the main window stops staying open; clicking the pet opens trine's home
- pet-tray session cards raise the installed trine app on that session
  (`"app": "C:\\path\\to\\trine.lnk"` to pin it, `"app": false` to disable)
- the `＋` buttons and "start a session" open trine's new-session sheet
- quick reply keeps working for sessions that registered a channel
- sessions, task tickets and usage are visible from the phone/PWA

The widget's built-in trine window is its own device identity, so the first open
needs a pairing. With the agent running:

```bat
cd /d C:\path\to\trine
bun run dev:agent -- pair --home %USERPROFILE%\.trine
```

Compare the short code with the browser and type `y` only if it matches.

## Optional: accurate cost for third-party models

Claude Code prices unknown model names as Anthropic models, which over-reports
gateway models by several times. Put a price table at `~/.trine/pricing.json`;
the agent then computes cost from token counts itself (USD per **million** tokens):

```json
{
  "peakHoursUtc": [[1, 4], [6, 10]],
  "peakWeekdaysOnly": true,
  "models": {
    "deepseek-flash": {
      "peak":    { "input": 0.28, "output": 0.42, "cacheRead": 0.028, "cacheWrite": 0.28 },
      "offPeak": { "input": 0.14, "output": 0.28, "cacheRead": 0.014, "cacheWrite": 0.14 }
    },
    "glm-4.6": { "input": 0.6, "output": 2.2, "cacheRead": 0.11, "cacheWrite": 0.6 }
  }
}
```

Rules:

- one rate set = flat all day; `peak` / `offPeak` = two windows, chosen by
  `peakHoursUtc` (UTC, left-closed/right-open) and `peakWeekdaysOnly`
- models not in the table keep the SDK-reported cost
- no file = exactly upstream behavior; the numbers above are examples, check your
  provider's current prices
- the UI cost number toggles USD/CNY on click; the rate defaults to 7.1 and can be
  overridden with `localStorage["trine.usdToCny"]`

## Optional: session titles

Nothing to configure. The agent reads `~/.claude/settings.json`'s `env` block
(`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL`) and asks that endpoint for a short title after
the first turn. Titles live in `~/.trine/sessions.json`, never in the transcript;
a user `/rename` still wins. If the call fails, the first prompt is shown.

## Daily use

- Start the widget with `npm start` in the claude-float checkout; the tray menu
  has "run at login" if you want it every day
- Start sessions with `cf` instead of `claude` when you want quick reply (put
  `cf.cmd` on `PATH`); both launch the same CLI
- On the phone, open `https://<your-domain>`, pair once and "add to home screen";
  the PWA shows the same sessions, task tickets and usage
- Longer tasks: tell the session "建个任务：…，目标是…" (or it calls `todos_add`);
  the ticket shows up in the widget panel and in trine within 15 seconds
- After updating the trine checkout, double-click `restart-agent.cmd`; after
  updating claude-float, restart the widget

## Verify

1. `curl -f https://<your-domain>/healthz` succeeds
2. the machine appears online in trine; "检查更新" shows the checkout's revision
3. a session started locally shows up on the phone and can be replied to
4. `todos_add` in a session appears in the float panel and the trine session panel
   within 15 seconds
5. the usage panel shows both reset windows on both hosts
6. with `trine.json` present, clicking the pet opens trine instead of the widget

## Agent checklist (condensed)

```text
1. relay:  clone -b web-push → bun install → bun run build → deploy README steps 2–3
           → agent:invite create (credential stays out of logs)
2. agent:  clone -b web-push → bun install → bun run build
           → dev:agent -- --server ... --home ~/.trine --enroll --pair
           → copy start-agent.example.vbs start-agent.vbs; schtasks /create ... TrineAgent
3. float:  clone → npm install → claude mcp add -s user ... channel/server.js → npm start
4. exts:   node ext.js add exts/todos; node ext.js add exts/usage
           bun run dev:agent -- ext add <float>/exts/todos --home ~/.trine
           bun run dev:agent -- ext add <float>/exts/usage --home ~/.trine
5. bind:   ~/.claude-float/trine.json = { "url": "https://..." }
           bun run dev:agent -- pair --home ~/.trine   (first built-in-window pairing)
6. cost:   optional ~/.trine/pricing.json for deepseek-*/glm-*
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Machine offline after reboot | run `schtasks /run /tn TrineAgent`; check the task's "run whether user is logged on" setting |
| Agent starts then exits | another instance holds `~/.trine/agent.lock`; `restart-agent.cmd` stops it |
| Pairing code never appears | the agent is not running, or `control.sock` is stale — restart with `restart-agent.cmd` |
| Deep link opens a new tab instead of the app | the PWA was installed before the `launch_handler` change; reinstall it from the browser |
| Cost looks 5–7× too high | `~/.trine/pricing.json` missing or the model name does not match; restart the agent |
| Task panel empty on one side | install the same `exts/todos` directory on both hosts; both read `~/.claude-float/todos.json` |
