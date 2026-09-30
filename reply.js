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

// 会话记录里出现这条消息（直接发出或进了排队）就算送达
async function waitInTranscript(file, text, sinceSize, timeoutMs = 10000) {
  const needle = text.trim().slice(0, 30);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { size } = fs.statSync(file);
      if (size > sinceSize) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - sinceSize);
        fs.readSync(fd, buf, 0, buf.length, sinceSize);
        fs.closeSync(fd);
        for (const line of buf.toString('utf8').split('\n')) {
          if (!line.includes(needle.slice(0, 10))) continue;
          try {
            const e = JSON.parse(line);
            const content = e.type === 'queue-operation' ? e.content
              : e.type === 'user' && e.message ? JSON.stringify(e.message.content) : '';
            if (content && content.includes(needle)) return true;
          } catch { /* 半行 */ }
        }
      }
    } catch { /* 文件被轮转 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function send({ localId, title, text, file, prevHwnd, dryRun = false }) {
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

module.exports = { send };
