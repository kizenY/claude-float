#!/usr/bin/env node
// 任务单扩展入口：浮窗（float-extension.json）和 trine（trine-extension.json）共用。
// 调用约定：`node bin/ext.js <op>`，op ∈ view | badge | pick | action；
// stdin 一个 JSON（context 等），stdout 一个 JSON。数据在 ~/.claude-float/todos.json，
// 写入口主要是会话里的 MCP todos_* 工具；这里的 invoke（完成/重开）是 trine 面板上的人工操作。
'use strict';

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    out({ error: { code: 'bad-input', message: '输入不是合法 JSON' } });
    return;
  }
  const op = process.argv[2] || input.op;
  const tasks = require('../lib/store').load();
  const views = require('../lib/views');

  try {
    if (op === 'view') {
      // 浮窗 point=panel；trine point=sessionPanel / workspacePanel
      if (input.point === 'panel') {
        out({ view: views.floatView(tasks) });
      } else {
        out({ view: views.trineView(tasks, {
          point: input.point,
          linkedSessions: (input.context && input.context.linkedSessions) || [],
        }) });
      }
    } else if (op === 'badge') {
      out(views.badgeFor(tasks, input.context && input.context.session) || { badge: null });
    } else if (op === 'pick') {
      out({ items: views.pickItems(tasks, input.point) });
    } else if (op === 'action') {
      const args = input.args || {};
      if (args.actionId !== 'toggle') {
        out({ error: { code: 'unsupported', message: `不支持的动作 ${args.actionId}` } });
        return;
      }
      const store = require('../lib/store');
      const id = args.params && args.params.todoId || args.itemId;
      const t = store.load().find((x) => x.id === id);
      if (!t) { out({ error: { code: 'not-found', message: '任务不存在（可能已被删除）' } }); return; }
      store.toggle(String(id), t.status === 'open' ? 'trine 面板手动标记完成' : 'trine 面板手动重开');
      out({ ok: true, message: t.status === 'open' ? '已标记完成' : '已重新打开', effects: [{ type: 'refresh' }] });
    } else {
      out({ error: { code: 'unsupported', message: `不支持 ${op}` } });
    }
  } catch (e) {
    out({ error: { code: 'crash', message: String((e && e.message) || e) } });
  }
});

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}
