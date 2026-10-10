// 按 pid 把会话的终端窗口切到前台（实现见 scripts/focus-window.ps1）
const { spawn } = require('child_process');
const path = require('path');

function toPid(pid, { noToggle = false } = {}) {
  return new Promise((resolve) => {
    const ps = path.join(__dirname, 'scripts', 'focus-window.ps1');
    const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', ps, String(pid)];
    if (noToggle) args.push('-NoToggle'); // 快速回复要往窗口里粘贴，已在前台也不能最小化
    // -WindowStyle Hidden：powershell 是控制台程序，从 GUI 进程拉起会分一个新控制台窗口，藏起来
    const child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const done = (res) => { if (!settled) { settled = true; resolve(res); } };
    let settled = false;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } done({ ok: false, message: '切换窗口超时' }); }, 8000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => { clearTimeout(timer); done({ ok: false, message: '启动切换脚本失败' }); });
    child.on('close', () => {
      clearTimeout(timer);
      const r = out.trim();
      if (r === 'ok' || r === 'min') return done({ ok: true, minimized: r === 'min' });
      const detail = err.replace(/\s+/g, ' ').trim().slice(0, 120);
      done({ ok: false, message: detail ? `切换失败：${detail}` : '没找到会话的窗口（可能已关闭）' });
    });
  });
}

module.exports = { toPid };
