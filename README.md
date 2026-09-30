# Claude 播报 · claude-float

Windows 上一个置顶的小浮窗：列出本机最近的 Claude 会话（Claude 桌面版 Code 标签页 / Claude Code CLI），点一下就用系统 TTS 朗读 Claude 的**最新一条回复**。

- 数据源：`~/.claude/projects/*/*.jsonl`，只读，不联网；标题优先用桌面版里的会话名
- 朗读前会清理 Markdown：代码块读成「代码略」，链接只读文字，路径只读文件名，表格按行读
- 点正在朗读的会话、点标题栏的方块或按 `Esc` 停止
- 标题栏：图钉切换置顶 · 横线收起成一条 · 叉退出；窗口位置、大小、置顶状态会记住
- 底部选声音（默认第一个中文声音）和语速

## 运行

```bash
npm install
npm start
```

日常使用双击 `start.vbs`（不弹命令行窗口）。想开机自启，把 `start.vbs` 的快捷方式放进 `shell:startup`。

## 可选环境变量

| 变量 | 作用 |
|---|---|
| `CLAUDE_FLOAT_PROJECTS` | 逗号分隔的关键字，只显示项目目录名包含这些关键字的会话，如 `carl,pawkit` |
| `CLAUDE_FLOAT_SNAPSHOT` | 调试：启动后截图到该路径并打印可用声音 |
