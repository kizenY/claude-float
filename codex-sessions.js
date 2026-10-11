// 读取 ~/.codex/sessions 下的 Codex 会话记录（rollout JSONL，只读）
// Codex 的记录结构和 Claude Code 不同，每行是 { timestamp, type, payload }：
//   session_meta   会话头（id / cwd / 启动时间 / 来源），只在文件第一行
//   response_item  message / reasoning / function_call / function_call_output …
//   event_msg      task_started / task_complete / item_completed / token_count …
//   turn_context   每轮的 cwd / model 等
// 没有 Claude Code 那种 ~/.claude/sessions/<pid>.json 活会话登记表，活进程
// 靠「rollout 头里的启动时间 ≈ codex 进程启动时间」匹配（见 pidFor）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
// 和 sessions.js 一样先只读尾部，找不到回复再逐级放大；会话头单独读文件开头
const TAIL_STEPS = [512 * 1024, 4 * 1024 * 1024, Infinity];
const HEAD_BYTES = 256 * 1024;

const cache = new Map();      // file -> { mtimeMs, size, info }
const metaCache = new Map();  // file -> { mtimeMs, size, meta }

// 可选：CLAUDE_FLOAT_PROJECTS=carl,pawkit 只显示工作目录名包含这些关键字的会话
const ONLY = (process.env.CLAUDE_FLOAT_PROJECTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// 数据不串台：~/.codex/sessions 是全局共享的，Agent Cluster 里其他 Agent
// （seesaw / finchip…）的会话也会写进来；浮窗是个人工作室用的，默认隐藏
// agent-cluster 下非 carl 的会话。CLAUDE_FLOAT_CODEX_EXCLUDE 可覆盖排除关键字。
const EXCLUDE = (process.env.CLAUDE_FLOAT_CODEX_EXCLUDE === undefined
  ? 'e:\\agent-cluster' : process.env.CLAUDE_FLOAT_CODEX_EXCLUDE)
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const INCLUDE_DESPITE = ['e:\\agent-cluster\\carl'];

function excluded(cwd) {
  const p = String(cwd || '').toLowerCase();
  if (!p) return false;
  return EXCLUDE.some((k) => p.includes(k)) && !INCLUDE_DESPITE.some((k) => p.includes(k));
}

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

// 文件开头若干条记录：session_meta 一定在第一行，之后通常紧跟环境注入和第一句提问
function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const out = [];
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { break; /* 头部一行被截断就到此为止 */ }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function texts(p) {
  if (!Array.isArray(p && p.content)) return '';
  return p.content.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// 真正由人输入的提示：response_item.message role=user，排除 <user_instructions>、
// <environment_context>、<permissions> 这类系统注入（它们都以 < 开头）
function userPrompt(e) {
  if (e.type !== 'response_item') return null;
  const p = e.payload || {};
  if (p.type !== 'message' || p.role !== 'user') return null;
  const text = texts(p).trim();
  if (!text || text.startsWith('<')) return null;
  return text;
}

const isAssistantText = (e) => {
  const p = e.payload || {};
  return e.type === 'response_item' && p.type === 'message' && p.role === 'assistant' && texts(p).trim();
};

// 工具调用 / 调用结果（function_call、local_shell_call、custom_tool_call …）
const isToolCall = (p) => !!p.call_id && /call$/.test(String(p.type || ''));
const isToolOutput = (p) => !!p.call_id && /_output$/.test(String(p.type || ''));

// 会话尾巴处在什么阶段，用来推断状态
function tailOf(entries) {
  let lastUser = -1;
  let lastAssistant = -1;
  let lastApproval = -1; // 等你批准命令 / 看 diff
  let lastEnd = -1;      // task_complete / turn_aborted
  let pending = null;    // 最后一个还没等到输出的工具调用
  const finished = new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const p = e.payload || {};
    if (userPrompt(e)) lastUser = i;
    if (isAssistantText(e)) lastAssistant = i;
    if (e.type === 'event_msg' && /approval|review/i.test(String(p.type || ''))) lastApproval = i;
    if (e.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) lastEnd = i;
    if (e.type === 'response_item' && isToolCall(p)) pending = { i, name: p.name || p.type, call_id: p.call_id };
    if (e.type === 'response_item' && isToolOutput(p)) finished.add(p.call_id);
  }
  if (pending && !finished.has(pending.call_id)) {
    if (lastEnd > pending.i) return { kind: 'end' }; // 这轮已经完成/被打断，工具不会再有输出
    if (lastApproval >= pending.i) return { kind: 'approval' };
    if (lastUser > pending.i) return { kind: 'user' }; // 上一轮工具还挂着，但你又发了新消息
    return { kind: 'tool', name: pending.name };
  }
  if (lastApproval >= 0 && lastApproval > Math.max(lastUser, lastAssistant)) return { kind: 'approval' };
  if (lastUser >= 0 && lastUser > Math.max(lastAssistant, lastEnd)) return { kind: 'user' };
  return { kind: 'end' };
}

// working 进行中 / waiting 等你回复或批准 / idle 空闲
function statusOf(tail, mtimeMs, now = Date.now()) {
  const quiet = now - mtimeMs;
  switch (tail.kind) {
    case 'user':
      return quiet < 10 * 60e3 ? 'working' : 'idle';
    case 'approval':
      return 'waiting';
    case 'tool': {
      const slow = /shell|exec|command/i.test(String(tail.name || '')); // 命令类工具本来就可能跑很久
      return quiet > (slow ? 120e3 : 30e3) ? 'waiting' : 'working';
    }
    default:
      return 'idle';
  }
}

function parse(entries) {
  let cwd = null;
  let firstPrompt = null;
  let reply = '';
  for (const e of entries) {
    const p = e.payload || {};
    if (e.type === 'turn_context' && p.cwd) cwd = p.cwd; // 会话可能 resume 到别的目录，取最近一轮的
    if (!firstPrompt) firstPrompt = userPrompt(e) || null;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isAssistantText(entries[i])) {
      reply = texts(entries[i].payload).trim();
      break;
    }
  }
  return {
    title: (firstPrompt ? firstPrompt.split('\n')[0] : '未命名会话').slice(0, 80),
    cwd,
    firstPrompt,
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
  // 很长的会话第一句提问可能不在尾部：再从头部补一次标题
  if (!info.firstPrompt) {
    for (const e of readHead(file)) {
      const t = userPrompt(e);
      if (t) { info.firstPrompt = t; info.title = t.split('\n')[0].slice(0, 80); break; }
    }
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  return info;
}

function metaOf(file, stat) {
  const hit = metaCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.meta;
  let meta = null;
  try { meta = (readHead(file)[0] || {}).payload || null; } catch { /* 文件刚被删 */ }
  metaCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

function sessionFiles() {
  const out = [];
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

function idFromFile(file) {
  const m = path.basename(file).match(/([0-9a-fA-F-]{36})\.jsonl$/);
  return m ? m[1].toLowerCase() : path.basename(file, '.jsonl');
}

function list(limit = 20) {
  const files = [];
  for (const file of sessionFiles()) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > 0) files.push({ file, stat });
    } catch { /* 文件刚被删 */ }
  }
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const now = Date.now();
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    let info;
    let meta;
    try {
      info = inspect(f.file, f.stat);
      meta = metaOf(f.file, f.stat);
    } catch { continue; }
    if (!info.firstPrompt && !info.reply) continue; // 还没说过话的空会话不展示
    const cwd = info.cwd || (meta && meta.cwd) || '';
    if (excluded(cwd)) continue;
    if (ONLY.length && !ONLY.some((k) => path.basename(cwd).toLowerCase().includes(k))) continue;
    out.push({
      id: (meta && (meta.session_id || meta.id)) ? String(meta.session_id || meta.id) : idFromFile(f.file),
      file: f.file,
      mtime: f.stat.mtimeMs,
      title: info.title,
      channel: false, // Codex 没有 Claude Code 的 channels，快速回复走终端注入
      project: cwd ? path.basename(cwd) : '',
      cwd,
      status: statusOf(info.tail, f.stat.mtimeMs, now),
      pid: null, // attachPids() 再补
      startedAt: meta ? (Date.parse(meta.timestamp) || 0) : 0, // 匹配活进程用
      originator: meta ? meta.originator || '' : '',
      waitingFor: '',
      preview: info.reply.replace(/\s+/g, ' ').slice(0, 120),
    });
  }
  return out;
}

function reply(file) {
  const stat = fs.statSync(file);
  return inspect(file, stat).reply;
}

// ---- 活进程匹配 ------------------------------------------------------------
// Codex 没有会话登记表。rollout 文件头的 session_meta.timestamp 是会话创建时间
// （UTC、RFC3339），和 codex 进程的启动时间只差加载配置那几秒——枚举本机 codex
// 进程的启动时间，取差值最小且在窗口内的那个。Desktop 起的会话没有控制台，
// 直接不参与匹配。
let procs = null;
let procsAt = 0;
let procsBusy = null;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function codexProcs() {
  if (procs && Date.now() - procsAt < 2500) return procs; // 列表 3s 刷一次，别每次都拉 PowerShell
  if (procsBusy) return procsBusy;                        // 上一次还没回来，合并等待
  procsBusy = new Promise((resolve) => {
    // 输出 "pid<TAB>startMs" 每进程一行，避开 JSON 引号转义。
    // 用 Get-Process 而不是 WMI：不需要 WMI 权限（Get-CimInstance Win32_Process
    // 在部分机器上会被拒绝访问），自己终端里起的 codex 进程都能看到
    const script = 'Get-Process -Name codex* -ErrorAction SilentlyContinue | ' +
      'ForEach-Object { $t=$null; try { $t=$_.StartTime } catch {} ; ' +
      'if ($t) { "{0}`t{1}" -f $_.Id, [DateTimeOffset]::new($t).ToUnixTimeMilliseconds() } }';
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve([]); }, 5000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => {
      clearTimeout(timer);
      const list = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [pid, start] = l.split('\t');
        return { pid: Number(pid), startMs: Number(start) || 0 };
      }).filter((p) => p.pid > 0);
      resolve(list);
    });
  });
  procsBusy.then((r) => { procs = r; procsAt = Date.now(); procsBusy = null; });
  return procsBusy;
}

function matchPid(startedAt, candidates) {
  if (!startedAt) return null;
  const hits = candidates
    .filter((p) => alive(p.pid) && Math.abs(p.startMs - startedAt) <= 20000)
    .sort((a, b) => Math.abs(a.startMs - startedAt) - Math.abs(b.startMs - startedAt));
  return hits.length ? hits[0].pid : null;
}

// 给 list() 的结果补上活进程 pid（切窗口 / 快速回复用）
async function attachPids(rows) {
  const candidates = await codexProcs();
  for (const r of rows) {
    if (r.originator === 'Codex Desktop') continue; // Desktop 会话没有控制台，注入不了
    r.pid = matchPid(r.startedAt, candidates);
  }
  return rows;
}

// 会话对应的活进程 pid，会话已结束（或 Desktop 起的）则为 null
async function pidFor(id) {
  const target = String(id);
  for (const file of sessionFiles()) {
    let meta;
    try { meta = metaOf(file, fs.statSync(file)); } catch { continue; }
    const sid = meta && (meta.session_id || meta.id);
    if (!sid || String(sid) !== target) continue;
    if ((meta.originator || '') === 'Codex Desktop') return null;
    return matchPid(Date.parse(meta.timestamp) || 0, await codexProcs());
  }
  return null;
}

module.exports = { list, reply, parse, statusOf, attachPids, pidFor, ROOT };
