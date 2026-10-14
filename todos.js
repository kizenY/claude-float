// 代办单：~/.claude-float/todos.json 的读写 + 起会话后的挂单匹配（纯逻辑，好单测）
// 工作区不是独立配置，就是 quick-dirs.json 里的 path（白名单校验在 main.js 做）
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.claude-float', 'todos.json');
const PENDING_TTL = 5 * 60e3; // 起会话后等新会话冒头的期限，过了就不再自动挂
const MAX_SESSIONS = 20; // 一张单最多挂的会话数，防无限膨胀

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

function create({ title, desc = '', ws }, file = FILE) {
  const todo = {
    id: newId(),
    title: String(title).trim().slice(0, 120),
    desc: String(desc || '').trim().slice(0, 2000),
    ws: String(ws || ''),
    status: 'open',
    createdAt: Date.now(),
    doneAt: null,
    sessions: [],
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

// 起会话时先快照该目录已知的会话 id（pending.knownIds），之后每一轮会话列表里
// 冒出「目录匹配 + id 不在快照里」的新会话就是它。返回 sessionId，没等到/过期返回 null
function matchPending(list, pending, now = Date.now()) {
  if (!pending || !pending.ws || !Array.isArray(pending.knownIds)) return null;
  if (now - pending.at > PENDING_TTL) return null;
  const hit = (list || []).find((s) => s && s.id && !pending.knownIds.includes(s.id) && sameDir(s.cwd, pending.ws));
  return hit ? hit.id : null;
}

module.exports = { FILE, PENDING_TTL, MAX_SESSIONS, sameDir, load, list: load, create, toggle, remove, bind, unbind, matchPending };
