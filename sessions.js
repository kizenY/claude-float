// 读取 ~/.claude/projects 下的 Claude Code / Claude 桌面版会话记录（JSONL）
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
// 桌面版自己的会话索引：local_<id>.json 里有 cliSessionId、标题、是否归档
const DESKTOP_ROOT = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code-sessions');
// 先只读文件尾部，找不到回复再逐级放大
const TAIL_STEPS = [512 * 1024, 4 * 1024 * 1024, Infinity];

// 需要你回答才能继续的工具
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// 本来就跑得久的工具，不当成「在等你批准」
const LONG_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'Monitor', 'TaskOutput', 'ScheduleWakeup']);

const cache = new Map(); // file -> { mtimeMs, size, info }
const desktopCache = new Map(); // file -> { mtimeMs, meta }

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
  if (!text || text.startsWith('<') || text.startsWith('[Request interrupted')) return null;
  return text;
}

const isMain = (e) => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain && e.message;

// 会话尾巴处在什么阶段，用来推断状态
function tailOf(entries) {
  let lastIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isMain(entries[i])) { lastIdx = i; break; }
  }
  if (lastIdx < 0) return { kind: 'end' };
  // Claude 回完之后你又排队发了消息
  if (entries.slice(lastIdx + 1).some((e) => e.type === 'queue-operation' && e.operation === 'enqueue')) {
    return { kind: 'user' };
  }

  const last = entries[lastIdx];
  if (last.type === 'user') {
    const text = textBlocks(last.message.content).join('');
    return { kind: text.startsWith('[Request interrupted') ? 'end' : 'user' };
  }

  const stop = last.message.stop_reason;
  if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens') return { kind: 'end' };
  if (stop !== 'tool_use') return { kind: 'streaming' };

  // 同一条消息里还没拿到结果的工具调用
  const id = last.message.id;
  const tools = [];
  for (let i = lastIdx; i >= 0; i--) {
    const e = entries[i];
    if (!isMain(e)) continue;
    if (e.type !== 'assistant' || e.message.id !== id) break;
    for (const b of e.message.content || []) if (b.type === 'tool_use') tools.push(b.name);
  }
  return { kind: 'tool', tools };
}

// working 进行中 / waiting 等你回复 / idle 空闲
function statusOf(tail, mtimeMs, now = Date.now()) {
  const quiet = now - mtimeMs;
  switch (tail.kind) {
    case 'user':
      return quiet < 10 * 60e3 ? 'working' : 'idle';
    case 'streaming':
      return quiet < 2 * 60e3 ? 'working' : 'idle';
    case 'tool': {
      const tools = tail.tools || [];
      if (tools.some((t) => INTERACTIVE_TOOLS.has(t))) return 'waiting';
      if (tools.length && tools.every((t) => LONG_TOOLS.has(t))) return 'working';
      // 普通工具一般几秒就有结果，文件长时间不动多半是在等你批准
      const slow = tools.some((t) => t === 'Bash' || t.startsWith('mcp__'));
      return quiet > (slow ? 120e3 : 30e3) ? 'waiting' : 'working';
    }
    default:
      return 'idle';
  }
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
  if (replyIdx >= 0) {
    const parts = [];
    for (let i = replyIdx; i >= 0; i--) {
      const e = entries[i];
      if (e.type !== 'assistant') continue;
      if ((e.message.id || e.uuid) !== replyId) break;
      parts.unshift(...textBlocks(e.message.content));
    }
    reply = parts.join('\n\n').trim();
  }

  const fallback = lastPrompt || firstPrompt || '';
  return {
    title: (title || fallback.split('\n')[0] || '未命名会话').slice(0, 80),
    cwd,
    reply,
    tail: tailOf(entries),
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

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch { return []; }
}

// cliSessionId -> { localId, title, isArchived }
function desktopIndex() {
  const index = new Map();
  for (const account of subdirs(DESKTOP_ROOT)) {
    for (const org of subdirs(account)) {
      let names = [];
      try { names = fs.readdirSync(org); } catch { continue; }
      for (const name of names) {
        if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
        const file = path.join(org, name);
        try {
          const { mtimeMs } = fs.statSync(file);
          let hit = desktopCache.get(file);
          if (!hit || hit.mtimeMs !== mtimeMs) {
            const d = JSON.parse(fs.readFileSync(file, 'utf8'));
            hit = { mtimeMs, meta: { localId: d.sessionId, cliSessionId: d.cliSessionId, title: d.title, isArchived: !!d.isArchived } };
            desktopCache.set(file, hit);
          }
          if (hit.meta.cliSessionId) index.set(hit.meta.cliSessionId, hit.meta);
        } catch { /* 写入中 */ }
      }
    }
  }
  return index;
}

function list(limit = 20) {
  const files = [];
  for (const dir of subdirs(ROOT)) {
    const base = path.basename(dir);
    if (ONLY.length && !ONLY.some((k) => base.toLowerCase().includes(k))) continue;
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

  const desktop = desktopIndex();
  const now = Date.now();
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const meta = desktop.get(f.id);
    if (meta && meta.isArchived) continue; // 桌面版里已归档的不显示
    let info;
    try { info = inspect(f.file, f.stat); } catch { continue; }
    if (!info.reply) continue; // 没有任何回复的会话不展示
    out.push({
      id: f.id,
      file: f.file,
      mtime: f.stat.mtimeMs,
      title: (meta && meta.title) || info.title,
      localId: meta ? meta.localId : null, // 有它才能从浮窗回复
      project: info.cwd ? path.basename(info.cwd) : '',
      status: statusOf(info.tail, f.stat.mtimeMs, now),
      preview: info.reply.replace(/\s+/g, ' ').slice(0, 120),
    });
  }
  return out;
}

function reply(file) {
  const stat = fs.statSync(file);
  return inspect(file, stat).reply;
}

module.exports = { list, reply, parse, statusOf, ROOT };
