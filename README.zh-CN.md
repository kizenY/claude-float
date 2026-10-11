# claude-float · Claude 播报

[English](README.md) · [简体中文](README.zh-CN.md)

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Built with](https://img.shields.io/badge/built%20with-Electron-47848f)

Windows 上一个置顶的小浮窗，给 **Claude Code / Codex**（命令行）用：会话状态一览、朗读最新回复、不用切窗口直接回复。

<p align="center"><img src="docs/screenshot.png" width="320" alt="claude-float 截图"></p>

## 解决什么问题

Claude Code 跑在终端里，看一眼它说完没有、回一句话，都得切窗口。这个浮窗钉在角落，把你最高频的三件事留在手边：

1. **瞄一眼** —— Claude 在干活、在等我拍板、还是说完了？
2. **听一下** —— 朗读最新回复，手不用离开编辑器
3. **回一句** —— 直接把一句话塞进会话，不碰窗口

## 功能

- **Claude / Codex 一键切换** —— 标题栏的开关一键换形态：会话列表、主题色、快捷启动命令、回复通道整套跟着切
- **会话列表**：读 `~/.claude/projects/*/*.jsonl`（只读），列出最近会话
- **状态标注**：每个会话显示 **进行中**（Claude 在干活）/ **等待回复**（Claude 在问你、等你确认计划，多半在等你批准）/ 最后一条回复是多久之前。状态优先用 Claude Code 自己写的 `~/.claude/sessions/<pid>.json`，会话没在跑时才从会话记录推测
- **点会话那一行**：
  - 会话还在跑 → 把它的终端窗口在前台/后台间切换（已在前台再点一下就最小化）
  - 会话已结束 → 新开一个 PowerShell 终端，回到会话原目录用 `claude --resume` 恢复
- **朗读**（喇叭按钮）：朗读这个会话的最新回复；再点一次、点标题栏的方块或按 `Esc` 停止。朗读前会清理 Markdown：代码块读成「代码略」，链接只读文字，路径只读文件名，表格按行读
- **快速回复**（橙色箭头，仅限 `cf` 启动的会话）：在浮窗里打字，`Enter` 发送 / `Shift+Enter` 换行 / `Esc` 取消。消息通过 Claude Code 官方的 [Channels](https://code.claude.com/docs/en/channels)（研究预览）直接推进会话——不切窗口、不往终端里模拟按键。Claude 空闲会马上回复，正忙会排到下一轮
- **快捷启动**：底部按钮一键在常用目录起一个 `cf` 会话（新 PowerShell 终端，claude 退出后窗口留在提示符方便回看）
- **窗口**：图钉置顶 · 横线收起成一条 · 叉隐藏到托盘；位置、大小、置顶状态会记住。托盘图标（橙色圆点）单击显示/隐藏，右键菜单可开关「开机自动运行」（默认关）和退出
- **语音**：默认在线神经语音（和 Edge「大声朗读」同一套，晓晓 / 云希等，接近真人），连不上自动降级系统离线语音

### Codex 形态

同一个浮窗，指向 Codex CLI 的会话记录（`~/.codex/sessions/**/rollout-*.jsonl`，只读，支持 `CODEX_HOME`）：

- **会话列表 + 状态**：Codex 没有活会话登记表，状态（进行中 / 等你批准 / 空闲）从记录尾部推断，思路和 Claude 的降级路径一致
- **点会话那一行**：还在跑 → 切换它的终端前台/后台；已结束 → 在原目录新开 PowerShell 跑 `codex resume <id>`
- **快速回复**：Codex 没有 channels 等价物；会话还开在终端里时，直接用 `WriteConsoleInputW` 往它的控制台打字（不抢焦点、不碰剪贴板）。会话和进程靠「rollout 里的会话启动时间 ≈ codex 进程启动时间」（±20 秒）匹配；从 Codex 桌面端起的会话没有控制台，没法直接回，点行恢复即可
- **快捷启动**：底部按钮在常用目录起 `codex`

## 快速开始

**前提**：Windows 10/11，Node.js 20+，[Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview) 已装好且终端里能用；要用 Codex 形态再装 [Codex CLI](https://developers.openai.com/codex/)（可选）。

```bash
git clone https://github.com/kizenY/claude-float.git
cd claude-float
npm install
claude mcp add -s user claude-float -- node <仓库路径>/channel/server.js   # 快速回复要用
npm start
```

日常使用双击 `start.vbs`（不弹命令行窗口）。想开机自动打开：托盘菜单勾选「开机自动运行」（写入 `HKCU\...\CurrentVersion\Run`，取消勾选就删掉）。

> `claude mcp add` 那行把频道 server 注册到 user scope，所有 claude 会话都会加载它；但只有用 `cf` 启动的会话真正开了频道，浮窗也只给这种会话显示回复按钮。想撤销注册：`claude mcp remove claude-float`。

### `cf` 启动器

仓库里的 `cf.cmd` 会带着频道启动 Claude Code：

```
cf [任何 claude 参数]
```

首次启动会弹一个开发频道的警告，选「I am using this for local development」继续。不是用 `cf` 启动的会话，回复按钮是半透明的；已经跑起来的会话没法补频道，下次用 `cf` 启动即可。

## 配置

### 快捷启动目录

`~/.claude-float/quick-dirs.json`：

```json
[
  { "name": "项目A", "path": "D:\\work\\proj-a" },
  { "name": "lab", "path": "D:\\lab" }
]
```

没有这个文件就只显示一个 home 按钮。改完配置重启浮窗生效。

### 环境变量

| 变量 | 作用 |
|---|---|
| `CLAUDE_FLOAT_PROJECTS` | 逗号分隔的关键字，只显示项目目录名包含这些关键字的会话，如 `pawkit,lab` |
| `CLAUDE_FLOAT_CODEX_EXCLUDE` | Codex 形态：逗号分隔的关键字，工作目录命中即隐藏。默认 `e:\agent-cluster`（同一台机器上其他 Agent 共用 `~/.codex/sessions`，不串台） |
| `CLAUDE_FLOAT_SPAWN_CMD` | 调试：快捷启动改拉这个命令，排查 spawn 问题时用 |
| `CLAUDE_FLOAT_SNAPSHOT` | 调试：启动后截图到该路径 |
| `CLAUDE_FLOAT_QUIT_AFTER_SNAPSHOT` | 调试：截图完自动退出（脚本化 smoke 用） |

### 语音

底部可选声音和语速。在线语音走微软的语音服务（`speech.platform.bing.com`），和 Edge「大声朗读」同一套非官方接口，微软改了可能失效。连不上时自动用系统语音读完剩下的，标题栏会提示；优先直连，失败再走 `HTTPS_PROXY`。

## 快速回复的原理

`channel/server.js` 是个 MCP server，由 Claude Code 随会话拉起。它在 `127.0.0.1` 随机端口上等消息，把会话登记到 `~/.claude-float/channels/<pid>.json`（含每会话一个的一次性密令）。浮窗读这些登记文件，通过 `notifications/claude/channel` MCP 通知把你的文字推进会话。全程只在 localhost，密令每个会话独立、一次性。

频道通知送不到时（某些 Claude Code 版本会静默吞掉，见 [issue #44181](https://github.com/anthropics/claude-code/issues/44181)），浮窗自动降级：先用 `WriteConsoleInputW` 往会话的真实控制台注入按键（不抢前台、不碰剪贴板），还不行才聚焦 + 粘贴 + 回车。

## 常见问题

| 现象 | 处理 |
|---|---|
| 回复按钮是半透明的 | 会话不是用 `cf` 启动的。退出后用 `cf` 重新启动 |
| `cf` 启动时弹开发频道警告 | 每个会话一次，正常现象；选「I am using this for local development」 |
| 回复发出去 Claude 没反应 | 对一下 Claude Code 版本是否中了 [issue #44181](https://github.com/anthropics/claude-code/issues/44181)；浮窗会降级到控制台注入，前提是那个会话的终端窗口还在 |
| 列表里没有会话 | 浮窗读 `~/.claude/projects/*/*.jsonl`——确认至少跑过一次 `claude`，再检查 `CLAUDE_FLOAT_PROJECTS` 是不是把会话全过滤掉了 |
| Codex 回复按钮是半透明的 | 这个 Codex 会话已经不在终端里跑了（或是桌面端起的）。点列表行 `codex resume` 恢复后再回 |
| Codex 列表里没有会话 | 确认至少跑过一次 `codex`；再检查 `CLAUDE_FLOAT_CODEX_EXCLUDE` / `CLAUDE_FLOAT_PROJECTS` 是不是把会话过滤掉了 |
| 在线语音突然不响 | 非官方接口失效或被墙；浮窗会自动降级系统语音。走了代理的检查 `HTTPS_PROXY` |
| 浮窗不见了 | 找橙色托盘图标，单击切换显示/隐藏 |

## 开发

```bash
npm test        # 纯 Node 测试，不需要起 Electron
npm start       # 起浮窗
```

```
main.js             Electron 主进程：窗口、托盘、IPC
renderer.js         浮窗 UI 与朗读调度
sessions.js         读 ~/.claude/projects 会话记录 + 状态推测
codex-sessions.js   读 ~/.codex/sessions 会话记录 + 状态推测 + 活进程匹配
channel/server.js   Claude Code 频道 server（快速回复的入口）
cf.cmd / spawn-cf.vbs / start.vbs   启动脚本（Windows 控制台句柄的几个坑都写在代码注释里）
```

## License

[MIT](LICENSE)
