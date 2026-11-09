// 任务单扩展的视图构建（纯函数，好单测）：把 todos.json 的列表 + 调用上下文
// 变成两个宿主（浮窗 / trine）各自的「视图词汇」。浮窗契约是 trine 契约的子集，
// 差别在：浮窗 Item 没有 sessions 字段、动作只有静态效果、没有 invoke。
'use strict';

const DONE_KEEP = 5; // 面板里保留几条最近完成的

/** 给会话的接手提示：新建会话预填 / 插入输入框 / 复制，都靠它让会话自己 todos_bind */
function hint(t) {
  const head = `请接手任务 ${t.id}「${t.title}」：先用 todos_bind 把它挂到本会话，再按任务内容推进，阶段性用 todos_update 记 progress_note 和 pct。`;
  const goal = t.goal ? `\n目标：${t.goal}` : '';
  const desc = t.desc ? `\n内容：${t.desc}` : '';
  return head + goal + desc;
}

function pctBadge(t) {
  if (t.pct == null) return null;
  const tone = t.status === 'done' ? 'success' : t.pct >= 80 ? 'warning' : 'info';
  return { text: `${t.pct}%`, tone };
}

function metaText(t) {
  const bits = [];
  if (t.ws) bits.push(String(t.ws).split(/[\\/]/).filter(Boolean).pop() || t.ws);
  if (t.pct != null) bits.push(`进度 ${t.pct}%`);
  if (Array.isArray(t.progressLog) && t.progressLog.length) bits.push(`${t.progressLog.length} 条进度`);
  return bits.join(' · ');
}

function detailText(t) {
  const lines = [];
  if (t.goal) lines.push(`目标：${t.goal}`);
  if (t.desc) lines.push(`内容：${t.desc}`);
  const log = Array.isArray(t.progressLog) ? t.progressLog.slice(-8) : [];
  if (log.length) {
    lines.push('', '最近进度：');
    for (const p of log) {
      const at = p.at ? new Date(p.at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      lines.push(`- ${at} ${p.text}${p.by ? `（${p.by}）` : ''}`);
    }
  }
  return lines.join('\n') || '（没有更多内容）';
}

/**
 * trine 侧一个任务关联的会话引用 = todos.json 里绑的 ∪ 本扩展 trine 关联(ref=任务id)指向的。
 * linkedSessions 是 trine 输入里带本扩展关联的会话（最多 200 条）。
 */
function sessionRefs(t, linkedSessions = []) {
  const ids = new Set(Array.isArray(t.sessions) ? t.sessions : []);
  for (const s of linkedSessions) {
    if (s && s.id && Array.isArray(s.links) && s.links.some((l) => l && l.ref === t.id)) ids.add(s.id);
  }
  return [...ids];
}

function taskItem(t, { host, linkedSessions = [], insertAsCopy = false }) {
  const item = {
    id: t.id,
    title: t.title,
    subtitle: t.goal || undefined,
    meta: metaText(t),
    badges: [pctBadge(t), t.status === 'done' ? { text: '已完成', tone: 'success' } : null].filter(Boolean),
    detail: detailText(t),
  };
  if (host === 'trine') item.sessions = sessionRefs(t, linkedSessions);
  if (t.status === 'open') {
    // 接手动作：sessionPanel 插入输入框；workspacePanel 没有输入框，按契约退化为复制
    const takeEffect = insertAsCopy
      ? { type: 'copy', text: hint(t) }
      : { type: 'prompt.insert', text: hint(t) };
    item.actions = host === 'trine'
      ? [
        { id: 'take', label: insertAsCopy ? '复制接手提示' : '本会话接手', primary: true, effects: [takeEffect] },
        { id: 'new', label: '新会话处理', effects: [{ type: 'session.create', cwd: t.ws || undefined, title: t.title, prompt: hint(t) }] },
        { id: 'toggle', label: '完成', invoke: { params: { todoId: t.id } } },
      ]
      : [
        { id: 'spawn', label: '起会话', primary: true, effects: [{ type: 'session.create', cwd: t.ws }] },
        { id: 'copy-hint', label: '复制接手提示', effects: [{ type: 'copy', text: hint(t) }] },
      ];
  }
  return item;
}

function sections(tasks, opts) {
  const open = tasks.filter((t) => t.status !== 'done').map((t) => taskItem(t, opts));
  const done = tasks.filter((t) => t.status === 'done').slice(0, DONE_KEEP).map((t) => taskItem(t, opts));
  return [
    { id: 'open', title: '进行中', items: open, empty: '还没有进行中的任务（让会话里的 Claude 调 todos_add 建一个）' },
    { id: 'done', title: '最近完成', items: done, empty: '暂无' },
  ];
}

/** 浮窗 panel：point=panel，上下文只有 cwd + 会话元信息 */
function floatView(tasks) {
  return { sections: sections(tasks, { host: 'float' }) };
}

/**
 * trine view：sessionPanel（在会话里，可插入/接手）和 workspacePanel（不在会话里，
 * 插入类按契约退化为复制）。
 */
function trineView(tasks, { point, linkedSessions = [] }) {
  return {
    sections: sections(tasks, {
      host: 'trine',
      linkedSessions,
      // workspacePanel 没有输入框：prompt.insert 退化为 copy（契约规定），invoke 照常
      insertAsCopy: point === 'workspacePanel',
    }),
  };
}

/** trine badge：会话绑着哪个进行中的任务就亮哪个（最新的一条） */
function badgeFor(tasks, session) {
  if (!session || !session.id) return null;
  const linked = (l) => Array.isArray(session.links) && session.links.some((x) => x && x.ref === l.id);
  const hit = tasks
    .filter((t) => t.status !== 'done' && ((Array.isArray(t.sessions) && t.sessions.includes(session.id)) || linked(t)))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (!hit) return null;
  const text = hit.title.length > 10 ? `任·${hit.title.slice(0, 9)}…` : `任·${hit.title}`;
  return { badge: { text, tone: 'info' } };
}

/** trine pick：linkPicker（关联…）和 newSession（从任务开始）两处候选 */
function pickItems(tasks, point) {
  return tasks
    .filter((t) => t.status !== 'done')
    .map((t) => {
      const base = { id: t.id, title: t.title, subtitle: t.goal || undefined, badges: [pctBadge(t)].filter(Boolean), link: { ref: t.id, label: t.title } };
      if (point === 'newSession') base.effects = [{ type: 'prompt.insert', text: hint(t) }];
      return base;
    });
}

module.exports = { hint, floatView, trineView, badgeFor, pickItems, sessionRefs, detailText };
