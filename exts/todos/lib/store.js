// 任务单扩展的数据层：读写 ~/.claude-float/todos.json。
// 和浮窗核心（todos.js + 会话里的 MCP todos_* 工具）共用同一个文件、同一套字段和上限；
// 这里是按扩展自包含要求 vendor 的精简版：只留扩展用到的读、完成/重开、绑定、记进度。
// 两边字段如有变动要同步改（repo 里 test/exts-todos.test.js 会拿同一份夹具对两边做兼容测试）。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.claude-float', 'todos.json');
const MAX_SESSIONS = 20;  // 与 todos.js 一致
const MAX_PROGRESS = 50;

function load(file = FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data)) {
      return data.filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string');
    }
  } catch { /* 没有文件或写坏了一半，当空列表 */ }
  return [];
}

// 先写临时文件再原子替换，和浮窗核心同一个写法，避免和 MCP 写入口互相写坏
function save(list, file = FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

// 完成/重开（trine 面板上手动点），顺手记一条进度，和会话里 todos_toggle 的效果一致
function toggle(id, note, by = 'trine', file = FILE) {
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
  t.progressLog = t.progressLog || [];
  t.progressLog.push({ at: Date.now(), text: String(note || '').slice(0, 500), by });
  if (t.progressLog.length > MAX_PROGRESS) t.progressLog = t.progressLog.slice(-MAX_PROGRESS);
  save(list, file);
  return t;
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

module.exports = { FILE, load, save, toggle, bind };
