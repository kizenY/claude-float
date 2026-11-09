# todos · 任务单扩展

浮窗与 trine 共用的任务单面板。数据只有一份：`~/.claude-float/todos.json`——
任务的创建、改内容、记进度仍由会话里的 MCP 工具（`todos_add` / `todos_update` / …）完成，
这个扩展只负责「看」和在界面上接手：

- **浮窗**（`node ext.js add exts/todos`）：面板列出进行中/最近完成的任务，
  「起会话」在任务的工作区起新会话，「复制接手提示」拿到一段让会话自己 `todos_bind` 的话。
- **trine**（`trine-agent ext add <本目录>`）：
  - 会话面板「任务单」：看任务 + 进度时间线，绑定过它的会话显示成可点的会话引用；
  - 「本会话接手」把接手提示插进输入框（工作区面板里退化为复制）；
  - 「新会话处理」在任务工作区开会话并预填接手提示；
  - 「完成 / 重开」（invoke）直接改 todos.json 并记一条进度；
  - 会话徽章：绑着进行中任务的会话亮「任·×××」；
  - 新建会话 sheet 的「从任务开始」。

两份 manifest（`float-extension.json` / `trine-extension.json`）共用 `bin/ext.js`。
显示层的「关联」（trine session-links，ref=任务 id）和数据层的绑定（todos.json 的
`sessions`）会合并展示；接手绑定的正路是让会话调 `todos_bind`。
