// 从浮窗快速回复命令行会话：POST 给会话里的浮窗频道（channel/server.js），再看会话记录里有没有出现这条消息
const { clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const focus = require('./focus');

// 会话记录里出现这条消息（直接发出、进了排队，或者作为频道消息）就算送达
async function waitInTranscript(file, text, sinceSize, timeoutMs = 10000) {
  const needle = text.trim().slice(0, 30);
  const escaped = JSON.stringify(needle).slice(1, -1); // 记录里可能是转义过的
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { size } = fs.statSync(file);
      if (size > sinceSize) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - sinceSize);
        fs.readSync(fd, buf, 0, buf.length, sinceSize);
        fs.closeSync(fd);
        const added = buf.toString('utf8');
        if (added.includes(needle) || added.includes(escaped)) return true;
      }
    } catch { /* 文件被轮转 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// 走浮窗频道：POST 给会话里的 channel/server.js，由它推进会话，不碰任何窗口
// timeoutMs：等会话记录落盘的时间。有终端降级通道时调用方传短一点，别让用户干等
async function sendViaChannel({ channel, text, file, timeoutMs = 10000 }) {
  text = String(text || '').trim();
  if (!text) return { ok: false, message: '内容是空的' };
  let sinceSize = 0;
  try { sinceSize = fs.statSync(file).size; } catch { /* 忽略 */ }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${channel.port}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${channel.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    return { ok: false, message: '连不上这个会话的频道（会话可能已退出）' };
  }
  if (!res.ok) {
    return { ok: false, message: `频道拒绝了这条消息（HTTP ${res.status}）` };
  }
  const delivered = await waitInTranscript(file, text, sinceSize, timeoutMs);
  return { ok: true, delivered, message: delivered ? '已发送' : '频道没送达（Claude Code 吞了频道消息，已知上游 bug #44181）' };
}

// 降级通道：聚焦会话的终端窗口，剪贴板粘贴 + 回车。
// Claude Code 2.1.x 静默吞 notifications/claude/channel（issue #44181，2.1.81~2.1.296 都没修），
// 频道推不进去时走这里。缺点是会抢一下前台焦点，所以只当降级用。
async function sendViaTerminal({ pid, text, file }) {
  text = String(text || '').trim();
  if (!text) return { ok: false, message: '内容是空的' };
  let sinceSize = 0;
  try { sinceSize = fs.statSync(file).size; } catch { /* 新会话还没有记录文件 */ }
  clipboard.writeText(text); // 先备好，聚焦失败也留在剪贴板里不丢
  const f = await focus.toPid(pid, { noToggle: true });
  if (!f.ok) return { ok: false, message: `${f.message}，内容已复制到剪贴板` };
  const ps = path.join(__dirname, 'scripts', 'paste-enter.ps1');
  const pasted = await new Promise((resolve) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', ps],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve(false); }, 8000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', () => { clearTimeout(timer); resolve(out.trim() === 'ok'); });
  });
  if (!pasted) return { ok: false, message: '按键模拟超时，内容已复制到剪贴板，切到会话窗口自己贴' };
  // transcript 关着的会话（child session 标记）验证不了，直接当成功
  const delivered = file ? await waitInTranscript(file, text, sinceSize, 8000) : true;
  return { ok: true, delivered, message: delivered ? '已粘贴到会话窗口' : '已粘贴，但会话记录里还没看到，留意一下那个窗口' };
}

// 首选的终端通道：往会话的控制台输入缓冲里直接写按键事件（scripts/console-type.ps1），
// 终端读起来和真人打字一模一样，但不切窗口、不动剪贴板、不抢前台。
// 文字走临时文件传，避开命令行代码页/转义问题。
async function sendViaConsole({ pid, text, file }) {
  text = String(text || '').trim();
  if (!text) return { ok: false, message: '内容是空的' };
  let sinceSize = 0;
  try { sinceSize = fs.statSync(file).size; } catch { /* 新会话还没有记录文件 */ }
  const tmp = path.join(os.tmpdir(), `claude-float-reply-${process.pid}-${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    const ps = path.join(__dirname, 'scripts', 'console-type.ps1');
    const result = await new Promise((resolve) => {
      const child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', ps,
         '-TargetPid', String(pid), '-TextFile', tmp],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve('timeout'); }, 8000);
      child.stdout.on('data', (d) => { out += d; });
      child.on('error', () => { clearTimeout(timer); resolve('spawn-failed'); });
      child.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
    });
    if (result !== 'ok') return { ok: false, code: result, message: '没法直接往会话窗口打字' };
    // transcript 关着的会话（child session 标记）验证不了，直接当成功
    const delivered = file ? await waitInTranscript(file, text, sinceSize, 8000) : true;
    return { ok: true, delivered, message: delivered ? '已发送到会话窗口' : '已发送，但会话记录里还没看到，留意一下那个窗口' };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 已删 */ }
  }
}

module.exports = { sendViaChannel, sendViaTerminal, sendViaConsole };
