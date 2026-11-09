#!/usr/bin/env node
// 最小浮窗扩展示例：stdin 收一个 JSON，stdout 回一个 JSON。
// 约定：只处理 view 这个 op；不需要输入也得把 stdin 读完再退出。
'use strict';

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw || '{}');
  if (input.op !== 'view') {
    console.log(JSON.stringify({ error: { code: 'unsupported', message: `不支持 ${input.op}` } }));
    return;
  }
  const cwd = input.context.cwd;
  const sessions = input.context.sessions || [];
  const working = sessions.filter((s) => s.status === 'working');
  const items = [
    {
      id: 'cwd',
      title: cwd || '（没有目录上下文）',
      subtitle: '当前目录',
      meta: `扩展目录：${process.env.FLOAT_EXT_DIR || '?'}`,
      actions: [{ id: 'copy-cwd', label: '复制', effects: [{ type: 'copy', text: cwd || '' }] }],
    },
    {
      id: 'sessions',
      title: `这个目录有 ${sessions.length} 个会话`,
      subtitle: working.length ? `${working.length} 个在跑` : '都闲着',
      badges: sessions.length ? [{ text: '会话', tone: 'info' }] : [],
    },
    {
      id: 'hello',
      title: '点「插入问候」试试',
      detail: 'prompt.insert 会打开浮窗的快速回复框并预填文字；没有可用的会话时会退化成复制。',
    },
  ];
  if (sessions[0]) {
    items[2].actions = [{
      id: 'insert-hi',
      label: '插入问候',
      effects: [{ type: 'prompt.insert', text: '你好，我是扩展面板插进来的问候', sessionId: sessions[0].id }],
    }];
  }
  console.log(JSON.stringify({
    view: {
      title: 'Hello 扩展',
      sections: [{ id: 'main', title: '概况', items }],
    },
  }));
});
