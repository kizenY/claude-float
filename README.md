# claude-float · Claude 播报浮窗

Windows 上一个置顶的小浮窗：列出本机最近的 Claude Code（命令行）会话，状态一览、一键朗读最新回复、直接在浮窗里回复。跑在 Electron 上，只读会话记录，不碰你的 API。

## 能干什么

- **会话一览**：读 `~/.claude/projects/*/*.jsonl`（只读），列出最近会话
- **状态标注**：每个会话显示 **进行中**（Claude 在干活）/ **等待回复**（Claude 在问你、等你确认计划，多半在等你批准），否则显示最后一条回复是多久之前。状态优先用 Claude Code 自己写的 `~/.claude/sessions/<pid>.json`，会话没在跑时才从会话记录推测
- **点会话那一行**：
  - 会话还在跑 → 把它的终端窗口在前台/后台间切换（已在前台再点一下就最小化）
  - 会话已结束 → 新开一个 PowerShell 终端，回到会话原目录用 `claude --resume` 恢复
- **朗读**（喇叭按钮）：朗读这个会话的最新回复；再点一次、点标题栏的方块或按 `Esc` 停止。朗读前会清理 Markdown：代码块读成「代码略」，链接只读文字，路径只读文件名，表格按行读
- **快速回复**（只对用 `cf` 启动的会话）：会话右边的橙色箭头，或点会话那一行；底部输入框 Enter 发送、Shift+Enter 换行、Esc 取消。消息通过 Claude Code 官方的 [Channels](https://code.claude.com/docs/en/channels)（研究预览）直接推进会话，不碰任何窗口；Claude 空闲会马上回复，正忙会排到下一轮
- **快捷启动**：底部按钮一键在常用目录起一个 `cf` 会话（新 PowerShell 终端，claude 退出后窗口留在提示符方便回看）
- **窗口**：图钉置顶 · 横线收起成一条 · 叉隐藏到托盘；位置、大小、置顶状态会记住。托盘图标（橙色圆点）单击显示/隐藏，右键菜单可开关「开机自动运行」（默认关）和退出

## 快速回复的原理

`cf` 启动的会话开了 Claude Code 的开发频道，浮窗往里塞文字就是替你打字：

- `cf.cmd` 设 `CLAUDE_FLOAT_CHANNEL=1` 后跑 `claude --channels server:claude-float`，参数照常往后加。首次启动 Claude Code 会弹一个开发频道的警告，选「I am using this for local development」继续
- 频道 server（`channel/server.js`）用 `claude mcp add -s user` 注册在 user scope，任何目录启动的 claude 都会加载它；但只有 `cf` 启动的会话开了频道，浮窗只给这种会话显示回复按钮。想撤销注册：`claude mcp remove claude-float`
- 频道 server 由 Claude Code 拉起，在 `127.0.0.1` 随机端口等浮窗的消息，每个会话一个一次性密令，登记在 `~/.claude-float/channels/`，不对外网开放
- 已经在跑的普通会话没法补频道——下次用 `cf` 启动就行

## 运行

需要 Node.js（建议 20+）。

```bash
npm install
npm start
```

日常使用双击 `start.vbs`（不弹命令行窗口）。想开机自动打开：托盘菜单里勾上「开机自动运行」（写到 `HKCU\...\CurrentVersion\Run`，取消勾选就删掉）。

首次使用记得注册频道 server（快速回复要用）：

```bash
claude mcp add -s user claude-float -- node <本仓库路径>/channel/server.js
```

## 快捷启动目录配置

底部快捷启动按钮从 `~/.claude-float/quick-dirs.json` 读，格式：

```json
[
  { "name": "项目A", "path": "D:\\work\\proj-a" },
  { "name": "实验", "path": "D:\\lab" }
]
```

没有这个文件就只显示一个 home 按钮。改完配置重启浮窗生效。

## 朗读语音

底部可选声音和语速。默认用**在线神经语音**（和 Edge「大声朗读」同一套，晓晓 / 云希等），听起来接近真人；也可以切到「系统语音（离线）」。

- 在线语音走的是微软的语音服务（`speech.platform.bing.com`），非官方接口，微软改了可能失效
- 连不上时自动改用系统语音读完，标题栏会提示；优先直连，失败再走 `HTTPS_PROXY`

## 可选环境变量

| 变量 | 作用 |
|---|---|
| `CLAUDE_FLOAT_PROJECTS` | 逗号分隔的关键字，只显示项目目录名包含这些关键字的会话，如 `pawkit,lab` |
| `CLAUDE_FLOAT_SPAWN_CMD` | 调试：快捷启动改拉这个命令，排查 spawn 问题时用 |
| `CLAUDE_FLOAT_SNAPSHOT` | 调试：启动后截图到该路径 |

## cf.cmd 里的网关门控（可选，可删）

`cf.cmd` 里有一段「本地模型网关健康检查」的逻辑：如果 `127.0.0.1:8787` 有网关在线，会话自动走 `--settings` 指定的网关配置；网关不在就直连 Anthropic，对日常使用零影响。这段是作者个人环境的配置，指向的路径在你机器上不存在时会自动跳过——直接删掉那几行也完全不影响浮窗其他功能。

## 开发

```bash
npm test        # 纯 Node 测试，不需要起 Electron
npm start       # 起浮窗
```

代码结构一览：

```
main.js         Electron 主进程：窗口、托盘、IPC
renderer.js     浮窗 UI 与朗读调度
sessions.js     读 ~/.claude/projects 会话记录 + 状态推测
channel/server.js  Claude Code 频道 server（快速回复的入口）
cf.cmd / spawn-cf.vbs / start.vbs   启动脚本（处理了 Windows 控制台句柄的几个坑，见代码注释）
```

## License

[MIT](LICENSE)
