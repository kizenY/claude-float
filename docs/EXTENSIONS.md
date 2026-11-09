# 扩展（extensions）

扩展让浮窗显示别的工具的数据、提供操作按钮，而浮窗本身不认识任何具体工具。
典型用法：在浮窗里看某个项目的任务看板、服务状态、报价表，一键插入文字或起新会话。

本文是扩展契约（apiVersion 1）与作者指南。设计参照 [trine](https://github.com/smokecat/trine) 的 D18 扩展模型，
按 claude-float 的单机单用户形态裁剪。

## 工作方式

```text
浮窗 renderer ──IPC── 浮窗主进程 ──spawn── 扩展进程（一次调用一个进程）
  只渲染数据          校验输出、执行动作
```

- **扩展跑在本机**，是一个外部程序：stdin 收一个 JSON，stdout 回一个 JSON。用什么语言写都行。
- **浮窗不执行扩展的任何代码。** 扩展只能返回下面「视图词汇」里的数据，由浮窗用自己的组件渲染。
- **读取永远没有副作用。** 显示、刷新都不会执行任何动作；动作只在用户点击后执行。
- 发消息、起会话类动作在界面上要**两段确认**（按钮先亮「确认执行？」，再点一次才执行），确认的就是将要执行的内容。

## 信任边界

- 安装扩展等于信任它的代码：它以当前用户身份运行，能读写这个用户能读写的文件。浮窗不提供沙箱。
  这和 Claude Code 的 hook 是同等级别的信任。所以扩展只能在本机用命令行安装，界面上没有安装入口。
- 浮窗管的是扩展能让**浮窗做什么**（插文字、复制、发消息、起会话），按 manifest 声明的能力控制：
  没声明的能力，效果一律被拒绝执行。
- 扩展返回的文字一律当不可信数据：按纯文本渲染，不渲染 HTML、图片和链接。
- 扩展进程只拿到目录路径和会话的元信息（id、标题、状态、目录），拿不到对话内容。

## 安装与调试

```bash
node ext.js validate ./my-extension      # 只校验 manifest 与入口，不运行
node ext.js add ./my-extension           # 注册；浮窗运行中下一次拉取即生效
node ext.js list                         # 列出已装扩展
node ext.js disable my-ext               # 停用（面板隐藏，注册保留）
node ext.js enable my-ext
node ext.js test my-ext                  # 用当前目录当上下文跑一次 view，打印规范化输出
node ext.js remove my-ext                # 移除注册
```

注册表在 `~/.claude-float/extensions.json`。完整示例见 `examples/hello-ext/`。

## manifest

扩展目录里的 `float-extension.json`：

```json
{
  "apiVersion": 1,
  "id": "hello-ext",
  "name": "示例扩展",
  "version": "0.1.0",
  "description": "可选，一句话说明",
  "entry": ["node", "bin/hello.js"],
  "contributes": {
    "panel": { "title": "示例" }
  },
  "capabilities": ["prompt.insert"]
}
```

- `id`：小写字母、数字、连字符，2–32 个字符。`float`、`claude` 是保留字。
- `entry`：argv 数组，不经过 shell。`entry[0]` 是相对路径时按扩展目录解析，是裸命令名（如 `node`、`python`）时在 PATH 里找；
  之后的参数里含路径分隔符或以 `./`、`../` 开头的也按扩展目录解析，其余原样传。
  **不接受 `.cmd`/`.bat`**：不经 shell 直起它们本来就不可行，请写 `["node", "bin/xxx.js"]`。
- `contributes.panel`：浮窗上的贡献点。v1 只有面板（一条可收放行，标题用 `title` 或 `name`）。
- `capabilities`：扩展可能用到的能力，可选 `prompt.insert`、`prompt.send`、`session.create`。
  没声明的一律被拒。`copy`、`refresh` 无副作用，不用声明。

## 调用约定

浮窗执行 `<entry...> view`。

- stdin：一个 JSON（写完即关闭），上限 256 KB。
- stdout：一个 JSON，上限 512 KB。退出码非 0 或不是合法 JSON 都算失败。
- 工作目录：扩展自己的目录；定位自己的文件用环境变量 `FLOAT_EXT_DIR`（值即扩展目录）。
- 超时：view 读取 5 秒（`ext.js test` 放宽到 15 秒），超时杀进程。
- 环境变量白名单：`HOME`、`USERPROFILE`、`SYSTEMROOT`、`USER`、`LOGNAME`、`LANG`、`LC_*`、`TZ`、`TMPDIR`、`SHELL`、`TERM`、
  `PATH`（去掉空段、`.` 和相对段），外加 `FLOAT_EXT_DIR`、`FLOAT_EXT_API=1`。
- 并发：每个扩展最多同时 2 个进程，全部扩展最多 4 个。
- 读取结果缓存 15 秒；动作执行完成后作废。

输入（view）：

```json
{
  "apiVersion": 1,
  "op": "view",
  "point": "panel",
  "locale": "zh-CN",
  "context": {
    "cwd": "E:\\work\\project",
    "sessions": [
      { "id": "…", "title": "…", "status": "idle", "cwd": "E:\\work\\project" }
    ]
  },
  "args": {}
}
```

- `cwd`：浮窗当前选中的启动目录；「其他」视图时为 `null`。只当数据上下文用。
- `sessions`：这个目录下的会话元信息（最多 200 条，只有 id/标题/状态/目录）。`status` 取值
  `working` / `waiting` / `idle`。发消息、插文字类效果要指定 `sessionId`，就从这里挑。

输出：

```json
{ "view": { …View… } }
```

出错时输出 `{ "error": { "code": "…", "message": "…" } }`，`message` 会显示给用户。

## 视图词汇

```ts
View     = { title?, sections: Section[], toolbar?: Action[], empty?: string }
Section  = { id, title?, items: Item[], empty?: string }
Item     = { id, title, subtitle?, meta?, badges?: Badge[], detail?, actions?: Action[] }
Badge    = { text, tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger', title? }
Action   = { id, label, primary?, destructive?, confirm?, effects: Effect[] }
Effect   = { type: 'prompt.insert', text, sessionId }   // 打开快速回复框并预填（目标会话不在了退化为复制）
         | { type: 'copy', text }                       // 复制到剪贴板
         | { type: 'refresh' }                          // 重拉这个扩展的视图
         | { type: 'prompt.send', text, sessionId }     // 把文字发给那个会话（要两段确认）
         | { type: 'session.create', cwd }              // 在指定目录起新会话（要两段确认；目录必须在启动目录列表里）
```

- 上限：sections 20、每组 items 200、每项 actions 8、每个动作 effects 4、badges 8；
  普通文本 2 KB、detail 16 KB、插入/发送文字 32 KB。超限或出现未知的 effect 类型时整个输出判为无效，
  面板显示「扩展返回了无法识别的内容」。
- `detail` 按纯文本渲染（保留换行），点击条目展开/收起。
- `primary` 是主按钮样式；`destructive` 标红且强制两段确认；`confirm` 可自定义确认文案。
- `session.create` 的 `cwd` 必须精确命中浮窗「启动目录」（quick-dirs.json）里的路径，白名单外的目录会被拒绝。

## 动作的执行

- 只含本地效果（`prompt.insert`、`copy`、`refresh`）的动作，点一下直接执行；
  `prompt.insert` 打开浮窗的快速回复框并预填文字，你改完再手动发送——扩展只能「递纸条」，发不发你说了算。
- 含 `prompt.send`、`session.create` 的动作，以及标了 `confirm` / `destructive` 的动作，两段确认后才执行。
- 确认后主进程还会再校验一遍：效果形状合法、能力已声明、目录在白名单里，不合法的整条拒绝。
- 动作执行完自动重拉一次该扩展的视图（动作可能改了扩展背后的数据）。

## 与 trine 契约的差异

单机单用户带来的裁剪，写扩展前值得知道：

- 没有 E2E 加密、多设备、动作令牌那套——浮窗和扩展在同一台机器同一个用户下。
- 效果词汇更小：没有 `links.*`（会话关联）、没有 `invoke` 型动作（v1 的动作只带静态效果），
  `prompt.insert`/`prompt.send` 需要显式 `sessionId`（浮窗没有「当前会话」的概念，会话列表在输入里给你）。
- `session.create` 只负责在白名单目录里起一个新终端会话，不支持预填标题和首条消息。
- 贡献点 v1 只有 `panel`。

## 后续路线（尚未实现）

- 更多贡献点：sessionBadge（会话行徽章）、composerAction（回复框旁的快捷插入）。
- 会话关联（session-links）与时间线记录。

已落地的官方扩展在 `exts/` 下（`todos` 任务单、`usage` 订阅用量），都带浮窗与 trine 双清单。

## 最小示例

见 `examples/hello-ext/`。核心就这么多：

```js
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  console.log(JSON.stringify({
    view: { sections: [{ id: 's', items: [
      { id: 'hello', title: 'Hello',
        actions: [{ id: 'copy', label: '复制', effects: [{ type: 'copy', text: '你好' }] }] },
    ] }] },
  }));
});
```
