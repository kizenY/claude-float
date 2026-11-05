// 移出列表的会话：~/.claude-float/hidden-sessions.json，存 [{id, title, at}]
// 只藏不删——jsonl/rollout 是 Claude Code / Codex 的数据，浮窗对它们保持只读
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.claude-float', 'hidden-sessions.json');

function load(file = FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data)) {
      return data
        .map((h) => (typeof h === 'string' ? { id: h, title: '', at: 0 } : h)) // 容错：脏数据按最小形态收编
        .filter((h) => h && typeof h.id === 'string');
    }
  } catch { /* 没有文件或写坏了一半，当空 */ }
  return [];
}

// 先写临时文件再原子替换，浮窗中途崩也不至于把 hidden-sessions.json 写坏
function save(list, file = FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

// 隐藏时带上标题（renderer 现成传进来），设置弹层里恢复用；重复隐藏=刷新一条
function hide(id, title = '', file = FILE) {
  const list = load(file).filter((h) => h.id !== String(id));
  list.push({ id: String(id), title: String(title || '').slice(0, 80), at: Date.now() });
  save(list, file);
  return list;
}

function unhide(id, file = FILE) {
  save(load(file).filter((h) => h.id !== String(id)), file);
}

module.exports = { FILE, load, save, hide, unhide };
