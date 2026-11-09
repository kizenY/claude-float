// 用量查询：GLM Coding Plan 的额度接口（智谱 bigmodel 官方），从浮窗核心的
// glm-usage.js 迁来，按扩展形态改了两点：
// 1) 缓存落盘（~/.claude-float/usage-cache.json）——扩展进程一次一拉、活不长，
//    内存缓存没用；60 秒内的缓存直接用，网络抖动时回退旧值。
// 2) 去掉代理支持——两个宿主给扩展进程的环境变量都是白名单（没有 *_PROXY），
//    接口本身也是国内直连。apiKey 只在进程内用，不进任何输出。
'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const DEFAULT_ENDPOINT = 'https://open.bigmodel.cn';
const CACHE_MS = 60 * 1000;
const CACHE_FILE = path.join(os.homedir(), '.claude-float', 'usage-cache.json');
const FETCH_TIMEOUT = 3200; // 宿主 view 超时 5 秒，留余量：超了就回缓存

function confPath() {
  return path.join(os.homedir(), '.claude-float', 'glm.json');
}

function loadConf() {
  try {
    const conf = JSON.parse(fs.readFileSync(confPath(), 'utf8'));
    if (conf && typeof conf.apiKey === 'string' && conf.apiKey) {
      return { apiKey: conf.apiKey, endpoint: conf.endpoint || DEFAULT_ENDPOINT };
    }
  } catch { /* 没配置 */ }
  return null;
}

// 响应 → 展示结构。limits 是各重置窗口（如 5 小时窗、周窗），按重置时间升序排：
// 最近重置的在前（也就是窗口最短的那个）。字段取值宽松——智谱不同套餐版本
// 见过 TOKENS_LIMIT / CREDIT_LIMIT 两种 type，这里不筛 type，只用百分比和重置时间
function extract(resp, now = Date.now()) {
  const limits = resp && resp.data && Array.isArray(resp.data.limits) ? resp.data.limits : [];
  const windows = limits
    .filter((l) => l && Number.isFinite(l.percentage))
    .map((l) => ({
      pct: Math.round(l.percentage),
      remaining: Number.isFinite(l.remaining) ? l.remaining : null,
      usage: Number.isFinite(l.usage) ? l.usage : null,
      resetAt: Number.isFinite(l.nextResetTime) ? l.nextResetTime : null,
    }))
    .sort((a, b) => (a.resetAt || 0) - (b.resetAt || 0));
  if (!windows.length) return null;
  return {
    level: (resp.data.level || '').trim(),
    windows,
    fetchedAt: now,
  };
}

function httpsGet(url, headers, timeout = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`), { status: res.statusCode }));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return c && Array.isArray(c.windows) ? c : null;
  } catch { return null; }
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, CACHE_FILE);
  } catch { /* 缓存写不进就算了，下次再拉 */ }
}

/**
 * 拿一份能展示的用量：60 秒内的缓存直接用；过期就拉一次（限时 FETCH_TIMEOUT，
 * 拉到就更新缓存）。返回 { data, stale }；没配置返回 null；暂时什么都拿不到返回 null。
 */
async function usage() {
  const conf = loadConf();
  if (!conf) return null;
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return { data: cached, stale: false };
  try {
    const resp = await httpsGet(`${conf.endpoint}/api/monitor/usage/quota/limit`, {
      Authorization: conf.apiKey, // 实测：key 原样放 Authorization，不用 Bearer 前缀
      'Accept-Language': 'en-US,en',
    });
    const data = extract(resp);
    if (data) { writeCache(data); return { data, stale: false }; }
  } catch { /* 拉失败：有旧值就回旧值 */ }
  if (cached) return { data: cached, stale: true };
  return null;
}

module.exports = { usage, extract, loadConf, confPath, CACHE_FILE };
