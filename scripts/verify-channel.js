// 端到端验证浮窗频道：向正在运行的 cf 会话发一条测试消息，确认它推进了会话
// 用法：node scripts/verify-channel.js   （前提：有一个用 cf 启动、Claude 已就绪的会话）
const path = require('path');
const sessions = require('../sessions');

const s = sessions.list(50).find((x) => x.channel);
if (!s) {
  console.log('SKIP: 没有带浮窗频道的运行中会话（先用 cf 启动一个 Claude 会话）');
  process.exit(2);
}
const channel = sessions.channelFor(s.id);
if (!channel) {
  console.log('FAIL: 会话标记了频道但读不到登记，可能刚退出');
  process.exit(1);
}

const text = `浮窗频道测试 ${Math.random().toString(36).slice(2, 8)}：收到这条消息只回复「频道正常」四个字，不要做别的。`;
const fs = require('fs');
const sinceSize = fs.statSync(s.file).size;
console.log(`会话: ${s.title} (${s.id.slice(0, 8)})`);
console.log(`发送: ${text}`);

(async () => {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${channel.port}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${channel.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.log('FAIL: 连不上频道端口', e.message);
    process.exit(1);
  }
  console.log('HTTP', res.status);
  if (!res.ok) {
    console.log('FAIL: 频道拒绝了请求');
    process.exit(1);
  }
  const needle = text.trim().slice(0, 30);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const { size } = fs.statSync(s.file);
      if (size > sinceSize) {
        const fd = fs.openSync(s.file, 'r');
        const buf = Buffer.alloc(size - sinceSize);
        fs.readSync(fd, buf, 0, buf.length, sinceSize);
        fs.closeSync(fd);
        if (buf.toString('utf8').includes(needle)) {
          console.log('PASS: 消息已进入会话记录，频道端到端可用');
          return;
        }
      }
    } catch { /* 文件被轮转 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('FAIL: 10 秒内消息没进会话记录');
  console.log('  若 cf 启动时警告过 “no MCP server configured with that name”，');
  console.log('  多半是 channels 没注册成功（protocol revision 或组织禁用）');
  process.exit(1);
})();
