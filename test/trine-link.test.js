// trine-link：配置解析 + 深链拼装（纯逻辑）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, sessionUrl, homeUrl, detectAppShortcut, realBrowserExe, splitArgs } = require('../trine-link');

function tmpConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-trine-'));
  const file = path.join(dir, 'trine.json');
  if (obj !== undefined) fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}

let n = 0;
function ok(name, fn) {
  n++;
  fn();
  console.log(`  ✓ ${name}`);
}

ok('合法配置：url 去尾斜杠，machineId 保留，open 默认 auto', () => {
  const cfg = loadConfig(tmpConfig({ url: 'https://trine.example.com:8443/', machineId: 'm-abc123' }));
  assert.deepStrictEqual(cfg, { url: 'https://trine.example.com:8443', machineId: 'm-abc123', open: 'auto' });
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com', machineId: 'm-x', open: 'browser' })).open, 'browser');
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com', machineId: 'm-x', open: 'window' })).open, 'window');
});

ok('app：false 禁用、绝对路径保留、相对路径忽略', () => {
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com', machineId: 'm-x', app: false })).app, false);
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com', machineId: 'm-x', app: 'C:\\Apps\\trine.lnk' })).app, 'C:\\Apps\\trine.lnk');
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com', machineId: 'm-x', app: 'trine.lnk' })).app, undefined);
});

ok('detectAppShortcut：扫到 trine.lnk（大小写不敏感、含子目录），空目录返回 null', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-lnk-'));
  assert.strictEqual(detectAppShortcut(base), null);
  const sub = path.join(base, 'Apps');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'Trine.lnk'), '');
  assert.strictEqual(detectAppShortcut(base), path.join(sub, 'Trine.lnk'));
  // 名字里带 trine 前缀的别的应用也认（浏览器装应用命名不稳定）
  fs.unlinkSync(path.join(sub, 'Trine.lnk'));
  fs.writeFileSync(path.join(sub, 'trine.app.lnk'), '');
  assert.strictEqual(detectAppShortcut(base), path.join(sub, 'trine.app.lnk'));
});

ok('machineId 缺省时从 ~/.trine/identity.json 兜底读', () => {
  const idDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-trine-id-'));
  const identity = path.join(idDir, 'identity.json');
  fs.writeFileSync(identity, JSON.stringify({ v: 1, machineId: 'm-from-trine' }));
  const cfg = loadConfig(tmpConfig({ url: 'https://a.com' }), identity);
  assert.strictEqual(cfg.machineId, 'm-from-trine');
  // 身份文件没有/坏了：machineId 就地留空 → 整个配置无效
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com' }), path.join(idDir, 'none.json')), null);
  // 显式写的 machineId 优先于身份文件
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com', machineId: 'm-mine' }), identity).machineId, 'm-mine');
  fs.rmSync(idDir, { recursive: true, force: true });
});

ok('没有配置文件 → null（未开启 trine 模式）', () => {
  assert.strictEqual(loadConfig(tmpConfig(undefined)), null);
});

ok('坏 JSON / 缺字段 / 非 http(s) scheme → null（身份文件也找不到时）', () => {
  const noIdentity = path.join(os.tmpdir(), 'cf-trine-none', 'identity.json'); // 保证不存在
  assert.strictEqual(loadConfig(tmpConfig('{oops'), noIdentity), null);
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com' }), noIdentity), null);
  assert.strictEqual(loadConfig(tmpConfig({ machineId: 'm-x' }), noIdentity), null);
  assert.strictEqual(loadConfig(tmpConfig({ url: 'file:///etc', machineId: 'm-x' })), null);
  assert.strictEqual(loadConfig(tmpConfig({ url: 'javascript:alert(1)', machineId: 'm-x' })), null);
});

ok('machineId 带不安全字符 → null', () => {
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com', machineId: 'm/x' })), null);
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com', machineId: 'm x' })), null);
});

ok('sessionUrl：/s/<machineId>/<id>', () => {
  const cfg = { url: 'https://t.io', machineId: 'm-1' };
  assert.strictEqual(sessionUrl(cfg, '0c543c39-e1c5-4e36-b76a-eee3ddc2a0a8'),
    'https://t.io/s/m-1/0c543c39-e1c5-4e36-b76a-eee3ddc2a0a8');
});

ok('sessionUrl：会话 id 带不安全字符 → null（防拼出奇怪 URL）', () => {
  const cfg = { url: 'https://t.io', machineId: 'm-1' };
  assert.strictEqual(sessionUrl(cfg, '../../etc'), null);
  assert.strictEqual(sessionUrl(cfg, 'a b'), null);
  assert.strictEqual(sessionUrl(cfg, ''), null);
  assert.strictEqual(sessionUrl(null, 'abc'), null);
});

ok('homeUrl：给空配置 → null', () => {
  assert.strictEqual(homeUrl({ url: 'https://t.io', machineId: 'm-1' }), 'https://t.io');
  assert.strictEqual(homeUrl(null), null);
});


ok('realBrowserExe：proxy 壳换成同目录真身，普通 exe 原样', () => {
  const dir = path.join('C:', 'Chrome');
  assert.strictEqual(realBrowserExe(path.join(dir, 'chrome_proxy.exe')), path.join(dir, 'chrome.exe'));
  assert.strictEqual(realBrowserExe(path.join('C:', 'Edge', 'msedge_proxy.exe')), path.join('C:', 'Edge', 'msedge.exe'));
  assert.strictEqual(realBrowserExe(path.join(dir, 'chrome.exe')), path.join(dir, 'chrome.exe'));
});

ok('splitArgs：按空白拆、丢空段', () => {
  assert.deepStrictEqual(splitArgs(' --profile-directory=Default  --app-id=abc '), ['--profile-directory=Default', '--app-id=abc']);
  assert.deepStrictEqual(splitArgs(''), []);
  assert.deepStrictEqual(splitArgs(undefined), []);
});

console.log(`trine-link.test.js 通过 (${n})`);
