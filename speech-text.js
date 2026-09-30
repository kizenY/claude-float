// 把 Markdown 回复转成适合朗读的纯文本，并切成 TTS 友好的小段
(function (root) {
  function basenameIfPath(s) {
    if (/[\\/]/.test(s) && !/\s/.test(s)) {
      const parts = s.split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] || s;
    }
    return s;
  }

  function toSpeech(md) {
    let t = String(md || '').replace(/\r\n?/g, '\n');
    t = t.replace(/```[\s\S]*?(```|$)/g, '\n（代码略）\n');
    t = t.replace(/<[^>\n]+>/g, '');
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, (_, label) => basenameIfPath(label));
    t = t.replace(/https?:\/\/\S+/g, '链接');
    t = t.replace(/`([^`\n]+)`/g, (_, code) => basenameIfPath(code));

    const lines = [];
    for (let line of t.split('\n')) {
      line = line.trim();
      if (!line) continue;
      if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes('-')) continue; // 表格分隔行
      if (/^[-*_]{3,}$/.test(line)) continue; // 分隔线
      if (line.startsWith('|')) line = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join('，');
      line = line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
        .replace(/(\*\*|__|~~)/g, '')
        .replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1$2');
      if (!line) continue;
      if (!/[。！？!?；;：:，,.…）)」"']$/.test(line)) line += '。';
      lines.push(line);
    }
    return lines.join('\n');
  }

  // Chromium 的 speechSynthesis 读长句容易中途断掉，切成 ~160 字的段
  function chunk(text, max = 160) {
    const pieces = String(text).split(/(?<=[。！？!?；;\n])/);
    const out = [];
    let buf = '';
    for (const p of pieces) {
      if ((buf + p).length > max && buf) {
        out.push(buf.trim());
        buf = '';
      }
      if (p.length > max) {
        for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max).trim());
      } else {
        buf += p;
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(Boolean);
  }

  const api = { toSpeech, chunk };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpeechText = api;
})(this);
