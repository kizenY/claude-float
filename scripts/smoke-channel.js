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
  // server 的 pid = transport.pid；close 之后 _process 清空、pid 变 null，必须先记下来
  const serverPid = transport.pid;
  console.log('client connected, server pid:', serverPid);
  await new Promise((r) => setTimeout(r, 400)); // 等 debug 落盘

  // 必须先读文件再 close：server 退出时 cleanup() 会删掉自己的 debug 文件，
  // 顺序反了会静默 fallback 到「mtime 最新」的别的会话日志（历史教训）
  const debugFile = serverPid ? path.join(os.homedir(), '.claude-float', 'channels', `debug-${serverPid}.log`) : null;
  if (!debugFile || !fs.existsSync(debugFile)) {
    console.log('FAIL: 没找到本次 server 的 debug 日志（debug-' + serverPid + '.log）');
    await transport.close();
    process.exit(1);
  }
  console.log('--- debug log:', debugFile, '---');
  console.log(fs.readFileSync(debugFile, 'utf8').trim());
  await transport.close();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
