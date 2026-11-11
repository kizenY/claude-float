#!/usr/bin/env node
// 用量扩展入口：浮窗（float-extension.json）和 trine（trine-extension.json）共用，
// 只需要 view 这一个 op。窗口命名沿用浮窗原来的约定：接口不回窗口名，
// 按 nextResetTime 升序对号入座（最近的=5 小时窗，其次是周窗）。
'use strict';

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    out({ error: { code: 'bad-input', message: '输入不是合法 JSON' } });
    return;
  }
  const op = process.argv[2] || input.op;
  if (op !== 'view') {
    out({ error: { code: 'unsupported', message: `不支持 ${op}` } });
    return;
  }
  const glm = require('../lib/glm');
  let res;
  try {
    res = await glm.usage();
  } catch (e) {
    out({ error: { code: 'crash', message: String((e && e.message) || e) } });
    return;
  }
  if (!res) {
    if (!glm.loadConf()) {
      out({ view: { sections: [{ id: 'w', items: [], empty: '未配置 ~/.claude-float/glm.json（需要 apiKey）' }] } });
    } else {
      out({ view: { sections: [{ id: 'w', items: [], empty: '还没拿到过用量数据（网络失败），稍后刷新重试' }] } });
    }
    return;
  }
  out({ view: buildView(res.data, res.stale) });
});

function buildView(data, stale) {
  const items = data.windows.map((w, i) => {
    const name = i === 0 ? '5小时窗' : i === 1 ? '周窗' : `窗口${i + 1}`;
    const left = w.remaining != null ? ` · 剩 ${(w.remaining / 1000).toFixed(1)}k` : '';
    const reset = w.resetAt ? ` · ${fmtReset(w.resetAt)} 重置` : '';
    const tone = w.pct >= 80 ? 'danger' : w.pct >= 50 ? 'warning' : 'success';
    return {
      id: `w${i}`,
      title: name,
      subtitle: `已用 ${w.pct}%${left}`,
      meta: (reset + (stale ? ' · 缓存值' : '')).replace(/^ · /, '') || undefined,
      badges: [{ text: `${w.pct}%`, tone }],
    };
  });
  return {
    title: data.level ? `GLM订阅用量 · ${data.level}` : 'GLM订阅用量',
    sections: [{ id: 'windows', items }],
  };
}

function fmtReset(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  if (sameDay) return hm;
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}
