const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ext = require('../extensions');

// 全程用临时目录，不碰真实的 ~/.claude-float/extensions.json
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-float-ext-'));
const reg = path.join(dir, 'registry.json');
const E = (code, fn) => {
  try { fn(); } catch (e) { assert.strictEqual(e.code, code, `期望错误码 ${code}，得到 ${e.code}：${e.message}`); return e; }
  throw new Error(`期望抛 ${code}，但通过了`);
};

// ---- manifest 校验 ----
const good = {
  apiVersion: 1, id: 'tasks', name: '任务', version: '0.1.0',
  entry: ['node', 'bin/x.js'], contributes: { panel: { title: '任务' } },
  capabilities: ['prompt.insert'],
};
assert.strictEqual(ext.validateManifest(good).id, 'tasks');
assert.strictEqual(ext.validateManifest({ ...good, contributes: { panel: true } }).contributes.panel, true);
assert.strictEqual(ext.validateManifest({ ...good, capabilities: undefined }).capabilities.length, 0);
E('manifest', () => ext.validateManifest({ ...good, id: 'Tasks' }));   // 大写
E('manifest', () => ext.validateManifest({ ...good, id: 't' }));       // 太短
E('manifest', () => ext.validateManifest({ ...good, id: 'float' }));   // 保留字
E('manifest', () => ext.validateManifest({ ...good, id: 'claude' }));
E('manifest', () => ext.validateManifest({ ...good, apiVersion: 2 }));
E('manifest', () => ext.validateManifest({ ...good, name: '' }));
E('manifest', () => ext.validateManifest({ ...good, entry: 'node' }));            // 不是数组
E('manifest', () => ext.validateManifest({ ...good, entry: [] }));
E('manifest', () => ext.validateManifest({ ...good, capabilities: ['nope'] }));   // 未知能力
E('manifest', () => ext.validateManifest(null));

// loadManifest：目录里真实读 + 坏 JSON 报错
const extDir = path.join(dir, 'my-ext');
fs.mkdirSync(path.join(extDir, 'bin'), { recursive: true });
fs.writeFileSync(path.join(extDir, ext.MANIFEST_NAME), JSON.stringify({ ...good, entry: ['node', 'bin/run.js'] }));
fs.writeFileSync(path.join(extDir, 'bin', 'run.js'), '');
assert.strictEqual(ext.loadManifest(extDir).name, '任务');
const badDir = path.join(dir, 'bad');
fs.mkdirSync(badDir);
fs.writeFileSync(path.join(badDir, ext.MANIFEST_NAME), '{oops');
E('manifest', () => ext.loadManifest(badDir));
E('manifest', () => ext.loadManifest(path.join(dir, '不存在')));

// .cmd 入口一律拒绝（不经 shell 起不来）
E('entry', () => ext.checkEntryFiles(extDir, ['bin/run.cmd']));
E('entry', () => ext.checkEntryFiles(extDir, ['bin/不存在.js']));

// ---- 注册表 CRUD ----
const e1 = ext.registryAdd(extDir, reg);
assert.strictEqual(e1.id, 'tasks'); // id 来自 manifest，不是目录名
assert.strictEqual(ext.loadRegistry(reg).length, 1);
E('duplicate', () => ext.registryAdd(extDir, reg));       // 同 id 重复装
assert.strictEqual(ext.registryAdd(writeExt('another', '另一个'), reg).enabled, true);
assert.strictEqual(ext.loadRegistry(reg).length, 2);
assert.strictEqual(ext.registrySetEnabled('tasks', false, reg).enabled, false);
assert.strictEqual(ext.loadRegistry(reg).find((x) => x.id === 'tasks').enabled, false);
assert.strictEqual(ext.registryRemove('tasks', reg), true);
assert.strictEqual(ext.registryRemove('tasks', reg), false);
assert.strictEqual(ext.loadRegistry(reg).length, 1);
// 合并视图：manifest 坏掉的条目不拖垮整表（直接塞进注册表，绕过 add 时的校验）
const broken = writeExt('broken', '坏的');
fs.writeFileSync(path.join(broken, ext.MANIFEST_NAME), '{oops');
ext.saveRegistry([...ext.loadRegistry(reg), { id: 'broken', dir: broken, enabled: true, addedAt: 1 }], reg);
const listed = ext.listInstalled(reg);
assert.strictEqual(listed.length, 2); // another（manifest 有效）+ broken（坏）
assert.strictEqual(listed.filter((x) => x.manifest).length, 1);
assert.strictEqual(listed.find((x) => x.error).entry.id, 'broken');
// 写坏一半的注册表文件当空表
const badReg = path.join(dir, 'bad-registry.json');
fs.writeFileSync(badReg, '{oops');
assert.strictEqual(ext.loadRegistry(badReg).length, 0);

// ---- 视图词汇校验 ----
const view = {
  title: '面板', toolbar: [{ id: 't', label: '刷新', effects: [{ type: 'refresh' }] }],
  sections: [{ id: 's1', title: '组一', items: [
    { id: 'i1', title: '条目', subtitle: '副题', meta: '备注', detail: '详情',
      badges: [{ text: '新', tone: 'info' }],
      actions: [{ id: 'a1', label: '插入', effects: [{ type: 'prompt.insert', text: '你好', sessionId: 's' }] }] },
  ] }],
};
ext.validateViewBody(view); // 合法整棵通过
E('view', () => ext.validateViewBody({ ...view, sections: Array.from({ length: ext.LIMITS.sections + 1 }, (_, i) => ({ id: 's' + i, items: [] })) }));
E('view', () => ext.validateViewBody({ sections: [{ id: 's', items: Array.from({ length: ext.LIMITS.items + 1 }, (_, i) => ({ id: 'i' + i, title: 'x' })) }] }));
E('view', () => ext.validateViewBody({ sections: [{ id: 's', items: [{ id: 'i', title: 'x', actions: [{ id: 'a', label: 'x', effects: [{ type: 'hack' }] }] }] }] }));
E('view', () => ext.validateViewBody({ sections: [{ id: 's', items: [{ id: 'i', title: 'x', actions: [{ id: 'a', label: 'x', effects: [{ type: 'prompt.send', text: 'a'.repeat(ext.LIMITS.prompt + 1), sessionId: 's' }] }] }] }] }));
E('view', () => ext.validateViewBody({ sections: [{ id: 's', items: [{ id: 'i', title: 'x', badges: [{ text: 'b', tone: 'pink' }] }] }] }));
E('view', () => ext.validateViewBody({ sections: [{ id: 's', items: [{ id: 'i', title: 'x' }] }], toolbar: [{ id: 'a' }] })); // 动作缺 label
E('view', () => ext.validateViewBody({ sections: [{ id: 's', items: [{ id: 'i', title: 'x', detail: 'x'.repeat(ext.LIMITS.detail + 1) }] }] }));
E('view', () => ext.validateViewBody(null));

// parseViewOutput：{view} 走校验；{error} 透传；坏的 view 整块无效
assert.strictEqual(ext.parseViewOutput({ view }).ok, true);
assert.deepStrictEqual(ext.parseViewOutput({ error: { code: 'x', message: '不行' } }).error.code, 'x');
const hackView = { sections: [{ id: 's', items: [{ id: 'i', title: 'x', actions: [{ id: 'a', label: 'x', effects: [{ type: 'hack' }] }] }] }] };
const bad1 = ext.parseViewOutput({ view: hackView });
assert.strictEqual(bad1.ok, false);
assert.ok(bad1.error.message.includes('无法识别'), '坏 view 报「无法识别」');

// ---- 能力检查：未声明的能力一律拒绝；copy/refresh 免声明 ----
assert.strictEqual(ext.checkEffects([{ type: 'copy', text: 'x' }, { type: 'refresh' }], []), true);
assert.strictEqual(ext.checkEffects([{ type: 'prompt.insert', text: 'x', sessionId: 's' }], ['prompt.insert']), true);
E('capability', () => ext.checkEffects([{ type: 'prompt.send', text: 'x', sessionId: 's' }], ['prompt.insert']));
E('capability', () => ext.checkEffects([{ type: 'session.create', cwd: 'C:\\x' }], []));
E('view', () => ext.checkEffects([{ type: 'hack' }], [])); // 未知类型在形状校验就被拦下
assert.strictEqual(ext.needsConfirm({ effects: [{ type: 'prompt.send', text: 'x', sessionId: 's' }] }), true);
assert.strictEqual(ext.needsConfirm({ effects: [{ type: 'session.create', cwd: 'C:\\x' }] }), true);
assert.strictEqual(ext.needsConfirm({ destructive: true, effects: [{ type: 'refresh' }] }), true);
assert.strictEqual(ext.needsConfirm({ effects: [{ type: 'copy', text: 'x' }] }), false);

// ---- 环境变量白名单 + PATH 清理 ----
const env = ext.buildEnv({ FLOAT_EXT_DIR: extDir }, {
  HOME: '/home/u', SECRET: '不给你', NO_COLOR: '1', LC_ALL: 'C.UTF-8',
  PATH: path.join('rel', 'dir') + path.delimiter + path.delimiter + path.join(path.sep, 'abs', 'a') + path.delimiter + '.' + path.delimiter + path.join(path.sep, 'abs', 'b'),
});
assert.strictEqual(env.HOME, '/home/u');
assert.strictEqual(env.SECRET, undefined);
assert.strictEqual(env.LC_ALL, 'C.UTF-8');
assert.strictEqual(env.FLOAT_EXT_DIR, extDir);
assert.ok(!env.PATH.includes('rel'), 'PATH 里的相对段被清掉');
assert.ok(env.PATH.includes(path.join(path.sep, 'abs', 'b')), '绝对路径段保留');

// ---- 调用协议：拿真实的小 Node 脚本当被测扩展 ----
function writeExt(id, name, script) {
  const d = path.join(dir, id);
  fs.mkdirSync(path.join(d, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(d, ext.MANIFEST_NAME), JSON.stringify({
    apiVersion: 1, id, name, version: '0.1.0', entry: ['node', 'bin/run.js'],
    contributes: { panel: true }, capabilities: ['prompt.insert', 'prompt.send', 'session.create'],
  }));
  fs.writeFileSync(path.join(d, 'bin', 'run.js'), script || '');
  return d;
}
const countFile = path.join(dir, 'count.txt');
const echoExt = writeExt('echo-ext', '回声', `"use strict";
const fs = require('fs');
let inJson = '';
process.stdin.on('data', (c) => { inJson += c; });
process.stdin.on('end', () => {
  const input = JSON.parse(inJson);
  const n = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) + 1 : 1;
  fs.writeFileSync(${JSON.stringify(countFile)}, String(n));
  if (input.context.cwd === 'FAIL') { console.log(JSON.stringify({ error: { code: 'nope', message: '故意失败' } })); return; }
  console.log(JSON.stringify({ view: { sections: [{ id: 's', title: input.context.cwd || '无目录', items: [
    { id: 'i', title: '第 ' + n + ' 次调用',
      actions: [{ id: 'a', label: '插入', effects: [{ type: 'prompt.insert', text: 'hi', sessionId: 's1' }] }] },
  ] }] } }));
});
`);
const echoM = ext.loadManifest(echoExt);

(async () => {
  // stdin → stdout 一来一回，输入里的 cwd 透传到输出
  const r1 = await ext.invoke(echoM, 'view', ext.buildViewInput({ cwd: 'C:\\work\\demo' }));
  assert.strictEqual(r1.ok, true);
  const p1 = ext.parseViewOutput(r1.json);
  assert.strictEqual(p1.ok, true);
  assert.strictEqual(p1.view.sections[0].title, 'C:\\work\\demo');
  assert.strictEqual(fs.readFileSync(countFile, 'utf8'), '1');

  // 扩展主动报 {error}：ok 但 view 解析为失败
  const r2 = await ext.invoke(echoM, 'view', ext.buildViewInput({ cwd: 'FAIL' }));
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(ext.parseViewOutput(r2.json).error.message, '故意失败');

  // 超时：睡 10s 的扩展被 300ms 掐掉
  const slowExt = writeExt('slow-ext', '慢性子', 'setTimeout(() => {}, 10000);');
  const r3 = await ext.invoke(ext.loadManifest(slowExt), 'view', ext.buildViewInput({}), { timeout: 300 });
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.error.code, 'timeout');

  // 非零退出码 / 坏 JSON
  const crashExt = writeExt('crash-ext', '暴脾气', 'process.exit(3);');
  assert.strictEqual((await ext.invoke(ext.loadManifest(crashExt), 'view', {})).error.code, 'exit');
  const junkExt = writeExt('junk-ext', '乱说话', 'console.log("不是json");');
  assert.strictEqual((await ext.invoke(ext.loadManifest(junkExt), 'view', {})).error.code, 'output');

  // 入口文件被删 / PATH 里找不到的裸命令
  const ghostExt = writeExt('ghost-ext', '隐身人');
  fs.rmSync(path.join(ghostExt, 'bin', 'run.js'));
  assert.strictEqual((await ext.invoke(ext.loadManifest(ghostExt), 'view', {})).error.code, 'entry');
  const lostCmd = ext.validateManifest({ ...good, id: 'lost-cmd', entry: ['这条命令不存在xyz'] });
  assert.strictEqual((await ext.invoke(lostCmd, 'view', {})).error.code, 'entry');

  // 读取缓存：15s 内同上下文只跑一次进程，force 强制重跑；失败不缓存
  const n0 = Number(fs.readFileSync(countFile, 'utf8'));
  await ext.readView(echoM, { cwd: 'C:\\cached' });
  await ext.readView(echoM, { cwd: 'C:\\cached' });
  assert.strictEqual(Number(fs.readFileSync(countFile, 'utf8')), n0 + 1, '缓存命中不重跑');
  await ext.readView(echoM, { cwd: 'C:\\cached', force: true });
  assert.strictEqual(Number(fs.readFileSync(countFile, 'utf8')), n0 + 2, 'force 强制重跑');
  ext.invalidate('echo-ext');
  await ext.readView(echoM, { cwd: 'C:\\cached' });
  assert.strictEqual(Number(fs.readFileSync(countFile, 'utf8')), n0 + 3, 'invalidate 后重跑');
  await ext.readView(echoM, { cwd: 'FAIL' });
  await ext.readView(echoM, { cwd: 'FAIL' });
  assert.strictEqual(Number(fs.readFileSync(countFile, 'utf8')), n0 + 4, '扩展报 {error} 也是一次正常读取，照常缓存');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('extensions ok');
})().catch((e) => { console.error(e); process.exit(1); });
