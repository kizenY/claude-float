// 微软 Edge「大声朗读」在线神经语音（非官方接口，协议参照 edge-tts）
const crypto = require('crypto');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 温暖女声' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 活泼女声' },
  { id: 'zh-CN-YunxiNeural', name: '云希 · 阳光男声' },
  { id: 'zh-CN-YunjianNeural', name: '云健 · 沉稳男声' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏 · 少年音' },
  { id: 'zh-CN-YunyangNeural', name: '云扬 · 播音腔' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北 · 东北话' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮 · 陕西话' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻 · 台湾腔' },
];

let clockSkewSec = 0; // 本机时钟偏差，403 时按服务器 Date 校正

function secMsGec() {
  let ticks = Date.now() / 1000 + clockSkewSec + 11644473600; // 转成 Windows file time 纪元
  ticks -= ticks % 300; // 5 分钟取整
  ticks *= 1e7;
  return crypto.createHash('sha256').update(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

function uuid() {
  return crypto.randomUUID().replace(/-/g, '');
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function proxyAgent() {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  return p ? new HttpsProxyAgent(p) : undefined;
}

// 合成一段文字，返回 mp3 Buffer。rate 是倍速（1.2 => +20%）
function synthesizeOnce(text, { voice = VOICES[0].id, rate = 1, agent } = {}) {
  return new Promise((resolve, reject) => {
    const url = `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&ConnectionId=${uuid()}` +
      `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;
    const ws = new WebSocket(url, {
      agent,
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
      },
    });

    const audio = [];
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('edge-tts timeout')); }, 8000);
    const done = (err) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* 忽略 */ }
      if (err) reject(err);
      else if (!audio.length) reject(new Error('edge-tts: no audio'));
      else resolve(Buffer.concat(audio));
    };

    ws.on('unexpected-response', (_req, res) => {
      const serverDate = res.headers.date && Date.parse(res.headers.date);
      if (res.statusCode === 403 && serverDate) clockSkewSec = (serverDate - Date.now()) / 1000;
      done(Object.assign(new Error(`edge-tts HTTP ${res.statusCode}`), { status: res.statusCode }));
    });
    ws.on('error', done);

    ws.on('open', () => {
      const ts = new Date().toString();
      ws.send(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n');
      const pct = Math.round((rate - 1) * 100);
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
        `<voice name='${voice}'><prosody pitch='+0Hz' rate='${pct >= 0 ? '+' : ''}${pct}%' volume='+0%'>` +
        `${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const headerLen = data.readUInt16BE(0);
        const header = data.subarray(2, 2 + headerLen).toString();
        if (header.includes('Path:audio')) audio.push(data.subarray(2 + headerLen));
      } else if (data.toString().includes('Path:turn.end')) {
        done();
      }
    });
  });
}

// 先直连（实测比走代理快），失败再走代理；403 校正时钟后重试一次
async function synthesize(text, opts = {}) {
  const agent = proxyAgent();
  const routes = agent ? [undefined, agent] : [undefined];
  let lastErr;
  for (const a of routes) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await synthesizeOnce(text, { ...opts, agent: a });
      } catch (e) {
        lastErr = e;
        if (e.status !== 403) break;
      }
    }
  }
  throw lastErr;
}

module.exports = { synthesize, VOICES };
