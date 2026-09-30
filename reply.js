// 从浮窗回复 Claude 桌面版的会话：
// 深链接跳到那个会话 → PowerShell + UI Automation 确认页面和输入框 → 粘贴、回车 → 看会话记录里有没有出现这条消息
const { clipboard, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, 'send-reply.ps1');
const LOCAL_ID = /^local_[A-Za-z0-9-]{1,64}$/;

const ERRORS = {
  'session-not-open': '没能在 Claude 里打开这个会话',
  draft: '那个会话的输入框里有没发出去的草稿，没动它',
  'no-foreground': 'Claude 窗口没能切到前台',
  'lost-foreground': '粘贴后 Claude 窗口失去了焦点，没有发送',
  'no-focus': '没能把光标放进输入框',
};

function runScript(args) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { windowsHide: true, timeout: 20000 }, (err, stdout) => {
        const line = String(stdout || '').trim().split(/\r?\n/).pop();
        try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: err ? err.message : 'bad-output' }); }
      });
  });
}

function saveClipboard() {
  const formats = clipboard.availableFormats();
  if (formats.some((f) => f.startsWith('image/'))) return { image: clipboard.readImage() };
  return { text: clipboard.readText() };
}

function restoreClipboard(saved) {
  if (saved.image) clipboard.writeImage(saved.image);
  else clipboard.writeText(saved.text || '');
}

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
  return { ok: true, delivered, message: delivered ? '已发送' : '已交给会话，但还没在会话记录里看到' };
}

async function send({ localId, title, text, file, prevHwnd, minimizeAfter = false, dryRun = false }) {
  text = String(text || '').trim();
  if (!text) return { ok: false, message: '内容是空的' };
  if (!LOCAL_ID.test(localId || '')) return { ok: false, message: '只能回复 Claude 桌面版里的会话' };

  const saved = saveClipboard();
  let sinceSize = 0;
  try { sinceSize = fs.statSync(file).size; } catch { /* 忽略 */ }

  clipboard.writeText(text);
  await shell.openExternal(`claude://code/continue?session=${localId}`);
  const args = ['-TitleB64', Buffer.from(title || '', 'utf8').toString('base64'), '-PrevHwnd', String(prevHwnd || 0)];
  if (dryRun) args.push('-DryRun');
  if (minimizeAfter) args.push('-MinimizeAfter');
  const res = await runScript(args);

  if (!res.ok) {
    // 失败时把内容留在剪贴板，方便手动粘贴
    return { ok: false, message: `${ERRORS[res.error] || res.error}，内容已复制到剪贴板`, detail: res };
  }
  setTimeout(() => restoreClipboard(saved), 600);
  if (dryRun) return { ok: true, dryRun: true, detail: res };

  const delivered = await waitInTranscript(file, text, sinceSize);
  return { ok: true, delivered, message: delivered ? '已发送' : '已发出，但还没在会话记录里看到' };
}

module.exports = { send, sendViaChannel };
