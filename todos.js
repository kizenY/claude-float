// 任务单：~/.claude-float/todos.json 的读写（纯逻辑，好单测）。浮窗侧 UI 已是官方扩展 exts/todos
// 任务不只一个标题：desc=内容、goal=目标、progressLog=进度记录（会话推进长任务时逐条追加，
// 跨会话也不丢）。浮窗只读展示，创建/更新/完成都走会话里的 MCP 工具（channel/server.js）。
// 工作区不是独立配置，就是 quick-dirs.json 里的 path（白名单校验在 main.js 做）
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.claude-float', 'todos.json');
const MAX_SESSIONS = 20; // 一张单最多挂的会话数，防无限膨胀
const MAX_PROGRESS = 50; // 进度记录最多留的条数，超了丢最老的

// Windows 盘符大小写不敏感，统一 resolve + lowercase 再比
function sameDir(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  } catch {
    return false;
  }
}

function load(file = FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data)) {
      return data.filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string');
    }
  } catch { /* 没有文件或写坏了一半，当空列表 */ }
  return [];
}

// 先写临时文件再原子替换，浮窗中途崩也不至于把 todos.json 写坏
function save(list, file = FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

function newId() {
  return 't-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function create({ title, desc = '', goal = '', ws }, file = FILE) {
  const todo = {
    id: newId(),
    title: String(title).trim().slice(0, 120),
    desc: String(desc || '').trim().slice(0, 2000),
    goal: String(goal || '').trim().slice(0, 500),
    ws: String(ws || ''),
    status: 'open',
    createdAt: Date.now(),
    doneAt: null,
    sessions: [],
    progressLog: [], // [{ at, text, by }] 最新在最后；旧数据没有这个字段，读时兜底
    pct: null,       // 0-100 的进度百分比，没设过就是 null
  };
  const list = load(file);
  list.unshift(todo); // 新单在最上面
  save(list, file);
  return todo;
}

function toggle(id, file = FILE) {
  const list = load(file);
  const t = list.find((x) => x.id === id);
  if (!t) return null;
  if (t.status === 'open') {
    t.status = 'done';
    t.doneAt = Date.now();
  } else {
    t.status = 'open';
    t.doneAt = null;
  }
  save(list, file);
  return t;
}

// 编辑：只动标题/内容/目标/工作区，状态、完成时间、绑定会话都不碰
function update(id, patch = {}, file = FILE) {
  const list = load(file);
  const t = list.find((x) => x.id === id);
  if (!t) return null;
  if (patch.title !== undefined) t.title = String(patch.title).trim().slice(0, 120);
  if (patch.desc !== undefined) t.desc = String(patch.desc || '').trim().slice(0, 2000);
  if (patch.goal !== undefined) t.goal = String(patch.goal || '').trim().slice(0, 500);
  if (patch.ws !== undefined) t.ws = String(patch.ws || '');
  save(list, file);
  return t;
}

// 追加一条进度记录（会话推进任务时调）：text=这轮做了什么，by=哪个会话记的，
// pct=可选的 0-100 百分比（给了就顺手更新任务当前进度）。超上限丢最老的。
function logProgress(id, text, { by, pct } = {}, file = FILE) {
  const list = load(file);
  const t = list.find((x) => x.id === id);
  if (!t || !String(text || '').trim()) return null;
  t.progressLog = t.progressLog || [];
  t.progressLog.push({
    at: Date.now(),
    text: String(text).trim().slice(0, 500),
    by: by ? String(by) : null,
  });
  if (t.progressLog.length > MAX_PROGRESS) t.progressLog = t.progressLog.slice(-MAX_PROGRESS);
  if (pct !== undefined && pct !== null && pct !== '') {
    const n = Number(pct);
    if (Number.isFinite(n)) t.pct = Math.max(0, Math.min(100, Math.round(n)));
  }
  save(list, file);
  return t;
}

function remove(id, file = FILE) {
  const list = load(file);
  const at = list.findIndex((x) => x.id === id);
  if (at < 0) return false;
  list.splice(at, 1);
  save(list, file);
  return true;
}

function bind(id, sessionId, file = FILE) {
  const list = load(file);
  const t = list.find((x) => x.id === id);
  if (!t || !sessionId) return null;
  t.sessions = t.sessions || [];
  if (!t.sessions.includes(sessionId)) {
    t.sessions.push(sessionId);
    if (t.sessions.length > MAX_SESSIONS) t.sessions = t.sessions.slice(-MAX_SESSIONS);
  }
  save(list, file);
  return t;
}

function unbind(id, sessionId, file = FILE) {
  const list = load(file);
  const t = list.find((x) => x.id === id);
  if (!t) return null;
  t.sessions = (t.sessions || []).filter((s) => s !== sessionId);
  save(list, file);
  return t;
}

module.exports = { FILE, MAX_SESSIONS, MAX_PROGRESS, sameDir, load, list: load, create, update, logProgress, toggle, remove, bind, unbind };
