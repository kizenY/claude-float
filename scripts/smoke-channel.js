// 冒烟：本地拉起 channel/server.js，走真实 stdio 握手，验证 debug 日志写入 + 协商版本记录
// 用法：node scripts/smoke-channel.js
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'channel', 'server.js');

(async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
  const client = new Client({ name: 'smoke', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  console.log('client connected. client-side protocolVersion:', client.protocolVersion);
  await new Promise((r) => setTimeout(r, 400)); // 等 debug 落盘
  await transport.close();

  const debugFile = path.join(os.homedir(), '.claude-float', 'channels', `debug-${transport.pid ?? '?'}.log`);
  // server 的 pid = transport.pid；若拿不到就列最近的 debug 文件
  let file = debugFile;
  if (!fs.existsSync(file)) {
    const dir = path.dirname(debugFile);
    const candidates = fs.readdirSync(dir).filter((f) => f.startsWith('debug-')).map((f) => path.join(dir, f));
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    file = candidates[0];
  }
  if (!file || !fs.existsSync(file)) {
    console.log('FAIL: 没找到 debug 日志');
    process.exit(1);
  }
  console.log('--- debug log:', file, '---');
  console.log(fs.readFileSync(file, 'utf8').trim());
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
