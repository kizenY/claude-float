const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const butler = require('../butler');

// 全程临时目录，不碰真实 ~/.claude-float/butler-instances.json（对齐 todos.test.js 形态）
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-float-butler-'));
const regFile = path.join(dir, 'butler-instances.json');
const now = Date.now();

// ---- AC5-C1 注册表解析：合法/坏 JSON/缺字段 → 可用子集或空 ----

// 文件不存在 → null（浮窗侧栏整个不渲染「管家」项）
assert.strictEqual(butler.loadRegistry(path.join(dir, 'none.json')), null);

// 坏 JSON → 空注册表
fs.writeFileSync(regFile, '{oops');
assert.deepStrictEqual(butler.loadRegistry(regFile), { instances: [] });

// 非法结构（instances 非数组 / 顶层非对象）→ 空注册表
fs.writeFileSync(regFile, '{"schema":1,"instances":"x"}');
assert.deepStrictEqual(butler.loadRegistry(regFile), { instances: [] });
fs.writeFileSync(regFile, '[1,2]');
assert.deepStrictEqual(butler.loadRegistry(regFile), { instances: [] });

// 混合条目：缺 root 丢弃；缺 name 兜底 root 尾段；缺 pid/version 容错
fs.writeFileSync(regFile, JSON.stringify({
  schema: 1,
  instances: [
    { root: 'C:\\inst-a', name: '甲', pid: 111, version: 'M5', heartbeat_ms: now - 10e3 },
    { name: '没 root 的坏条目', heartbeat_ms: now },                 // 丢弃：无法定位实例
    { root: 'C:\\inst-b\\', heartbeat_ms: now - 5e3 },                // 缺 name → 尾段兜底
    { root: 'C:\\inst-old', name: '超24h', heartbeat_ms: now - 25 * 3600e3 },
    { root: 'C:\\inst-off', name: '离线', heartbeat_ms: now - 120e3 },
    { root: 'C:\\inst-nohb', name: '没心跳' },
    { root: 'C:\\inst-badhb', name: '坏心跳', heartbeat_ms: 'soon' },
  ],
}));
const reg = butler.loadRegistry(regFile);
assert.strictEqual(reg.instances.length, 6); // 只丢了没 root 的那条

// ---- AC5-C1 续：stale 两档（90s 离线、24h 隐藏）----
const shown = butler.listInstances(reg, now);
// >24h、缺心跳、坏心跳：都不显示
assert.ok(!shown.some((i) => i.root === 'C:\\inst-old'));
assert.ok(!shown.some((i) => i.root === 'C:\\inst-nohb'));
assert.ok(!shown.some((i) => i.root === 'C:\\inst-badhb'));
// >90s：离线保留（灰显可派活）
const off = shown.find((i) => i.root === 'C:\\inst-off');
assert.strictEqual(off.state, 'offline');
// 新鲜：在线
const on = shown.find((i) => i.root === 'C:\\inst-a');
assert.strictEqual(on.state, 'online');
assert.strictEqual(on.name, '甲');
assert.strictEqual(on.pid, 111);
// 缺 name 兜底尾段、pid/version 容错为空值
const noname = shown.find((i) => i.root === 'C:\\inst-b\\');
assert.strictEqual(noname.name, 'inst-b');
assert.strictEqual(noname.pid, null);
assert.strictEqual(noname.version, '');
// 边界值：恰好 90s / 恰好 24h（按「超过」判）
assert.strictEqual(butler.classifyInstance({ heartbeat_ms: now - butler.OFFLINE_MS }, now), 'online');
assert.strictEqual(butler.classifyInstance({ heartbeat_ms: now - butler.OFFLINE_MS - 1 }, now), 'offline');
assert.strictEqual(butler.classifyInstance({ heartbeat_ms: now - butler.HIDDEN_MS }, now), 'offline');
assert.strictEqual(butler.classifyInstance({ heartbeat_ms: now - butler.HIDDEN_MS - 1 }, now), 'hidden');

// ---- AC5-C2 快照解析：坏文件/缺 root → 跳过不抛 ----
const instDir = path.join(dir, 'inst-a');
fs.mkdirSync(path.join(instDir, 'data'), { recursive: true });
const snapFile = path.join(instDir, 'data', 'ui-snapshot.json');
// 文件不存在 / 坏 JSON / 缺 root / schema 不符 → 都返回 null
assert.strictEqual(butler.readSnapshot(path.join(dir, 'inst-none')), null);
fs.writeFileSync(snapFile, '{oops');
assert.strictEqual(butler.readSnapshot(instDir), null);
fs.writeFileSync(snapFile, JSON.stringify({ schema: 1, tasks: [] }));
assert.strictEqual(butler.readSnapshot(instDir), null);
fs.writeFileSync(snapFile, JSON.stringify({ schema: 2, root: instDir }));
assert.strictEqual(butler.readSnapshot(instDir), null);
// 合法快照：tasks/red_watches 里的坏条目被过滤，其余原样
fs.writeFileSync(snapFile, JSON.stringify({
  schema: 1, root: instDir, name: '甲', pid: 111, version: 'M5',
  generated_at: new Date(now).toISOString(),
  tasks: [
    { id: 'T-20261105-001', goal: '写周报', status: 'waiting_owner', question: '口径按上周？', updated_at: '' },
    { bad: 1 }, 'x',
    { id: 'T-20261105-002', goal: '巡检', status: 'active', updated_at: '' },
  ],
  red_watches: [{ id: 'W-20261105-001', title: '磁盘水位', since: new Date(now).toISOString() }, 3],
  counts: { open: 2, waiting_owner: 1, red: 1 },
}));
const snap = butler.readSnapshot(instDir);
assert.strictEqual(snap.tasks.length, 2);
assert.strictEqual(snap.tasks[0].question, '口径按上周？');
assert.strictEqual(snap.red_watches.length, 1);

// ---- AC5-C3 root 校验：dispatch 目标不在注册表 → 拒（注入防护） ----
fs.writeFileSync(regFile, JSON.stringify({ schema: 1, instances: [
  { root: 'C:\\inst-a', name: '甲', heartbeat_ms: now },
]}));
const reg2 = butler.loadRegistry(regFile);
assert.strictEqual(butler.rootAllowed('C:\\inst-a', reg2), true);
assert.strictEqual(butler.rootAllowed('C:\\inst-b', reg2), false);   // 未注册路径
assert.strictEqual(butler.rootAllowed('', reg2), false);
assert.strictEqual(butler.rootAllowed(null, reg2), false);
assert.strictEqual(butler.rootAllowed('C:\\inst-a', null), false);   // 没注册表=全拒
// 原样等值比对（硬口径）：大小写/斜杠/尾斜杠/8.3 短名等任何变体都不放行，不做规范化
assert.strictEqual(butler.rootAllowed('c:\\inst-a', reg2), false);
assert.strictEqual(butler.rootAllowed('C:/inst-a', reg2), false);
assert.strictEqual(butler.rootAllowed('C:\\inst-a\\', reg2), false);
assert.strictEqual(butler.rootAllowed('C:\\INSTM~1', reg2), false);

// ---- AC5-C4 指令构造：三种动作模板字段正确、id ui- 前缀且不重复 ----
const add = butler.buildCommand('add', { goal: '  写周报  ' });
assert.strictEqual(add.type, 'task_add');
assert.strictEqual(add.goal, '写周报'); // 去空白
assert.strictEqual(add.run_now, true);  // 默认立即执行
const queued = butler.buildCommand('add', { goal: 'x', queue_only: true });
assert.strictEqual(queued.run_now, false); // 勾「仅入队」→ 入队不执行
const approve = butler.buildCommand('approve', { task_id: 'T-20261105-001' });
assert.deepStrictEqual(approve, {
  id: approve.id, type: 'task_update', task_id: 'T-20261105-001',
  status: 'active', note: '管家面板：批准',
});
const reject = butler.buildCommand('reject', { task_id: 'T-20261105-002' });
assert.strictEqual(reject.type, 'task_update');
assert.strictEqual(reject.task_id, 'T-20261105-002');
assert.strictEqual(reject.status, 'cancelled');
assert.strictEqual(reject.note, '管家面板：拒绝');
// id：ui- 前缀 + 毫秒 base36 + 6 位随机段（M5.1：4→6 字符，36^6≈21.8 亿）；
// 千发连发零重复（QA-B 曾以同毫秒千发实测 4 位形态 10 轮 2 轮碰撞）
const ids = new Set();
const lens = new Set();
for (let i = 0; i < 1000; i++) {
  const c = butler.buildCommand('approve', { task_id: 'T-x' });
  assert.ok(/^ui-[0-9a-z]+$/.test(c.id), c.id);
  lens.add(c.id.length); // ui-(3) + 毫秒 base36(8) + 随机段(6) = 17（毫秒段 2286 年前恒 8 位）
  ids.add(c.id);
}
assert.strictEqual(ids.size, 1000);
assert.deepStrictEqual([...lens], [17]); // 随机段恒 6 字符（newId 循环补齐，不因尾数短而缩水）
// 非法入参拒：空 goal / 空 task_id / 未知动作
assert.throws(() => butler.buildCommand('add', { goal: '   ' }));
assert.throws(() => butler.buildCommand('add', {}));
assert.throws(() => butler.buildCommand('approve', {}));
assert.throws(() => butler.buildCommand('approve', { task_id: '' }));
assert.throws(() => butler.buildCommand('remove_watch', { task_id: 'T-1' }));

// 指令落实例 inbox：文件名=指令 id、内容可解析、无 tmp 残留
const cmd = butler.buildCommand('add', { goal: '联调' });
const written = butler.writeCommand(instDir, cmd);
assert.strictEqual(written, path.join(instDir, 'data', 'inbox', cmd.id + '.json'));
assert.deepStrictEqual(JSON.parse(fs.readFileSync(written, 'utf8')), cmd);
assert.strictEqual(
  fs.readdirSync(path.join(instDir, 'data', 'inbox')).filter((f) => f.includes('.tmp')).length, 0);

// M5.1 落盘前查重：目标文件已存在（同 id 碰撞 / 实例离线期残留）→ 换新 id，不覆盖旧文件
const dupDir = path.join(dir, 'inst-dup');
fs.mkdirSync(path.join(dupDir, 'data', 'inbox'), { recursive: true });
const stale = 'ui-stale0000aaaaa'; // 摆一个同 id 残留指令（模拟离线期未消费）
fs.writeFileSync(path.join(dupDir, 'data', 'inbox', stale + '.json'), '{"id":"' + stale + '"}');
const dupCmd = butler.buildCommand('approve', { task_id: 'T-dup' });
dupCmd.id = stale; // 强制撞上残留文件
const writtenDup = butler.writeCommand(dupDir, dupCmd);
assert.notStrictEqual(dupCmd.id, stale);                                    // 就地换了新 id
assert.strictEqual(writtenDup, path.join(dupDir, 'data', 'inbox', dupCmd.id + '.json'));
assert.strictEqual(JSON.parse(fs.readFileSync(writtenDup, 'utf8')).id, dupCmd.id); // 写盘=新 id
const staleRaw = fs.readFileSync(path.join(dupDir, 'data', 'inbox', stale + '.json'), 'utf8');
assert.strictEqual(staleRaw, '{"id":"' + stale + '"}');                     // 旧文件原样未动
assert.strictEqual(fs.readdirSync(path.join(dupDir, 'data', 'inbox')).length, 2);

fs.rmSync(dir, { recursive: true, force: true });
console.log('butler ok');
