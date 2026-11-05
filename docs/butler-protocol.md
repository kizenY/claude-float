# 管家面板集成协议（butler protocol · schema:1）

claude-float 浮窗的「管家」视图是一个开放的集成接口：任何在本机以「一个目录一个实例」方式
运行的守护进程（如 super-agent 式任务代理），只要按本协议
写两个文件，就会自动出现在浮窗侧栏的「管家」里——多实例任务列表、巡逻红灯、派活、等待答复的
批准/拒绝，全部可用。本文是第三方「管家类」集成的唯一契约（schema:1 起步，格式变更须同步升级）。

## 总览

| 文件 | 写者 | 读者 | 作用 |
|---|---|---|---|
| `~/.claude-float/butler-instances.json` | 各实例（读→合并→原子替换） | 浮窗（只读） | 实例发现：谁活着、根目录在哪 |
| `<实例根>/data/ui-snapshot.json` | 各实例（原子写） | 浮窗（只读） | 该实例的 UI 快照：任务/红灯/计数 |
| `<实例根>/data/inbox/<id>.json` | 浮窗（原子写） | 各实例（消费后删除） | user 通道指令：派活/批准/拒绝 |

浮窗每 3 秒读一次注册表和各实例快照；**浮窗从不直改任何实例状态文件**，动作一律投指令文件，
校验链/幂等全部在实例侧复用。

## 1. 实例注册表 `~/.claude-float/butler-instances.json`

```json
{
  "schema": 1,
  "instances": [
    { "root": "D:\\agents\\my-instance", "name": "my-instance", "pid": 53116,
      "version": "M5", "heartbeat_ms": 1730000000000 }
  ]
}
```

- `root`：实例根目录的**绝对路径字符串**。见下文「root 比对口径」。
- `name`：浮窗显示名（缺省时浮窗取 root 尾段兜底）。
- `pid` / `version`：展示用（可缺）。
- `heartbeat_ms`：毫秒 epoch 心跳。实例启动时 upsert 本条目、运行期周期刷新（建议 ≤30s）、
  优雅退出时移除；写法建议「读→合并→tmp+rename 原子替换→读回校验→重试 1 次」，
  多实例共享此文件，互撞丢一跳无害，下轮自愈。

浮窗侧消费语义（实例崩溃没来得及退订也没关系）：

| 心跳龄 | 浮窗行为 |
|---|---|
| ≤ 90s | 正常显示 |
| 90s ~ 24h | 离线灰显，**仍可派活**（指令落 inbox 排队，实例恢复后消费） |
| > 24h / 缺坏 | 不显示（强杀残留靠心跳自然衰减，无需清理） |

注册表**文件不存在**时，浮窗侧栏不出现「管家」项（零实例零感知）；文件出现过即常驻。

## 2. UI 快照 `<实例根>/data/ui-snapshot.json`

实例周期性全量重写（建议与心跳同节拍，任务状态变化时立即刷）：

```json
{
  "schema": 1,
  "root": "D:\\agents\\my-instance", "name": "my-instance",
  "pid": 53116, "version": "M5",
  "generated_at": "2026-11-05T12:00:00+08:00",
  "tasks": [
    { "id": "T-20261105-001", "goal": "写周报（≤80 字）", "status": "waiting_owner",
      "question": "口径按上周？（≤120 字，仅 waiting_owner 带）", "updated_at": "…" }
  ],
  "red_watches": [ { "id": "W-20261105-001", "title": "磁盘水位", "since": "…" } ],
  "counts": { "open": 3, "waiting_owner": 1, "red": 1 }
}
```

- 浮窗按 `schema` 兼容解析：未知字段忽略；坏文件 / 缺 `root` / schema 不符 → 整体跳过
  （该实例的任务区不渲染，实例块与派活仍可用）。
- `tasks[].status` 徽章文案覆盖：`active / queued / executing / waiting_external /
  waiting_owner / blocked / done / cancelled`（终态灰显；其余未知值原样显示）。
- `waiting_owner` 的任务行可点开问句并批准/拒绝。
- `red_watches`：巡逻红灯未消列表（`since` 可空）。
- `counts` 仅供展示参考，浮窗角标以 `tasks`/`red_watches` 现算为准。

## 3. 指令文件 `<实例根>/data/inbox/<指令id>.json`

浮窗动作 → user 通道指令（实例按自身指令协议校验与幂等消费；`id` 全局唯一，重复投递应跳过）：

| 面板动作 | 指令体 |
|---|---|
| 派活（默认立即执行） | `{ "id": "ui-…", "type": "task_add", "goal": "…", "run_now": true }` |
| 派活（勾「仅入队」） | `{ "id": "ui-…", "type": "task_add", "goal": "…", "run_now": false }` |
| owner 行「批准」 | `{ "id": "ui-…", "type": "task_update", "task_id": "T-…", "status": "active", "note": "管家面板：批准" }` |
| owner 行「拒绝」 | `{ "id": "ui-…", "type": "task_update", "task_id": "T-…", "status": "cancelled", "note": "管家面板：拒绝" }` |

- 指令 `id` 由浮窗生成：`ui-` + 毫秒 epoch 的 base36 + **6 位随机 base36 段**
  （36^6≈21.8 亿；例 `ui-lz0abc1xy9f3ak`，末 6 位为随机段）。文件名 = `id + ".json"`，
  tmp+rename 原子写入；浮窗落盘前按文件名查重，撞已有文件（含实例离线期残留的同 id
  未消费指令）即换 id 重试，实例侧可放心按 id 做幂等记账。
- 消费顺序建议按文件名字典序（`ui-` 前缀的 base36 毫秒天然时序友好）。

## root 比对口径（集成方必读）

浮窗把指令写入哪个目录，完全由**注册表条目里的 `root` 字符串**决定，且 dispatch 前做
**原样字符串等值比对（`===`）**——不做 `realpath`、不做大小写归一、不做斜杠/尾斜杠归一。
这意味着：

- 注册表里写什么路径，实例就必须一直在那个路径下运行（写盘符大小写、分隔符都要保持一致）；
- Windows 8.3 短名（`PROGRA~1`）、大小写变体、正反斜杠变体都会被视为不同路径而被拒收。
  这是刻意的：任何规范化都会把「白名单外的路径」伪装成「白名单内」。

## 调试

未打包运行时（`npm start` / `electron .`）设 `CLAUDE_FLOAT_BUTLER_FAKE=<注册表文件路径>`，
浮窗会改读该文件（假注册表里的 root 指向摆好 `data/ui-snapshot.json` 的目录即可），
配合 `CLAUDE_FLOAT_SNAPSHOT=<输出.png>` 做离线 UI 验收，不碰真实注册表。
