// 假扮 Claude Code：拉起频道服务器，握手，模拟浮窗发消息，确认它推出 notifications/claude/channel；
// 再走一遍 todos_* tools，确认会话里能直接管代办单
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION = `test-${Date.now()}`;
// 把子进程的 home 指到临时目录：todos.json、频道登记都不碰真实文件
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-float-channel-'));
const child = spawn(process.execPath, [path.join(__dirname, '..', 'channel', 'server.js')], {
  env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION, USERPROFILE: tmpHome, HOME: tmpHome },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const regFile = path.join(tmpHome, '.claude-float', 'channels', `${child.pid}.json`);
const todosFile = path.join(tmpHome, '.claude-float', 'todos.json');

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

    // ---- todos tools：会话里直接管代办 ----
    assert.ok(init.result.capabilities.tools, 'tools capability declared');
    let id = 10;
    // 注意 call 只能在 wait 外调一次：写进谓词会每 50ms 重发一遍请求
    const call = (name, args) => { send({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }); return id; };
    const waitCall = async (name, args) => {
      const rid = call(name, args);
      return wait((m) => m.id === rid && m.result);
    };

    send({ jsonrpc: '2.0', id: ++id, method: 'tools/list' });
    const tl = await wait((m) => m.id === id && m.result && m.result.tools);
    assert.deepStrictEqual(tl.result.tools.map((t) => t.name).sort(),
      ['todos_add', 'todos_bind', 'todos_list', 'todos_remove', 'todos_toggle']);

    const empty = await waitCall('todos_list');
    assert.ok(empty.result.content[0].text.includes('没有'), 'empty list message');

    const added = await waitCall('todos_add', { title: '在会话里记一张', desc: 'MCP 加的' });
    const addedText = added.result.content[0].text;
    assert.ok(!added.result.isError, addedText);
    assert.ok(addedText.includes('在会话里记一张'), addedText);
    const todoId = (addedText.match(/\[(t-[^\]]+)\]/) || [])[1];
    assert.ok(todoId, 'todo id returned');

    // 落盘核对：工作区=子进程 cwd，且自动挂了本会话
    const onDisk = JSON.parse(fs.readFileSync(todosFile, 'utf8')).find((t) => t.id === todoId);
    assert.strictEqual(onDisk.ws, process.cwd());
    assert.deepStrictEqual(onDisk.sessions, [SESSION]);

    const listed = await waitCall('todos_list', { status: 'all' });
    assert.ok(listed.result.content[0].text.includes('在会话里记一张'), listed.result.content[0].text);

    const toggled = await waitCall('todos_toggle', { id: todoId });
    assert.ok(toggled.result.content[0].text.includes('已完成'), toggled.result.content[0].text);
    assert.strictEqual(JSON.parse(fs.readFileSync(todosFile, 'utf8')).find((t) => t.id === todoId).status, 'done');

    const toggled2 = await waitCall('todos_toggle', { id: todoId });
    assert.ok(toggled2.result.content[0].text.includes('重新打开'), toggled2.result.content[0].text);

    const bound = await waitCall('todos_bind', { id: todoId });
    assert.ok(bound.result.content[0].text.includes('挂到本会话'), bound.result.content[0].text);

    const badId = await waitCall('todos_toggle', { id: 't-nope' });
    assert.ok(badId.result.isError, 'missing todo is an error');

    const removed = await waitCall('todos_remove', { id: todoId });
    assert.ok(!removed.result.isError, removed.result.content[0].text);
    assert.strictEqual(JSON.parse(fs.readFileSync(todosFile, 'utf8')).length, 0, 'file empty after remove');

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
