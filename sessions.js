// 读取 ~/.claude/projects 下的 Claude Code / Claude 桌面版会话记录（JSONL）
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
// 先只读文件尾部，找不到回复再逐级放大
const TAIL_STEPS = [512 * 1024, 4 * 1024 * 1024, Infinity];

const cache = new Map(); // file -> { mtimeMs, size, info }

// 可选：CLAUDE_FLOAT_PROJECTS=carl,pawkit 只显示目录名包含这些关键字的项目
const ONLY = (process.env.CLAUDE_FLOAT_PROJECTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function readTail(file, size, bytes) {
  const start = bytes >= size ? 0 : size - bytes;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // 第一行可能被截断
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 写入中的半行 */ }
    }
    return { entries: out, complete: start === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function textBlocks(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text);
}

// 真正由人输入的提示（排除工具结果、系统注入、斜杠命令包装）
function userPrompt(e) {
  if (e.type !== 'user' || e.isSidechain || e.isMeta || !e.message) return null;
  const text = textBlocks(e.message.content).join('\n').trim();
  if (!text || text.startsWith('<')) return null;
  return text;
}

function parse(entries) {
  let title = null;
  let lastPrompt = null;
  let firstPrompt = null;
  let cwd = null;
  let replyId = null;
  let replyIdx = -1;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.cwd) cwd = e.cwd;
    if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
    else if (e.type === 'ai-title' && e.aiTitle) title = title || e.aiTitle;
    else if (e.type === 'summary' && e.summary) title = title || e.summary;
    else if (e.type === 'last-prompt' && e.lastPrompt) lastPrompt = e.lastPrompt;
    if (!firstPrompt) firstPrompt = userPrompt(e);
  }

  // 最后一条带文字的主线 assistant 消息（同一个 message.id 可能拆成多行）
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'assistant' && !e.isSidechain && e.message && textBlocks(e.message.content).some((t) => t.trim())) {
      replyId = e.message.id || e.uuid;
      replyIdx = i;
      break;
    }
  }

  let reply = '';
  let replyAt = null;
  if (replyIdx >= 0) {
    const parts = [];
    for (let i = replyIdx; i >= 0; i--) {
      const e = entries[i];
      if (e.type !== 'assistant') continue;
      if ((e.message.id || e.uuid) !== replyId) break;
      parts.unshift(...textBlocks(e.message.content));
      replyAt = e.timestamp || replyAt;
    }
    reply = parts.join('\n\n').trim();
  }

  // 最后一条是工具调用/工具结果 => Claude 还在干活
  const last = [...entries].reverse().find((e) => e.type === 'user' || e.type === 'assistant');
  let working = false;
  if (last && last.message && Array.isArray(last.message.content)) {
    working = last.message.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result');
  }

  const fallback = lastPrompt || firstPrompt || '';
  return {
    title: (title || fallback.split('\n')[0] || '未命名会话').slice(0, 80),
    cwd,
    reply,
    replyAt,
    working,
  };
}

function inspect(file, stat) {
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.info;
  let info = null;
  for (const bytes of TAIL_STEPS) {
    const { entries, complete } = readTail(file, stat.size, bytes);
    info = parse(entries);
    if (info.reply || complete) break;
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  return info;
}

function list(limit = 20) {
  const files = [];
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return []; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (ONLY.length && !ONLY.some((k) => d.name.toLowerCase().includes(k))) continue;
    const dir = path.join(ROOT, d.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.size > 0) files.push({ file, stat, id: name.slice(0, -6) });
      } catch { /* 文件刚被删 */ }
    }
  }
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    let info;
    try { info = inspect(f.file, f.stat); } catch { continue; }
    if (!info.reply) continue; // 没有任何回复的会话不展示
    out.push({
      id: f.id,
      file: f.file,
      mtime: f.stat.mtimeMs,
      title: info.title,
      project: info.cwd ? path.basename(info.cwd) : '',
      working: info.working,
      preview: info.reply.replace(/\s+/g, ' ').slice(0, 120),
    });
  }
  return out;
}

function reply(file) {
  const stat = fs.statSync(file);
  return inspect(file, stat).reply;
}

module.exports = { list, reply, parse, ROOT };
