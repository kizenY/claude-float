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
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const todos = require('../todos');

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
debug('server start pid', process.pid, 'ppid', process.ppid,
  '| channel env =', JSON.stringify(process.env.CLAUDE_FLOAT_CHANNEL),
  '| claude-ish env keys =', Object.keys(process.env).filter((k) => /CLAUDE|CHANNEL/i.test(k)).join(','));

// 判定频道模式：claude 给 MCP 子进程发的是精选环境变量，cf.cmd 里 set 的
// CLAUDE_FLOAT_CHANNEL 传不到这里（2026-10 实测，debug 日志里 channel env 为空），
// 所以直接读父进程 claude 的命令行，看是不是 --channels 拉起的。也兼容旧的
// --dangerously-load-development-channels 手动启动方式。
function detectChannelMode() {
  if (process.env.CLAUDE_FLOAT_CHANNEL === '1') return true;
  try {
    const { execFileSync } = require('child_process');
    // -EncodedCommand(base64) 走 argv 数组，避开 Windows 引号嵌套地狱；
    // powershell 必须用绝对路径（裸名字在 node 子进程里会掉进交互模式）
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}").CommandLine`;
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const out = execFileSync(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-EncodedCommand', b64],
      { timeout: 8000, windowsHide: true },
    ).toString();
    debug('parent cmdline =', out.trim().slice(0, 200));
    return /--channels|--dangerously-load-development-channels/.test(out);
  } catch (e) { debug('channel mode detect failed:', String(e.message || e)); return false; }
}
const CHANNEL_MODE = detectChannelMode();
debug('channel mode =', CHANNEL_MODE);

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
  const reg = JSON.stringify({ ...s, port, token: TOKEN, serverPid: process.pid, channel: CHANNEL_MODE, updatedAt: Date.now() });
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
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions:
      'Messages from <channel source="claude-float"> are typed by the user themself in the "Claude 播报" ' +
      'floating widget on this machine, as a quick reply to this session. Treat each one exactly as if the user ' +
      'had typed it into this terminal, and answer normally in this session. There is no reply tool. ' +
      'The todos_* tools manage the same todo list that widget shows (~/.claude-float/todos.json): ' +
      'use them whenever the user asks to record, check, finish or drop a 代办/todo for this machine.',
  },
);

// ---- 代办单 tools：会话里直接让 Claude 管代办 ----
// 和浮窗共用 todos.js 与同一个 todos.json；浮窗每 3s 轮询刷新，这边改完不用通知它。
// 工作区不校验 quick-dirs 白名单：任何目录的会话都能记单（浮窗「全部」筛选下可见，
// 只有浮窗侧起会话/建单那条路才需要白名单防注入）。
const TODO_TOOLS = [
  {
    name: 'todos_list',
    description: '列出浮窗代办单（就是「Claude 播报」浮窗里那张看板）。默认只看未完成。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'all'], description: 'open=未完成（默认），done=已完成，all=全部' },
      },
    },
  },
  {
    name: 'todos_add',
    description: '新建一张代办单，自动挂到当前会话，工作区取本会话目录。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题（必填）' },
        desc: { type: 'string', description: '补充描述（可选）' },
      },
      required: ['title'],
    },
  },
  {
    name: 'todos_toggle',
    description: '完成一张代办，再调一次重新打开。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '代办 id（todos_list 里的 [t-...]）' } },
      required: ['id'],
    },
  },
  {
    name: 'todos_remove',
    description: '删掉一张代办（不可恢复，删前跟用户确认一下）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '代办 id' } },
      required: ['id'],
    },
  },
  {
    name: 'todos_bind',
    description: '把一张已有代办挂到当前会话（浮窗上单子会透传本会话的进行中/等待回复状态）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '代办 id' } },
      required: ['id'],
    },
  },
];

function todoText(t) {
  const bits = [`[${t.id}] ${t.title}`];
  if (t.status === 'done') bits.push('（已完成）');
  if (t.desc) bits.push(`描述：${t.desc}`);
  if (t.ws) bits.push(`工作区：${t.ws}`);
  if ((t.sessions || []).length) bits.push(`挂会话 ×${t.sessions.length}`);
  return '- ' + bits.join('　');
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TODO_TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};
  const s = currentSession();
  try {
    let out;
    if (name === 'todos_list') {
      const status = ['open', 'done', 'all'].includes(args.status) ? args.status : 'open';
      const list = todos.list().filter((t) => status === 'all' || t.status === status);
      const label = status === 'open' ? '未完成' : status === 'done' ? '已完成' : '';
      out = list.length ? list.map(todoText).join('\n') : `没有${label}代办`;
    } else if (name === 'todos_add') {
      const title = String(args.title || '').trim();
      if (!title) throw new Error('title 必填');
      const t = todos.create({ title, desc: args.desc, ws: (s || {}).cwd || process.cwd() });
      if (s && s.sessionId) todos.bind(t.id, s.sessionId);
      out = `已建代办 [${t.id}] ${t.title}（挂在本会话，工作区 ${t.ws}）`;
    } else if (name === 'todos_toggle') {
      const t = todos.toggle(String(args.id || ''));
      if (!t) throw new Error(`找不到代办 ${args.id}`);
      out = t.status === 'done' ? `已完成 [${t.id}] ${t.title}` : `重新打开 [${t.id}] ${t.title}`;
    } else if (name === 'todos_remove') {
      if (!todos.remove(String(args.id || ''))) throw new Error(`找不到代办 ${args.id}`);
      out = `已删除 ${args.id}`;
    } else if (name === 'todos_bind') {
      if (!s || !s.sessionId) throw new Error('拿不到当前会话 id，挂不了');
      const t = todos.bind(String(args.id || ''), s.sessionId);
      if (!t) throw new Error(`找不到代办 ${args.id}`);
      out = `已把 [${t.id}] ${t.title} 挂到本会话`;
    } else {
      throw new Error(`unknown tool: ${name}`);
    }
    debug('tool', name, 'ok');
    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    debug('tool', name, 'error:', String(e.message || e));
    return { content: [{ type: 'text', text: `操作失败：${String(e.message || e)}` }], isError: true };
  }
});

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
        '| clientInfo =', JSON.stringify(req.params && req.params.clientInfo),
        '| client capabilities =', JSON.stringify(req.params && req.params.capabilities));
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
