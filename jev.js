// jev-gateway 日志统计：解析 gateway.log 尾部的 route= 行，给浮窗一个全局的高低档视角。
// 会话行上的高低档统计来自各自 transcript；这里是网关侧的全局口径（含被 cache 挡住
// 看不到 transcript 的请求，比如 Codex 走 responses 兼容层的）。
// 日志路径优先环境变量 CLAUDE_FLOAT_JEV_LOG，其次 ~/.claude-float/jev.json：{ "log": "…" }。
// 公开仓库不写死个人路径；没配置或文件读不到时 stats() 返回 null，浮窗就不显示网关行。
const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL_BYTES = 128 * 1024; // 尾部读这么多，够统计最近几百个请求
const ONLINE_MS = 90 * 1000;   // 日志最近一条在这个窗口内 = 网关在线

// gateway.py 的行：
//   2026-10-14 14:12:25,842 INFO route=opus score=- conf=- in=787 out=562 56658ms messages-stream (…)
const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+) INFO route=(\S+) score=(\S+) conf=(\S+) in=(\d+) out=(\d+) (\d+)ms/;

function logPath() {
  if (process.env.CLAUDE_FLOAT_JEV_LOG) return process.env.CLAUDE_FLOAT_JEV_LOG;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-float', 'jev.json'), 'utf8'));
    if (cfg && typeof cfg.log === 'string') return cfg.log;
  } catch { /* 没有配置文件 */ }
  return null;
}

// route → 档位：opus/glm-strong=高档，haiku/glm-flash=低档（和 sessions.js 的 tierOf 同口径）
function tierOf(route) {
  if (route === 'opus' || route === 'glm-strong') return 'hi';
  if (route === 'haiku' || route === 'glm-flash') return 'lo';
  return null;
}

// 单行解析：命中 route= 行返回 { tier, score, judged, ms, at }，其余（HTTP Request 行等）返回 null
function parseLine(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  // "2026-10-14 14:12:25,842" → ISO 本地时间（无时区后缀 Date.parse 按本地时区算）
  const at = Date.parse(m[1].replace(' ', 'T').replace(',', '.'));
  return {
    tier: tierOf(m[2]),
    score: m[3],
    judged: m[3] !== '-',
    ms: Number(m[7]),
    at: Number.isFinite(at) ? at : 0,
  };
}

let cache = { mtimeMs: -1, size: -1, stats: null };

// 全局统计：高低档请求数、Jev 真判分的请求数、平均耗时、最近请求时刻。日志没变直接回缓存
function stats(now = Date.now()) {
  const file = logPath();
  if (!file) return null;
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (cache.stats && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.stats;

  const start = st.size > TAIL_BYTES ? st.size - TAIL_BYTES : 0;
  let text = '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n');
  if (start > 0) lines.shift(); // 第一行可能被截断

  let hi = 0;
  let lo = 0;
  let judged = 0;
  let msSum = 0;
  let n = 0;
  let lastAt = 0;
  for (const line of lines) {
    const r = parseLine(line);
    if (!r) continue;
    if (r.tier === 'hi') hi++;
    else if (r.tier === 'lo') lo++;
    if (r.judged) judged++;
    msSum += r.ms;
    n++;
    if (r.at > lastAt) lastAt = r.at;
  }
  const out = n
    ? { hi, lo, judged, total: n, avgMs: Math.round(msSum / n), lastAt, online: now - lastAt < ONLINE_MS }
    : null;
  cache = { mtimeMs: st.mtimeMs, size: st.size, stats: out };
  return out;
}

module.exports = { stats, parseLine, tierOf, logPath };
