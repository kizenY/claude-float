const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const hidden = require('../hidden-sessions');

// 全程用临时目录，不碰真实的 ~/.claude-float/hidden-sessions.json
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-float-hidden-'));
const file = path.join(dir, 'hidden-sessions.json');

// hide：带标题入册、重复隐藏不重复
hidden.hide('abc', '修浮窗', file);
hidden.hide('def', '第二张', file);
hidden.hide('abc', '修浮窗v2', file); // 重复 id = 刷新那一条，不是追加
const list = hidden.load(file);
assert.strictEqual(list.length, 2);
assert.strictEqual(list.find((h) => h.id === 'abc').title, '修浮窗v2');
assert.ok(list.find((h) => h.id === 'abc').at > 0);
assert.strictEqual(list.find((h) => h.id === 'def').title, '第二张');

// 标题截断到 80
hidden.hide('long', 'x'.repeat(200), file);
assert.strictEqual(hidden.load(file).find((h) => h.id === 'long').title.length, 80);

// unhide：摘掉指定的，别的还在；不存在的 id 不报错
hidden.unhide('abc', file);
assert.deepStrictEqual(hidden.load(file).map((h) => h.id).sort(), ['def', 'long']);
hidden.unhide('nope', file);

// 兼容旧格式（纯字符串数组）和脏数据（非对象、缺 id），能收编的收编、不能的丢掉
fs.writeFileSync(file, JSON.stringify(['legacy', { title: '缺 id' }, null, { id: 'ok', title: '好' }]));
const mixed = hidden.load(file);
assert.deepStrictEqual(mixed.map((h) => h.id), ['legacy', 'ok']);
assert.strictEqual(mixed[0].title, '');

// 写坏一半的文件当空列表，不炸
fs.writeFileSync(file, '{oops');
assert.strictEqual(hidden.load(file).length, 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log('hidden-sessions ok');
