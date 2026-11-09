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

// update：只改标题/内容/目标/工作区，状态、完成时间、绑定会话都不碰；不存在的 id 返回 null
todos.toggle(a.id, file);
const u = todos.update(a.id, { title: ' 修浮窗v2 ', desc: '新描述', goal: '改完就好', ws: 'C:\\work\\c' }, file);
assert.strictEqual(u.title, '修浮窗v2');
const after = todos.load(file).find((t) => t.id === a.id);
assert.strictEqual(after.desc, '新描述');
assert.strictEqual(after.goal, '改完就好');
assert.strictEqual(after.ws, 'C:\\work\\c');
assert.strictEqual(after.status, 'done');
assert.ok(after.doneAt);
assert.deepStrictEqual(after.sessions, ['s2']);
assert.strictEqual(todos.update('nope', { title: 'x' }, file), null);

// logProgress：追加进度记录（时间/by/文字），pct 夹在 0-100；空文字/坏 id 不记
const lg = todos.logProgress(a.id, ' 干完第一轮 ', { by: 's2', pct: 130 }, file);
assert.strictEqual(lg.progressLog.length, 1);
assert.strictEqual(lg.progressLog[0].text, '干完第一轮');
assert.strictEqual(lg.progressLog[0].by, 's2');
assert.strictEqual(lg.pct, 100, 'pct clamped to 100');
const lg2 = todos.logProgress(a.id, '第二轮', { pct: -5 }, file);
assert.strictEqual(lg2.pct, 0, 'pct clamped to 0');
assert.strictEqual(lg2.progressLog.length, 2);
assert.strictEqual(lg2.progressLog[1].by, null, 'by 缺省为 null');
assert.strictEqual(todos.logProgress(a.id, '   ', {}, file), null, '空白进度不记');
assert.strictEqual(todos.logProgress('nope', 'x', {}, file), null);

// 进度记录超上限丢最老的
for (let i = 0; i < todos.MAX_PROGRESS + 5; i++) todos.logProgress(a.id, '进度' + i, {}, file);
const full = todos.load(file).find((t) => t.id === a.id);
assert.strictEqual(full.progressLog.length, todos.MAX_PROGRESS);
assert.strictEqual(full.progressLog[full.progressLog.length - 1].text, `进度${todos.MAX_PROGRESS + 4}`);

// sameDir：盘符/斜杠/大小写/尾斜杠都不敏感
assert.strictEqual(todos.sameDir('C:\\WORK\\a', 'c:/work/a/'), true);
assert.strictEqual(todos.sameDir('C:\\work\\a', 'C:\\work\\b'), false);
assert.strictEqual(todos.sameDir('', 'C:\\x'), false);

// 写坏一半的文件当空列表，不炸
const bad = path.join(dir, 'bad.json');
fs.writeFileSync(bad, '{oops');
assert.strictEqual(todos.load(bad).length, 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log('todos ok');
