# Claude 播报 · claude-float

Windows 上一个置顶的小浮窗：列出本机最近的 Claude 会话（Claude 桌面版 Code 标签页 / Claude Code CLI），点一下就用系统 TTS 朗读 Claude 的**最新一条回复**。

- 数据源：`~/.claude/projects/*/*.jsonl`，只读；标题优先用桌面版里的会话名
- 朗读前会清理 Markdown：代码块读成「代码略」，链接只读文字，路径只读文件名，表格按行读
- **点击会话那一行**：在 Claude 桌面版里打开这个会话（命令行会话桌面版里没有，会提示一下）
- **喇叭按钮**：朗读这个会话的最新回复；再点一次、点标题栏的方块或按 `Esc` 停止
- 每个会话右边是状态：**进行中**（Claude 在干活）、**等待回复**（Claude 在问你、等你确认计划，或者工具调用很久没结果，多半在等你批准），否则显示最后一条回复是多久之前
- **快速回复**（只对用 `cc` 启动的命令行会话）：会话右边的橙色箭头，点开底部输入框，Enter 发送、Shift+Enter 换行、Esc 取消。消息通过 Claude Code 官方的 [Channels](https://code.claude.com/docs/en/channels)（研究预览）直接推进会话，不碰任何窗口；Claude 空闲会马上回复，正忙会排到下一轮
  - `cc` = `claude --mcp-config channel/mcp.json --dangerously-load-development-channels server:claude-float`，参数照常往后加。启动时 Claude Code 会先弹一个开发频道的警告，选「I am using this for local development」继续
  - `channel/server.js` 由 Claude Code 拉起，在 127.0.0.1 随机端口等浮窗的消息，每个会话一个一次性密令，登记在 `~/.claude-float/channels/`
  - 桌面版会话没有这个能力（桌面版不让给会话加 `--channels`），已提 [anthropics/claude-code#98369](https://github.com/anthropics/claude-code/issues/98369)。之前那种模拟界面操作的发送会把 Claude 窗口拉到前台，已停用
- 状态优先用 Claude Code 自己写的 `~/.claude/sessions/<pid>.json`（busy / waiting / idle，桌面版和命令行都有），会话没在跑时才从会话记录推测
- 标题栏：图钉切换置顶 · 横线收起成一条 · 叉隐藏到托盘；窗口位置、大小、置顶状态会记住
- **托盘图标**（橙色圆点）：单击显示/隐藏；右键菜单里可以开关「开机自动运行」（默认关），以及退出
- 底部选声音和语速。默认用**在线神经语音**（和 Edge「大声朗读」同一套，晓晓 / 云希等），听起来接近真人；也可以切到「系统语音（离线）」
  - 在线语音会把要朗读的文字发到微软的语音服务（`speech.platform.bing.com`），这是非官方接口，微软改了可能失效
  - 连不上时自动改用系统语音读完，标题栏会提示一下；优先直连，失败再走 `HTTPS_PROXY`

## 运行

```bash
npm install
npm start
```

日常使用双击 `start.vbs`（不弹命令行窗口）。

想开机自动打开：在托盘菜单里勾上「开机自动运行」（会写到 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，取消勾选就删掉）。

## 可选环境变量

| 变量 | 作用 |
|---|---|
| `CLAUDE_FLOAT_PROJECTS` | 逗号分隔的关键字，只显示项目目录名包含这些关键字的会话，如 `carl,pawkit` |
| `CLAUDE_FLOAT_SNAPSHOT` | 调试：启动后截图到该路径（`_JS` 先执行一段脚本） |
