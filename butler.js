// 管家面板（super-agent 聚合）的底层逻辑：实例注册表 + UI 快照的只读消费、面板动作→inbox 指令构造。
// 侧栏的管家入口已下线（main/renderer 不再接线），模块和测试保留——要恢复面板随时能接回。
// 纯逻辑模块（对齐 todos.js 形态）：默认路径是真实注册表，测试一律传临时文件
const fs = require('fs');
const path = require('path');
const os = require('os');

const REGISTRY = path.join(os.homedir(), '.claude-float', 'butler-instances.json');
const OFFLINE_MS = 90 * 1000;        // 心跳 >90s = 离线（灰显，指令落 inbox 排队仍可派活）
const HIDDEN_MS = 24 * 3600 * 1000;  // 心跳 >24h = 不显示（强杀残留靠心跳自然衰减）

// 读注册表：文件不存在 → null（浮窗整个不渲染「管家」项）；坏 JSON/非法结构 → 空注册表；
// 条目缺 root（非空字符串）→ 丢弃（没有 root 就无法定位实例和快照，也无法派活）
function loadRegistry(file = REGISTRY) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return { instances: [] }; // 别的读失败（占用等）当空，下轮 3s 再试
  }
  let obj;
  try { obj = JSON.parse(raw); } catch { return { instances: [] }; }
  const list = obj && Array.isArray(obj.instances) ? obj.instances : [];
  return { instances: list.filter((i) => i && typeof i.root === 'string' && i.root) };
}

// 心跳两档：online（新鲜）/ offline（>90s 离线灰显）/ hidden（>24h 或心跳缺坏，不显示）
function classifyInstance(entry, now = Date.now()) {
  const hb = entry ? entry.heartbeat_ms : null;
  if (typeof hb !== 'number' || !isFinite(hb)) return 'hidden';
  const age = now - hb;
  if (age > HIDDEN_MS) return 'hidden';
  return age > OFFLINE_MS ? 'offline' : 'online';
}

function tailOf(root) {
  return String(root).split(/[\\/]/).filter(Boolean).pop() || String(root);
}

// 面板可见实例：hidden 剔除；name 缺省用 root 尾段（注册表正常都有 name，这里兜底）
function listInstances(registry, now = Date.now()) {
  const out = [];
  for (const i of ((registry && registry.instances) || [])) {
    const state = classifyInstance(i, now);
    if (state === 'hidden') continue;
    out.push({
      root: i.root,
      name: (typeof i.name === 'string' && i.name) || tailOf(i.root),
      pid: typeof i.pid === 'number' ? i.pid : null,
      version: typeof i.version === 'string' ? i.version : '',
      heartbeat_ms: typeof i.heartbeat_ms === 'number' ? i.heartbeat_ms : null,
      state,
    });
  }
  return out;
}

// 读实例 UI 快照（<root>/data/ui-snapshot.json）：坏文件/缺 root/schema 不符 → null
// （跳过该实例的任务区，不抛——spec：坏文件整体跳过不渲染，实例块本身仍显示可派活）
function readSnapshot(root) {
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(path.join(String(root), 'data', 'ui-snapshot.json'), 'utf8'));
  } catch { return null; }
  if (!snap || typeof snap !== 'object') return null;
  if (snap.schema !== 1) return null; // 按 schema 兼容解析，未来版本等升级浮窗
  if (typeof snap.root !== 'string' || !snap.root) return null;
  return {
    ...snap,
    tasks: (Array.isArray(snap.tasks) ? snap.tasks : []).filter((t) => t && typeof t.id === 'string'),
    red_watches: (Array.isArray(snap.red_watches) ? snap.red_watches : []).filter((w) => w && typeof w.id === 'string'),
  };
}

// 指令 id：ui- + 毫秒 base36 + 6 位随机段（防重复消费；实例侧 inbox 幂等按 id 记账）。
// 随机段 36^6≈21.8 亿（M5.1：原 4 位 36^4≈168 万，同毫秒批量派活实测 10 轮 2 轮碰撞，
// 后果=同名文件覆盖+幂等 skipped_dup 静默丢一条指令）；循环补齐保证随机段恒 6 字符
// （Math.random().toString(36) 的尾数偶尔短于 6 位，直接 slice 会缩水）
function newId() {
  let rnd = '';
  while (rnd.length < 6) rnd += Math.random().toString(36).slice(2, 8);
  return 'ui-' + Date.now().toString(36) + rnd.slice(0, 6);
}

// 面板动作 → user 通道 inbox 指令。模板固定、字段化传参（渲染层拼不出白名单外的指令体）：
// add=派活（task_add，默认 run_now 立即执行；勾「仅入队」则入队不执行）
// approve=owner 批准（waiting_owner→active）；reject=owner 拒绝（waiting_owner→cancelled）
function buildCommand(action, fields = {}) {
  if (action === 'add') {
    const goal = String(fields.goal || '').trim();
    if (!goal) throw new Error('goal required');
    return { id: newId(), type: 'task_add', goal, run_now: fields.queue_only !== true };
  }
  const task_id = String(fields.task_id || '');
  if (!task_id) throw new Error('task_id required');
  if (action === 'approve') {
    return { id: newId(), type: 'task_update', task_id, status: 'active', note: '管家面板：批准' };
  }
  if (action === 'reject') {
    return { id: newId(), type: 'task_update', task_id, status: 'cancelled', note: '管家面板：拒绝' };
  }
  throw new Error('bad action');
}

// dispatch 目标校验：root 必须与注册表条目字符串原样相等（===）。
// 刻意不做 resolve/小写化/斜杠归一——任何规范化都会开出白名单外的路径
// （Windows 8.3 短名/大小写/尾斜杠变体一律拒，QA 实测踩过边界）
function rootAllowed(root, registry) {
  if (typeof root !== 'string' || !root) return false;
  return ((registry && registry.instances) || []).some((i) => i && i.root === root);
}

// 指令落实例 inbox：tmp+rename 原子写（实例消费端按文件名序消费，tmp 后缀不匹配 *.json）。
// 落盘前查重（M5.1 双保险）：目标文件已存在=同 id 碰撞或实例离线期残留的同 id 未消费指令，
// 就地换新 id 重试——直接覆盖会让实例侧幂等按 id 记账 skipped_dup，静默丢一条指令。
// inbox 写者只有本进程，existsSync 无跨进程竞态窗口
function writeCommand(root, cmd) {
  const inbox = path.join(String(root), 'data', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  let file = path.join(inbox, cmd.id + '.json');
  while (fs.existsSync(file)) {
    cmd.id = newId();
    file = path.join(inbox, cmd.id + '.json');
  }
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 6);
  fs.writeFileSync(tmp, JSON.stringify(cmd, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

module.exports = {
  REGISTRY, OFFLINE_MS, HIDDEN_MS,
  loadRegistry, classifyInstance, listInstances, readSnapshot,
  newId, buildCommand, rootAllowed, writeCommand,
};
