const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const glmUsage = require('../glm-usage');

// 真实响应结构（2026-10 实测 bigmodel：两条 CREDIT_LIMIT，5 小时窗 + 周窗）
const REAL = {
  code: 200,
  msg: 'Operation successful',
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28000, currentValue: 17070, remaining: 10929, percentage: 60, nextResetTime: 1791961073765 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 140000, currentValue: 52360, remaining: 87639, percentage: 37, nextResetTime: 1792217915982 },
    ],
    level: 'max',
  },
  success: true,
};

const u = glmUsage.extract(REAL, 1791959000000);
assert.strictEqual(u.level, 'max');
assert.strictEqual(u.windows.length, 2);
// 按重置时间升序：5 小时窗（重得更近）在前
assert.strictEqual(u.windows[0].pct, 60);
assert.strictEqual(u.windows[0].remaining, 10929);
assert.strictEqual(u.windows[0].resetAt, 1791961073765);
assert.strictEqual(u.windows[1].pct, 37);
assert.strictEqual(u.fetchedAt, 1791959000000);

// 畸形输入一律 null，不抛
assert.strictEqual(glmUsage.extract(null), null);
assert.strictEqual(glmUsage.extract({}), null);
assert.strictEqual(glmUsage.extract({ data: {} }), null);
assert.strictEqual(glmUsage.extract({ data: { limits: [] } }), null);
assert.strictEqual(glmUsage.extract({ data: { limits: [{ percentage: 'x' }] } }), null);

// percentage 缺数字的窗口被滤掉，剩下的照常
const partial = glmUsage.extract({ data: { level: 'lite', limits: [{ percentage: 42, nextResetTime: 5 }, { foo: 1 }] } });
assert.strictEqual(partial.level, 'lite');
assert.strictEqual(partial.windows.length, 1);
assert.strictEqual(partial.windows[0].pct, 42);

// loadConf：monkey-patch homedir 隔离本机 glm.json（没有配置 → null）
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-home-'));
const realHomedir = os.homedir;
os.homedir = () => fakeHome;
assert.strictEqual(glmUsage.loadConf(), null);

// 配了 key 读得到；apiKey 空也算没配
const confDir = path.join(fakeHome, '.claude-float');
fs.mkdirSync(confDir, { recursive: true });
fs.writeFileSync(path.join(confDir, 'glm.json'), JSON.stringify({ apiKey: 'k-test' }));
const conf = glmUsage.loadConf();
assert.strictEqual(conf.apiKey, 'k-test');
assert.strictEqual(conf.endpoint, 'https://open.bigmodel.cn'); // 默认端点
fs.writeFileSync(path.join(confDir, 'glm.json'), JSON.stringify({ apiKey: 'k2', endpoint: 'https://api.z.ai' }));
assert.strictEqual(glmUsage.loadConf().endpoint, 'https://api.z.ai');
fs.writeFileSync(path.join(confDir, 'glm.json'), JSON.stringify({ apiKey: '' }));
assert.strictEqual(glmUsage.loadConf(), null);

os.homedir = realHomedir;
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log('glm-usage ok');
