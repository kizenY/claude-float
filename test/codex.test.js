// Codex rollout 记录的解析 / 状态推断 / 文件列表（夹具放在临时 CODEX_HOME）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-float-'));
process.env.CODEX_HOME = HOME; // 必须在 require 之前：codex-sessions 加载时就定 ROOT
const codex = require('../codex-sessions');

const now = Date.now();
const ts = () => new Date(now).toISOString();
const rec = (type, payload) => ({ timestamp: ts(), type, payload });
const msg = (role, kind, text) => rec('response_item', { type: 'message', role, content: [{ type: kind, text }] });
const call = (name, callId) => rec('response_item', { type: 'function_call', name, call_id: callId, arguments: '{}' });
const output = (callId) => rec('response_item', { type: 'function_call_output', call_id: callId, output: 'ok' });
const ev = (type) => rec('event_msg', { type });
const st = (entries, quietMs) => codex.statusOf(codex.parse(entries).tail, now - quietMs, now);

// 回完了
assert.strictEqual(st([msg('user', 'input_text', 'hi'), ev('task_started'), msg('assistant', 'output_text', 'done'), ev('task_complete')], 5e3), 'idle');
// 你刚发完、Codex 还没回
assert.strictEqual(st([msg('assistant', 'output_text', 'x'), msg('user', 'input_text', '再来')], 5e3), 'working');
assert.strictEqual(st([msg('user', 'input_text', 'hi'), ev('task_started')], 5e3), 'working');
// 工具在跑：刚开始算进行中，太久没结果多半在等你批准
assert.strictEqual(st([msg('user', 'input_text', '跑一下'), call('apply_patch', 'c1')], 5e3), 'working');
assert.strictEqual(st([msg('user', 'input_text', '跑一下'), call('apply_patch', 'c1')], 60e3), 'waiting');
// 命令类工具给更长的宽限
assert.strictEqual(st([call('shell', 'c1')], 60e3), 'working');
assert.strictEqual(st([call('shell', 'c1')], 200e3), 'waiting');
// 明确在等你批准
assert.strictEqual(st([call('shell', 'c1'), ev('exec_approval_requested')], 1e3), 'waiting');
// 工具已经出了结果、且回复已给 → 空闲
assert.strictEqual(st([call('read_file', 'c1'), output('c1'), msg('assistant', 'output_text', '好了')], 5e3), 'idle');
// 你打断了这轮
assert.strictEqual(st([msg('user', 'input_text', 'hi'), call('shell', 'c1'), ev('turn_aborted')], 5e3), 'idle');
// 系统注入不算人输入
assert.strictEqual(codex.parse([msg('user', 'input_text', '<environment_context>…</environment_context>'), ev('task_started')]).firstPrompt, null);
// 环境注入后的第一句真提问当标题
assert.strictEqual(
  codex.parse([msg('user', 'input_text', '<user_instructions>AGENTS.md</user_instructions>'), msg('user', 'input_text', '修登录 bug\n顺便看下样式')]).title,
  '修登录 bug',
);

// ---- 文件列表：rollout 放进临时 CODEX_HOME/sessions/年/月/日 ----
const id = '01234567-89ab-cdef-0123-456789abcdef';
const dir = path.join(HOME, 'sessions', '2026', '10', '11');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `rollout-2026-10-11T12-00-00-${id}.jsonl`);
fs.writeFileSync(file, [
  JSON.stringify({
    timestamp: '2026-10-11T04:00:00.000Z',
    type: 'session_meta',
    payload: {
      id, session_id: id, timestamp: '2026-10-11T04:00:00.000Z',
      cwd: 'E:\\work\\demo', originator: 'codex_cli_rs', source: 'startup',
    },
  }),
  JSON.stringify(msg('user', 'input_text', '修登录 bug')),
  JSON.stringify(rec('turn_context', { cwd: 'E:\\work\\demo', model: 'gpt-5.3-codex' })),
  JSON.stringify(ev('task_started')),
  JSON.stringify(call('shell', 'c1')),
  JSON.stringify(output('c1')),
  JSON.stringify(msg('assistant', 'output_text', '已修好，是空指针。')),
  JSON.stringify(ev('task_complete')),
].join('\n'), 'utf8');

const rows = codex.list(10);
assert.strictEqual(rows.length, 1);
assert.strictEqual(rows[0].id, id);
assert.strictEqual(rows[0].project, 'demo');
assert.strictEqual(rows[0].title, '修登录 bug');
assert.strictEqual(rows[0].status, 'idle');
assert.strictEqual(rows[0].preview, '已修好，是空指针。');
assert.strictEqual(codex.reply(file), '已修好，是空指针。');

// 空会话（只有 session_meta）不展示
const emptyId = 'ffffffff-89ab-cdef-0123-456789abcdef';
fs.writeFileSync(path.join(dir, `rollout-2026-10-11T12-05-00-${emptyId}.jsonl`),
  JSON.stringify({ type: 'session_meta', payload: { id: emptyId, session_id: emptyId, timestamp: '2026-10-11T04:05:00.000Z', cwd: 'E:\\work\\demo' } }), 'utf8');
assert.strictEqual(codex.list(10).length, 1);

// 其他 Agent（agent-cluster 下非 carl）的会话不串台，carl 自己的放行
function rollout(name, cwd) {
  const id2 = `aaaa${name.slice(0, 4)}-89ab-cdef-0123-456789abcdef`;
  fs.writeFileSync(path.join(dir, `rollout-2026-10-11T12-06-${name}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: id2, session_id: id2, timestamp: '2026-10-11T04:06:00.000Z', cwd } }),
    JSON.stringify(msg('user', 'input_text', `${name} 的问题`)),
    JSON.stringify(msg('assistant', 'output_text', `${name} 的回复`)),
  ].join('\n'), 'utf8');
}
rollout('00', 'E:\\agent-cluster\\seesaw');
rollout('01', 'E:\\agent-cluster\\carl');
assert.deepStrictEqual(codex.list(10).map((r) => r.project).sort(), ['carl', 'demo']);

// ---- 线程标题：桌面端写的 session_index.jsonl（id 是 uuid 前缀）优先于首句提问 ----
fs.writeFileSync(path.join(HOME, 'session_index.jsonl'),
  `${JSON.stringify({ id: id.slice(0, 28), thread_name: '官方线程标题', updated_at: '2026-10-11T04:10:00Z' })}\n`, 'utf8');
const titled = codex.list(10);
assert.strictEqual(titled.find((r) => r.project === 'demo').title, '官方线程标题');
assert.strictEqual(titled.find((r) => r.project === 'carl').title, '01 的问题'); // 没进索引的退回首句

// ---- 活进程匹配：方向性窗口（进程先于会话启动，提前量有限）----
const metaTs = now;
assert.strictEqual(codex.matchPid(metaTs, [{ pid: process.pid, startMs: metaTs - 2000 }]), process.pid); // 正常启动
assert.strictEqual(codex.matchPid(metaTs, [{ pid: process.pid, startMs: metaTs - 10 * 60e3 }]), process.pid); // 等信任确认的慢启动
assert.strictEqual(codex.matchPid(metaTs, [{ pid: process.pid, startMs: metaTs - 20 * 60e3 }]), null); // 太早的不算
assert.strictEqual(codex.matchPid(metaTs, [{ pid: process.pid, startMs: metaTs + 5000 }]), null); // 会话之后才启动的不算
assert.strictEqual(codex.matchPid(metaTs, [{ pid: process.pid, startMs: metaTs - 8 * 60e3 }, { pid: process.pid, startMs: metaTs - 10e3 }]), process.pid); // 取最近的

console.log('codex ok');
