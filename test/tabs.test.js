const assert = require('assert');
const { sameWs, matchDir } = require('../tabs');

const dirs = [
  { name: 'carl', path: 'E:\\agent-cluster\\carl' },
  { name: 'seesaw', path: 'E:\\agent-cluster\\seesaw' },
];

// 归一命中：大小写、正反斜杠、尾斜杠都不影响；返回的是 dir 的原样 path
assert.strictEqual(matchDir('e:/AGENT-CLUSTER/CARL/', dirs), dirs[0].path);
assert.strictEqual(matchDir('E:\\agent-cluster\\seesaw', dirs), dirs[1].path);
assert.strictEqual(matchDir('E:/agent-cluster/carl', dirs), dirs[0].path);

// 精确匹配：子目录不归入父目录（和挂单 matchPending 同一口径）
assert.strictEqual(matchDir('E:\\agent-cluster\\carl\\sub', dirs), null);

// 空与无命中
assert.strictEqual(matchDir('', dirs), null);
assert.strictEqual(matchDir(null, dirs), null);
assert.strictEqual(matchDir('D:\\elsewhere', dirs), null);
assert.strictEqual(matchDir('E:\\agent-cluster\\carl', []), null);
assert.strictEqual(matchDir('E:\\agent-cluster\\carl', null), null);

// sameWs 边界（沿用 renderer 原有行为）
assert.ok(sameWs('C:/a/b', 'c:\\a\\b\\'));
assert.ok(!sameWs('', 'C:/a'));
assert.ok(!sameWs('C:/a', ''));
assert.ok(!sameWs(null, null));

console.log('tabs ok');
