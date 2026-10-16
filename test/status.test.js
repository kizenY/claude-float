const assert = require('assert');
const { parse, statusOf } = require('../sessions');

const now = Date.now();
const a = (id, stop, content) => ({ type: 'assistant', message: { id, stop_reason: stop, content } });
const u = (content) => ({ type: 'user', message: { content } });
const st = (entries, quietMs) => statusOf(parse(entries).tail, now - quietMs, now);

// 回完了
assert.strictEqual(st([u('hi'), a('m1', 'end_turn', [{ type: 'text', text: 'done' }])], 5e3), 'idle');
// 你刚发完，Claude 还没回
assert.strictEqual(st([a('m0', 'end_turn', [{ type: 'text', text: 'x' }]), u('再来')], 5e3), 'working');
// 工具结果刚回来
assert.strictEqual(st([a('m1', 'tool_use', [{ type: 'tool_use', name: 'Read' }]), u([{ type: 'tool_result' }])], 5e3), 'working');
// Claude 在问你
assert.strictEqual(st([a('m1', 'tool_use', [{ type: 'text', text: '选哪个？' }]), a('m1', 'tool_use', [{ type: 'tool_use', name: 'AskUserQuestion' }])], 1e3), 'waiting');
// 普通工具很久没结果 => 多半在等批准；刚开始则算进行中
assert.strictEqual(st([a('m1', 'tool_use', [{ type: 'tool_use', name: 'Edit' }])], 60e3), 'waiting');
assert.strictEqual(st([a('m1', 'tool_use', [{ type: 'tool_use', name: 'Edit' }])], 5e3), 'working');
// Bash 给更长的宽限
assert.strictEqual(st([a('m1', 'tool_use', [{ type: 'tool_use', name: 'Bash' }])], 60e3), 'working');
assert.strictEqual(st([a('m1', 'tool_use', [{ type: 'tool_use', name: 'Bash' }])], 200e3), 'waiting');
// 子 Agent 跑多久都算进行中
assert.strictEqual(st([a('m1', 'tool_use', [{ type: 'tool_use', name: 'Agent' }])], 600e3), 'working');
// 被你打断
assert.strictEqual(st([a('m1', 'tool_use', [{ type: 'tool_use', name: 'Bash' }]), u([{ type: 'text', text: '[Request interrupted by user for tool use]' }])], 5e3), 'idle');
// 回完之后又排队了一条
assert.strictEqual(st([a('m1', 'end_turn', [{ type: 'text', text: 'x' }]), { type: 'queue-operation', operation: 'enqueue' }], 5e3), 'working');
// 子 Agent 的记录不影响主线
assert.strictEqual(st([a('m1', 'end_turn', [{ type: 'text', text: 'x' }]), { ...u('sub'), isSidechain: true }], 5e3), 'idle');

// headCwd：取文件头第一条 cwd（启动目录）。会话里 cd 会把后续条目的 cwd 带漂，
// 归目录/resume 都要「从哪起的」，不能拿尾部那条
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { headCwd } = require('../sessions');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-float-'));
  const file = path.join(dir, 's.jsonl');
  const line = (cwd) => JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } });
  fs.writeFileSync(file, [line('E:\\agent-cluster\\carl'), line('E:\\develop\\code\\claude-float')].join('\n'));
  assert.strictEqual(headCwd(file), 'E:\\agent-cluster\\carl');
  // 头部没有 cwd（空文件/坏文件）→ null，不抛
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
  assert.strictEqual(headCwd(path.join(dir, 'empty.jsonl')), null);
  assert.strictEqual(headCwd(path.join(dir, '无.jsonl')), null);
}
console.log('status ok');
