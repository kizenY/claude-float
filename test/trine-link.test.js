// trine-link：配置解析 + 深链拼装（纯逻辑）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, sessionUrl, homeUrl } = require('../trine-link');

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

ok('合法配置：url 去尾斜杠，machineId 保留，open 默认 window', () => {
  const cfg = loadConfig(tmpConfig({ url: 'https://trine.example.com:8443/', machineId: 'm-abc123' }));
  assert.deepStrictEqual(cfg, { url: 'https://trine.example.com:8443', machineId: 'm-abc123', open: 'window' });
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com', machineId: 'm-x', open: 'browser' })).open, 'browser');
});

ok('没有配置文件 → null（未开启 trine 模式）', () => {
  assert.strictEqual(loadConfig(tmpConfig(undefined)), null);
});

ok('坏 JSON / 缺字段 / 非 http(s) scheme → null', () => {
  assert.strictEqual(loadConfig(tmpConfig('{oops')), null);
  assert.strictEqual(loadConfig(tmpConfig({ url: 'https://a.com' })), null);
  assert.strictEqual(loadConfig(tmpConfig({ machineId: 'm-x' })), null);
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

console.log(`trine-link.test.js 通过 (${n})`);
