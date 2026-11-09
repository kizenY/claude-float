// trine 联动：配置存在时，浮窗的「点会话行/宠物托盘/起会话」从切终端改为打开 trine web
// 配置 ~/.claude-float/trine.json：{"url": "https://…", "machineId": "m-…"}（纯逻辑，好单测）
// 没有这个文件 = 普通 mode，一切照旧（开源用户默认路径）
const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.claude-float', 'trine.json');

/** 会话 id 进 URL 前的收紧：只认字母数字连字符下划线，防拼出奇怪的 URL */
const SAFE_ID = /^[\w-]{1,128}$/;

function loadConfig(file = FILE) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // 没配置 / 文件坏了都当「未开启」
  }
  const url = typeof raw.url === 'string' ? raw.url.trim().replace(/\/+$/, '') : '';
  const machineId = typeof raw.machineId === 'string' ? raw.machineId.trim() : '';
  // 只放行 http(s)，拒绝别的 scheme；machineId 同样只认安全字符
  if (!/^https?:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(url)) return null;
  if (!SAFE_ID.test(machineId)) return null;
  // open：window = 强制浮窗内建 trine 窗口；browser = 系统浏览器开页签；缺省 = 优先唤起已装应用
  const open = raw.open === 'browser' || raw.open === 'window' ? raw.open : 'auto';
  // app：已装 trine 应用（PWA）的快捷方式路径；false = 禁用唤起；缺省 = 自动扫开始菜单
  let app;
  if (raw.app === false) app = false;
  else if (typeof raw.app === 'string' && path.isAbsolute(raw.app)) app = raw.app;
  return { url, machineId, open, ...(app === undefined ? {} : { app }) };
}

/**
 * 在开始菜单里找已安装 trine 应用（PWA）的快捷方式。
 * 浏览器装 PWA 时会在开始菜单放 <应用名>.lnk（Edge/Chrome 同一位置）；启动它
 * = 已在跑就聚焦、没跑就启动到首页——不经过浏览器链接路由，也不会开新页签。
 */
function detectAppShortcut(base = path.join(
  os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs',
)) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 2 || hits.length) return;
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (/^trine.*\.lnk$/i.test(name)) hits.push(full);
    }
  };
  walk(base, 0);
  return hits[0] || null;
}

/** trine web 的会话深链：/s/<machineId>/<sessionId> */
function sessionUrl(cfg, sessionId) {
  const id = String(sessionId || '');
  if (!cfg || !SAFE_ID.test(id)) return null;
  return `${cfg.url}/s/${cfg.machineId}/${id}`;
}

/** trine web 首页（新建会话 sheet 在这里选目录） */
function homeUrl(cfg) {
  return cfg ? cfg.url : null;
}

/** 快捷方式里的 *_proxy.exe(chrome_proxy/msedge_proxy)只认自家旗标，
 * 带 URL 位置参数的启动要换成同目录的真身浏览器进程 */
function realBrowserExe(target) {
  return /_proxy\.exe$/i.test(target)
    ? path.join(path.dirname(target), path.basename(target).replace(/_proxy\.exe$/i, '.exe'))
    : target;
}

/** 快捷方式的 Arguments 字符串拆成参数数组(这里的参数都是无空格的旗标，按空白切够用) */
function splitArgs(argStr) {
  return String(argStr || '').split(/\s+/).filter(Boolean);
}

module.exports = { FILE, loadConfig, sessionUrl, homeUrl, detectAppShortcut, realBrowserExe, splitArgs };
