// 假扮 Claude Code：拉起频道服务器，握手，模拟浮窗发消息，确认它推出 notifications/claude/channel
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION = `test-${Date.now()}`;
const child = spawn(process.execPath, [path.join(__dirname, '..', 'channel', 'server.js')], {
  env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const regFile = path.join(os.homedir(), '.claude-float', 'channels', `${child.pid}.json`);

const inbox = [];
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) inbox.push(JSON.parse(line));
  }
});
const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
const wait = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = inbox.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout waiting for message');
};

async function post(reg, token, text) {
  const res = await fetch(`http://127.0.0.1:${reg.port}/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return res.status;
}

(async () => {
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } } });
    const init = await wait((m) => m.id === 1);
    assert.deepStrictEqual(init.result.capabilities.experimental['claude/channel'], {});
    assert.ok(init.result.instructions.includes('claude-float'));
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    let reg;
    for (let i = 0; i < 50 && !reg; i++) {
      try { reg = JSON.parse(fs.readFileSync(regFile, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(reg, 'registration file written');
    assert.strictEqual(reg.sessionId, SESSION);

    assert.strictEqual(await post(reg, 'wrong-token-wrong-token-wrong-token-wrong-to', 'x'), 403);
    assert.strictEqual(await post(reg, reg.token, '   '), 400);
    assert.strictEqual(await post(reg, reg.token, '好的，按方案二来'), 200);

    const note = await wait((m) => m.method === 'notifications/claude/channel');
    assert.strictEqual(note.params.content, '好的，按方案二来');
    assert.strictEqual(inbox.filter((m) => m.method === 'notifications/claude/channel').length, 1, 'rejected posts must not reach Claude');

    child.stdin.end(); // Claude Code 退出
    await new Promise((r) => child.on('exit', r));
    assert.ok(!fs.existsSync(regFile), 'registration removed on exit');
    console.log('channel ok');
  } catch (e) {
    child.kill();
    console.error(e);
    process.exit(1);
  }
})();
