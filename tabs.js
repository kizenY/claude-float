// 目录 Tab 匹配：会话/代办的目录对齐到 quick-dirs（renderer 没有 path 模块，手动归一）
(function (root) {
  function norm(p) {
    return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function sameWs(a, b) {
    if (!a || !b) return false;
    return norm(a) === norm(b);
  }

  // 目录命中哪个启动目录：返回该 dir 的 path（原样字符串，spawn 白名单要精确比对），没命中返回 null（=「其他」）。
  // 精确匹配是有意的：和 todos.sameDir / matchPending 同一口径，子目录不归入父目录
  function matchDir(cwd, dirs) {
    if (!cwd) return null;
    for (const d of dirs || []) {
      if (d && d.path && norm(d.path) === norm(cwd)) return d.path;
    }
    return null;
  }

  const api = { norm, sameWs, matchDir };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tabs = api;
})(this);
