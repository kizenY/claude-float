// exts/todos + exts/usage：官方扩展的单测。
// 重点：扩展 store 与浮窗核心 todos.js 共用同一份 todos.json，两边必须互认（schema 兼容）；
// bin 入口按两个宿主的调用约定（argv[2]=op + stdin JSON）各跑一次端到端。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const coreTodos = require('../todos');
const store = require('../exts/todos/lib/store');
const views = require('../exts/todos/lib/views');
const glm = require('../exts/usage/lib/glm');

let n = 0;
function ok(name, fn) {
  n++;
  fn();
  console.log(`  ✓ ${name}`);
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ext-'));
}

// ---- todos store：与核心共用 todos.json，互认 ----

ok('store 读到核心 todos.create 写的任务，toggle/bind 回写后核心也认', () => {
  const home = tmpHome();
  const file = path.join(home, 'todos.json');
  const a = coreTodos.create({ title: '任务A', desc: '内容A', goal: '目标A', ws: 'E:\\w\\a' }, file);
  coreTodos.create({ title: '任务B', ws: 'E:\\w\\b' }, file);

  let list = store.load(file);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].title, '任务B', '新的在最上面（unshift）');

  const done = store.toggle(a.id, 'trine 面板手动标记完成', 'trine', file);
  assert.strictEqual(done.status, 'done');
  assert.ok(done.doneAt);
  assert.strictEqual(done.progressLog.at(-1).text, 'trine 面板手动标记完成');

  const bound = store.bind(a.id, 'sess-1', file);
  assert.deepStrictEqual(bound.sessions, ['sess-1']);

  // 核心读回来一切正常（字段没被写坏）
  list = coreTodos.load(file);
  const a2 = list.find((t) => t.id === a.id);
  assert.strictEqual(a2.status, 'done');
  assert.strictEqual(a2.sessions[0], 'sess-1');
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- todos views ----

ok('floatView：进行中/最近完成两段，动作只有静态效果', () => {
  const tasks = [
    { id: 't-1', title: '任务A', goal: '目标A', desc: '内容A', ws: 'E:\\w\\a', status: 'open', pct: 40, sessions: ['s1'], progressLog: [{ at: 1, text: '起步', by: 's1' }] },
    { id: 't-2', title: '任务B', ws: 'E:\\w\\b', status: 'done', doneAt: 5, sessions: [], progressLog: [] },
  ];
  const v = views.floatView(tasks);
  assert.strictEqual(v.sections.length, 2);
  const open = v.sections[0].items[0];
  assert.strictEqual(open.id, 't-1');
  assert.ok(!('sessions' in open), '浮窗契约没有 sessions 字段');
  assert.deepStrictEqual(open.actions.map((a) => a.id), ['spawn', 'copy-hint']);
  assert.strictEqual(open.actions[0].effects[0].type, 'session.create');
  assert.match(open.actions[1].effects[0].text, /todos_bind/);
  assert.strictEqual(v.sections[1].items[0].title, '任务B');
  assert.ok(!v.sections[1].items[0].actions, '已完成的没有动作');
});

ok('trineView：合并 todos.json 绑定与 trine 关联；workspacePanel 的插入退化为复制', () => {
  const tasks = [{ id: 't-1', title: '任务A', ws: 'E:\\w\\a', status: 'open', sessions: ['s1'], progressLog: [] }];
  const linkedSessions = [{ id: 's2', links: [{ ref: 't-1', label: '任务A' }] }];
  const panel = views.trineView(tasks, { point: 'sessionPanel', linkedSessions });
  const item = panel.sections[0].items[0];
  assert.deepStrictEqual(item.sessions.sort(), ['s1', 's2']);
  assert.deepStrictEqual(item.actions.map((a) => a.id), ['take', 'new', 'toggle']);
  assert.strictEqual(item.actions[0].effects[0].type, 'prompt.insert');
  assert.strictEqual(item.actions[1].effects[0].type, 'session.create');
  assert.strictEqual(item.actions[2].invoke.params.todoId, 't-1');

  const ws = views.trineView(tasks, { point: 'workspacePanel', linkedSessions });
  const wsItem = ws.sections[0].items[0];
  assert.strictEqual(wsItem.actions[0].effects[0].type, 'copy', '工作区面板没有输入框，插入退化为复制');
  assert.match(wsItem.actions[0].label, /复制/);
});

ok('badgeFor：绑着进行中任务的会话亮徽章，闲会话 null', () => {
  const tasks = [
    { id: 't-1', title: '很短', status: 'open', sessions: [], createdAt: 1 },
    { id: 't-2', title: '一个很长很长的任务标题', status: 'open', sessions: ['s1'], createdAt: 2 },
    { id: 't-3', title: '已完成的', status: 'done', sessions: ['s1'], createdAt: 3 },
  ];
  assert.deepStrictEqual(views.badgeFor(tasks, { id: 's1' }), { badge: { text: '任·一个很长很长的任务…', tone: 'info' } });
  // trine 关联（ref）也算绑
  assert.ok(views.badgeFor(tasks, { id: 's9', links: [{ ref: 't-1', label: '很短' }] }).badge);
  assert.strictEqual(views.badgeFor(tasks, { id: 's8' }), null);
  assert.strictEqual(views.badgeFor(tasks, null), null);
});

ok('pickItems：linkPicker 纯关联候选；newSession 带预填接手提示', () => {
  const tasks = [
    { id: 't-1', title: '任务A', goal: '目标A', status: 'open', sessions: [] },
    { id: 't-2', title: '任务B', status: 'done', sessions: [] },
  ];
  const link = views.pickItems(tasks, 'linkPicker');
  assert.deepStrictEqual(link.map((x) => x.id), ['t-1']);
  assert.deepStrictEqual(link[0].link, { ref: 't-1', label: '任务A' });
  assert.ok(!link[0].effects);

  const ns = views.pickItems(tasks, 'newSession');
  assert.strictEqual(ns[0].effects[0].type, 'prompt.insert');
  assert.match(ns[0].effects[0].text, /todos_bind/);
});

// ---- todos bin：按宿主约定端到端跑一次 ----

ok('bin/ext.js view：浮窗 point=panel，stdin JSON 进 stdout JSON 出', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude-float'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-float', 'todos.json'), JSON.stringify([
    { id: 't-1', title: '端到端', ws: 'E:\\w\\a', status: 'open', sessions: [], progressLog: [], pct: 10 },
  ]));
  const r = spawnSync(process.execPath, [path.join('exts', 'todos', 'bin', 'ext.js'), 'view'], {
    input: JSON.stringify({ apiVersion: 1, op: 'view', point: 'panel', context: { cwd: null, sessions: [] }, args: {} }),
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.view.sections[0].items[0].title, '端到端');
  fs.rmSync(home, { recursive: true, force: true });
});

ok('bin/ext.js 不认识的 op → error.unsupported', () => {
  const r = spawnSync(process.execPath, [path.join('exts', 'todos', 'bin', 'ext.js'), 'dance'], {
    input: '{}', encoding: 'utf8', timeout: 10000,
  });
  assert.strictEqual(JSON.parse(r.stdout).error.code, 'unsupported');
});

// ---- usage ----
// 真实响应结构（2026-10 实测 bigmodel：两条 CREDIT_LIMIT，5 小时窗 + 周窗）
const REAL = {
  code: 200, msg: 'Operation successful', success: true,
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 17070, remaining: 10929, percentage: 60, nextResetTime: 1791961073765 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 140000, currentValue: 52360, remaining: 87639, percentage: 37, nextResetTime: 1792217915982 },
    ],
    level: 'max',
  },
};

ok('glm.extract：升序排窗、level 保留、畸形输入 null（与老 glm-usage 同口径）', () => {
  const u = glm.extract(REAL, 1791959000000);
  assert.strictEqual(u.level, 'max');
  assert.strictEqual(u.windows[0].pct, 60);
  assert.strictEqual(u.windows[0].resetAt, 1791961073765);
  assert.strictEqual(u.windows[1].pct, 37);
  assert.strictEqual(glm.extract(null), null);
  assert.strictEqual(glm.extract({ data: { limits: [] } }), null);
});

ok('usage bin：没配 glm.json → 空面板提示配置；配了+新鲜缓存 → 直接渲染缓存（不联网）', () => {
  const run = (home) => spawnSync(process.execPath, [path.join('exts', 'usage', 'bin', 'ext.js'), 'view'], {
    input: JSON.stringify({ op: 'view', point: 'panel', context: {}, args: {} }),
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: 'utf8',
    timeout: 10000,
  });

  const empty = tmpHome();
  const r1 = run(empty);
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.match(JSON.parse(r1.stdout).view.sections[0].empty, /未配置/);

  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude-float'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-float', 'glm.json'), JSON.stringify({ apiKey: 'k-test' }));
  fs.writeFileSync(path.join(home, '.claude-float', 'usage-cache.json'), JSON.stringify(glm.extract(REAL)));
  const r2 = run(home);
  const view = JSON.parse(r2.stdout).view;
  assert.match(view.title, /max/);
  assert.strictEqual(view.sections[0].items[0].title, '5小时窗');
  assert.match(view.sections[0].items[0].subtitle, /60%/);
  assert.strictEqual(view.sections[0].items[1].title, '周窗');
  for (const h of [empty, home]) fs.rmSync(h, { recursive: true, force: true });
});

// ---- manifest：浮窗侧 ext.js validate 两个扩展目录 ----

ok('ext.js validate 认可两个官方扩展的 manifest', () => {
  for (const id of ['todos', 'usage']) {
    const r = spawnSync(process.execPath, ['ext.js', 'validate', path.join('exts', id)], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(r.status, 0, `${id}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(id));
  }
});

console.log(`exts.test.js 通过 (${n})`);
