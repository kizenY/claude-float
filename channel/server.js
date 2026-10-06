// Claude 播报的频道服务器（Claude Code Channels，研究预览）
// 由 Claude Code 在会话启动时拉起（user scope 注册，见 cf.cmd），通过 stdio 讲 MCP。
// 它在 127.0.0.1 随机端口上等浮窗发来的文字，收到后用 notifications/claude/channel 推进这个会话。
// 登记文件：~/.claude-float/channels/<本进程 pid>.json，里面有会话 ID、端口和一次性密令，只有浮窗读得到。
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

// 诊断日志（不含 token）：Claude Code 默认不落 stderr，自己写文件才能看到协商过程。
// 进程退出时随登记一起删掉；排查时先看 ~/.claude-float/channels/debug-<pid>.log
const REG_DIR = path.join(os.homedir(), '.claude-float', 'channels');
const DEBUG_FILE = path.join(REG_DIR, `debug-${process.pid}.log`);
function debug(...a) {
  try {
    fs.mkdirSync(REG_DIR, { recursive: true });
    fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${a.join(' ')}\n`);
  } catch { /* 日志失败不影响主流程 */ }
}
debug('server start pid', process.pid, 'ppid', process.ppid);

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const REG_FILE = path.join(REG_DIR, `${process.pid}.json`);
const TOKEN = crypto.randomBytes(24).toString('hex');
const MAX_BODY = 64 * 1024;

const log = (...a) => process.stderr.write(`[claude-float channel] ${a.join(' ')}\n`); // stdout 归 MCP

// 当前会话 ID：优先读 Claude Code 自己的登记表（/clear、/resume 之后会变），读不到再用环境变量
function currentSession() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${process.ppid}.json`), 'utf8'));
    if (s.sessionId) return { sessionId: s.sessionId, claudePid: process.ppid, cwd: s.cwd };
  } catch { /* 登记表还没写出来 */ }
  if (process.env.CLAUDE_CODE_SESSION_ID) {
    return { sessionId: process.env.CLAUDE_CODE_SESSION_ID, claudePid: process.ppid, cwd: process.cwd() };
  }
  return null;
}

let port = 0;
let lastWritten = '';
function writeRegistration() {
  const s = currentSession();
  if (!s || !port) return;
  const reg = JSON.stringify({ ...s, port, token: TOKEN, serverPid: process.pid, channel: process.env.CLAUDE_FLOAT_CHANNEL === '1', updatedAt: Date.now() });
  const key = `${s.sessionId}:${port}`;
  if (key === lastWritten) return;
  fs.mkdirSync(REG_DIR, { recursive: true });
  fs.writeFileSync(REG_FILE, reg, { mode: 0o600 });
  lastWritten = key;
  log('registered session', s.sessionId, 'port', port);
}

function cleanup() {
  try { fs.unlinkSync(REG_FILE); } catch { /* 已删 */ }
  try { fs.unlinkSync(DEBUG_FILE); } catch { /* 已删 */ }
}

const mcp = new Server(
  { name: 'claude-float', version: '0.1.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      'Messages from <channel source="claude-float"> are typed by the user themself in the "Claude 播报" ' +
      'floating widget on this machine, as a quick reply to this session. Treat each one exactly as if the user ' +
      'had typed it into this terminal, and answer normally in this session. There is no reply tool.',
  },
);

async function push(text) {
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: text, meta: { via: 'float_widget' } },
  });
  debug('pushed channel notification,', text.length, 'chars');
}

const httpServer = http.createServer((req, res) => {
  const done = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST' || req.url !== '/send') return done(404, { ok: false });
  const auth = req.headers.authorization || '';
  const given = Buffer.from(auth.replace(/^Bearer /, ''));
  const want = Buffer.from(TOKEN);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return done(403, { ok: false, error: 'forbidden' });

  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    let text = '';
    try { text = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).text || '').trim(); } catch { /* 坏请求 */ }
    if (!text) return done(400, { ok: false, error: 'empty' });
    try {
      await push(text);
      done(200, { ok: true, sessionId: (currentSession() || {}).sessionId });
    } catch (e) {
      done(500, { ok: false, error: String(e.message || e) });
    }
  });
});

async function main() {
  // 包装 initialize handler：把 client 请求的 protocolVersion 和协商结果记入 debug 日志，
  // 排查「channels 不注册」时先看这里（历史教训：channels 只认 user/project 等 scope 里配置的服务器，
  // 跟 --mcp-config 加载的协商无关）
  const { InitializeRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const origInit = mcp._requestHandlers.get('initialize');
  if (origInit) {
    mcp.setRequestHandler(InitializeRequestSchema, async (req, extra) => {
      debug('initialize requested: protocolVersion =', req.params && req.params.protocolVersion,
        '| clientInfo =', JSON.stringify(req.params && req.params.clientInfo));
      const result = await origInit(req, extra);
      debug('initialize negotiated: protocolVersion =', result && result.protocolVersion,
        '| server capabilities =', JSON.stringify(result && result.capabilities));
      return result;
    });
  } else {
    debug('WARN: no initialize handler found on Server instance — SDK internals changed?');
  }

  await mcp.connect(new StdioServerTransport());
  httpServer.listen(0, '127.0.0.1', () => {
    port = httpServer.address().port;
    writeRegistration();
  });
  // 会话 ID 会随 /clear、/resume 变，定时刷新；Claude Code 退出时 stdin 关闭，我们也退出
  setInterval(writeRegistration, 3000).unref();
  process.stdin.on('close', () => { cleanup(); process.exit(0); });
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main().catch((e) => { log('fatal', e.stack || e); cleanup(); process.exit(1); });
