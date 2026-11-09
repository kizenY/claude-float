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
  return { url, machineId };
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

module.exports = { FILE, loadConfig, sessionUrl, homeUrl };
