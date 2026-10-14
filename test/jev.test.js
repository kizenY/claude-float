const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jev = require('../jev');

// 测试期间把 home 指到临时目录：logPath() 会 fallback 读 ~/.claude-float/jev.json，
// 不隔离的话本机配了 jev.json 就会让「未配置 → null」的用例失败
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-home-'));
const realHomedir = os.homedir;
os.homedir = () => fakeHome;
process.on('exit', () => { os.homedir = realHomedir; });

// 行解析：gateway.log 的真实格式
const r1 = jev.parseLine('2026-10-14 14:12:25,842 INFO route=opus score=- conf=- in=787 out=562 56658ms messages-stream (strong preferred -> opus)');
assert.strictEqual(r1.tier, 'hi');
assert.strictEqual(r1.judged, false);
assert.strictEqual(r1.ms, 56658);
assert.ok(r1.at > 0);

const r2 = jev.parseLine('2026-10-14 14:03:01,001 INFO route=haiku score=0.31 conf=0.95 in=1234 out=567 1200ms stream (score 0.31 <= 0.5, simple question)');
assert.strictEqual(r2.tier, 'lo');
assert.strictEqual(r2.judged, true);
assert.strictEqual(r2.ms, 1200);

const r3 = jev.parseLine('2026-10-14 14:03:10,200 INFO route=glm-flash score=0.10 conf=0.99 in=100 out=50 300ms messages (simple)');
assert.strictEqual(r3.tier, 'lo');

// 非 route 行
assert.strictEqual(jev.parseLine('2026-10-14 14:12:24,068 INFO HTTP Request: POST https://open.bigmodel.cn/api/anthropic/v1/messages "HTTP/1.1 200 OK"'), null);
assert.strictEqual(jev.parseLine('garbage'), null);

// route → 档位
assert.strictEqual(jev.tierOf('opus'), 'hi');
assert.strictEqual(jev.tierOf('glm-strong'), 'hi');
assert.strictEqual(jev.tierOf('haiku'), 'lo');
assert.strictEqual(jev.tierOf('glm-flash'), 'lo');
assert.strictEqual(jev.tierOf('other'), null);

// stats()：临时日志文件走 env 配置；追加写改变 size 必破 mtime/size 缓存
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-test-'));
const log = path.join(dir, 'gateway.log');
fs.writeFileSync(log, [
  '2026-10-14 14:03:01,001 INFO route=haiku score=0.31 conf=0.95 in=1234 out=567 1200ms stream (simple)',
  '2026-10-14 14:12:25,842 INFO route=opus score=- conf=- in=787 out=562 56658ms messages-stream (strong preferred)',
  '2026-10-14 14:12:24,068 INFO HTTP Request: POST https://x "HTTP/1.1 200 OK"',
  '',
].join('\n'));
process.env.CLAUDE_FLOAT_JEV_LOG = log;
const st1 = jev.stats();
assert.strictEqual(st1.hi, 1);
assert.strictEqual(st1.lo, 1);
assert.strictEqual(st1.judged, 1);
assert.strictEqual(st1.total, 2);
assert.strictEqual(st1.avgMs, Math.round((1200 + 56658) / 2));
assert.strictEqual(st1.online, false); // 日志时间是过去，早超出在线窗口

// 追加一条低档，缓存应刷新
fs.appendFileSync(log, '2026-10-14 15:00:00,000 INFO route=glm-flash score=0.10 conf=0.99 in=1 out=1 10ms messages (simple)\n');
const st2 = jev.stats(0); // now=0 也不影响计数
assert.strictEqual(st2.total, 3);
assert.strictEqual(st2.lo, 2);

// 没配路径、fakeHome 下也没有 jev.json → null
delete process.env.CLAUDE_FLOAT_JEV_LOG;
assert.strictEqual(jev.stats(), null);

// ~/.claude-float/jev.json 也能配
const log2 = path.join(dir, 'gateway2.log');
fs.writeFileSync(log2, '2026-10-14 14:03:01,001 INFO route=haiku score=0.31 conf=0.95 in=1 out=1 5ms stream (simple)\n');
fs.mkdirSync(path.join(fakeHome, '.claude-float'), { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.claude-float', 'jev.json'), JSON.stringify({ log: log2 }));
const st3 = jev.stats();
assert.strictEqual(st3.total, 1);
assert.strictEqual(st3.lo, 1);

// 文件消失 → null
fs.unlinkSync(log2);
assert.strictEqual(jev.stats(), null);

os.homedir = realHomedir;
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log('jev ok');
