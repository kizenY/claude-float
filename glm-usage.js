// 订阅用量：查询 GLM Coding Plan 的额度（智谱 bigmodel 的官方用量接口），
// 浮窗底部显示一行各窗口的已用百分比。
// apiKey 放 ~/.claude-float/glm.json：{ "apiKey": "…", "endpoint": "https://open.bigmodel.cn" }。
// endpoint 可选，Z.ai 用户换成 https://api.z.ai。没有配置文件 usage() 返回 null，浮窗不显示这一行。
// 纯 Node 模块，不依赖 Electron；extract() 是纯函数，离线单测。
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DEFAULT_ENDPOINT = 'https://open.bigmodel.cn';
const CACHE_MS = 60 * 1000; // 用量变化慢，一分钟拉一次足够

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

function httpsGet(url, headers, agent) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, agent, timeout: 8000 }, (res) => {
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

function proxyAgent() {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  return p ? new HttpsProxyAgent(p) : undefined;
}

let cache = null; // 最近一次成功的结果（网络抖动时继续显示旧值，别让底行闪烁）

async function refresh() {
  const conf = loadConf();
  if (!conf) return null;
  const headers = {
    Authorization: conf.apiKey, // 实测：key 原样放 Authorization，不用 Bearer 前缀
    'Accept-Language': 'en-US,en',
  };
  const url = `${conf.endpoint}/api/monitor/usage/quota/limit`;
  const agent = proxyAgent();
  const resp = agent
    ? await httpsGet(url, headers, agent).catch(() => httpsGet(url, headers, undefined))
    : await httpsGet(url, headers, undefined);
  const data = extract(resp);
  if (data) cache = data;
  return cache;
}

// 给浮窗的入口：无配置 → null；查询失败但有过成功值 → 回旧值；从没成功 → null
async function usage() {
  if (!loadConf()) return null;
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  try {
    await refresh();
  } catch { /* 行隐藏，下一轮再试 */ }
  return cache;
}

module.exports = { usage, extract, loadConf, confPath };
