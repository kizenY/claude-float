// 从浮窗快速回复命令行会话：POST 给会话里的浮窗频道（channel/server.js），再看会话记录里有没有出现这条消息
const { clipboard } = require('electron');
const fs = require('fs');

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
async function sendViaChannel({ channel, text, file }) {
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
    clipboard.writeText(text);
    return { ok: false, message: '连不上这个会话的频道（会话可能已退出），内容已复制到剪贴板' };
  }
  if (!res.ok) {
    clipboard.writeText(text);
    return { ok: false, message: `频道拒绝了这条消息（HTTP ${res.status}），内容已复制到剪贴板` };
  }
  const delivered = await waitInTranscript(file, text, sinceSize);
  return { ok: true, delivered, message: delivered ? '已发送' : '会话 10 秒内没收到。它若空闲，多半是组织没开启 Channels（channelsEnabled）' };
}

module.exports = { sendViaChannel };
