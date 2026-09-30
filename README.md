# Claude 播报 · claude-float

Windows 上一个置顶的小浮窗：列出本机最近的 Claude 会话（Claude 桌面版 Code 标签页 / Claude Code CLI），点一下就用系统 TTS 朗读 Claude 的**最新一条回复**。

- 数据源：`~/.claude/projects/*/*.jsonl`，只读；标题优先用桌面版里的会话名
- 朗读前会清理 Markdown：代码块读成「代码略」，链接只读文字，路径只读文件名，表格按行读
- 点正在朗读的会话、点标题栏的方块或按 `Esc` 停止
- 每个会话右边是状态：**进行中**（Claude 在干活）、**等待回复**（Claude 在问你、等你确认计划，或者工具调用很久没结果，多半在等你批准），否则显示最后一条回复是多久之前
- **快速回复**：鼠标移到会话上点回复箭头，底部弹出输入框，Enter 发送、Shift+Enter 换行、Esc 取消。只对 Claude 桌面版里的会话有效
  - 原理：用 `claude://code/continue?session=local_xxx` 让桌面版跳到那个会话，再用 UI Automation 确认页面标题对得上、焦点在输入框里，然后粘贴、回车，最后看会话记录里有没有出现这条消息
  - 任何一步对不上就不发，并把内容留在剪贴板；那个会话的输入框里已有草稿时也不会动它
  - 发送时 Claude 窗口会闪到前台一下，焦点随后还给浮窗
- 标题栏：图钉切换置顶 · 横线收起成一条 · 叉隐藏到托盘；窗口位置、大小、置顶状态会记住
- **托盘图标**（橙色圆点）：单击显示/隐藏；右键菜单里可以开关「跟随 Claude：主窗口开着时隐藏，最小化时显示」（默认开）、「开机后台运行」（默认关），以及退出
- 底部选声音和语速。默认用**在线神经语音**（和 Edge「大声朗读」同一套，晓晓 / 云希等），听起来接近真人；也可以切到「系统语音（离线）」
  - 在线语音会把要朗读的文字发到微软的语音服务（`speech.platform.bing.com`），这是非官方接口，微软改了可能失效
  - 连不上时自动改用系统语音读完，标题栏会提示一下；优先直连，失败再走 `HTTPS_PROXY`

## 运行

```bash
npm install
npm start
```

日常使用双击 `start.vbs`（不弹命令行窗口）。

浮窗是 Claude 主窗口的**替身**：Claude 在运行、但主窗口最小化或关到托盘时，浮窗出现；主窗口打开时，浮窗隐藏；Claude 退出后也隐藏。窗口状态由常驻的 `claude-window.ps1` 盯着（约 0.7 秒检查一次，只看桌面版本身的窗口，其他虚拟桌面上的不算），Claude 有没有在运行则看 `%APPDATA%\Claude\lockfile` 有没有被占着。只在该出现/该隐藏的那一刻动一下，中间你手动显示或隐藏都算数。快速回复时，如果 Claude 原本是最小化的，发完会再把它收回去。

想开机后自动就位：在托盘菜单里勾上「开机后台运行」（会写到 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，取消勾选就删掉）。

## 可选环境变量

| 变量 | 作用 |
|---|---|
| `CLAUDE_FLOAT_PROJECTS` | 逗号分隔的关键字，只显示项目目录名包含这些关键字的会话，如 `carl,pawkit` |
| `CLAUDE_FLOAT_SNAPSHOT` | 调试：启动后截图到该路径（`_JS` 先执行一段脚本，`_DRYRUN=<会话 id>` 空跑一次快速回复：粘贴后清空，不发送） |
| `CLAUDE_FLOAT_LOCKFILE` / `CLAUDE_FLOAT_WINDOW` / `CLAUDE_FLOAT_DEBUG` | 调试：换一个 lockfile 模拟 Claude 开关 / 固定 Claude 窗口状态（`open`/`closed`）/ 打印跟随状态 |
