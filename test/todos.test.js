const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const todos = require('../todos');

// 全程用临时目录，不碰真实的 ~/.claude-float/todos.json
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-float-todos-'));
const file = path.join(dir, 'todos.json');

// create：标题去空白、默认字段齐全
const a = todos.create({ title: '  修浮窗  ', desc: '描述', ws: 'C:\\work\\a' }, file);
assert.strictEqual(a.title, '修浮窗');
assert.strictEqual(a.status, 'open');
assert.strictEqual(a.doneAt, null);
assert.deepStrictEqual(a.sessions, []);
assert.strictEqual(todos.load(file).length, 1);

// 新单排在最前
const b = todos.create({ title: '第二张', ws: 'C:\\work\\b' }, file);
assert.strictEqual(todos.load(file)[0].id, b.id);

// toggle：完成记 doneAt，重开清掉；不存在的 id 返回 null
const done = todos.toggle(a.id, file);
assert.strictEqual(done.status, 'done');
assert.ok(done.doneAt);
const reopened = todos.toggle(a.id, file);
assert.strictEqual(reopened.status, 'open');
assert.strictEqual(reopened.doneAt, null);
assert.strictEqual(todos.toggle('nope', file), null);

// bind 去重、unbind 摘掉
todos.bind(a.id, 's1', file);
todos.bind(a.id, 's1', file);
assert.deepStrictEqual(todos.load(file).find((t) => t.id === a.id).sessions, ['s1']);
todos.bind(a.id, 's2', file);
todos.unbind(a.id, 's1', file);
assert.deepStrictEqual(todos.load(file).find((t) => t.id === a.id).sessions, ['s2']);
assert.strictEqual(todos.bind('nope', 's1', file), null);

// 挂的会话数有上限，超了丢最老的
for (let i = 0; i < todos.MAX_SESSIONS + 5; i++) todos.bind(b.id, 'x' + i, file);
assert.strictEqual(todos.load(file).find((t) => t.id === b.id).sessions.length, todos.MAX_SESSIONS);

// remove
assert.strictEqual(todos.remove(b.id, file), true);
assert.strictEqual(todos.remove(b.id, file), false);
assert.strictEqual(todos.load(file).length, 1);

// sameDir：盘符/斜杠/大小写/尾斜杠都不敏感
assert.strictEqual(todos.sameDir('C:\\WORK\\a', 'c:/work/a/'), true);
assert.strictEqual(todos.sameDir('C:\\work\\a', 'C:\\work\\b'), false);
assert.strictEqual(todos.sameDir('', 'C:\\x'), false);

// matchPending：同目录的新面孔命中；老面孔不算；别的目录不算；过期不算；没 pending 不算
const now = Date.now();
const pending = { todoId: a.id, ws: 'C:\\work\\a', knownIds: ['old1'], at: now };
assert.strictEqual(todos.matchPending([
  { id: 'old1', cwd: 'C:\\work\\a' },
  { id: 'new1', cwd: 'c:\\work\\a' },
  { id: 'new2', cwd: 'C:\\work\\b' },
], pending, now), 'new1');
assert.strictEqual(todos.matchPending([{ id: 'old1', cwd: 'C:\\work\\a' }], pending, now), null);
assert.strictEqual(todos.matchPending([{ id: 'new1', cwd: 'C:\\work\\a' }], pending, now + todos.PENDING_TTL + 1), null);
assert.strictEqual(todos.matchPending([{ id: 'new1', cwd: 'C:\\work\\a' }], null, now), null);

// 写坏一半的文件当空列表，不炸
const bad = path.join(dir, 'bad.json');
fs.writeFileSync(bad, '{oops');
assert.strictEqual(todos.load(bad).length, 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log('todos ok');
