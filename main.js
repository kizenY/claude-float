const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessions = require('./sessions');
const edgeTts = require('./edge-tts');
const reply = require('./reply');
const focus = require('./focus');

const COLLAPSED_HEIGHT = 40;

let win;
let tray;
let expandedHeight = null;

function statePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; }
}

function patchState(patch) {
  try { fs.writeFileSync(statePath(), JSON.stringify({ ...loadState(), ...patch })); } catch { /* 忽略 */ }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  patchState({ x: b.x, y: b.y, width: b.width, height: expandedHeight || b.height, pinned: win.isAlwaysOnTop() });
}

// 偏好：autostart 开机运行（默认关，托盘里手动勾选才写注册表）
function prefs() {
  return { autostart: loadState().autostart === true };
}

function applyAutostart(on) {
  if (!app.isPackaged && process.env.CLAUDE_FLOAT_SNAPSHOT) return; // 调试截图时不动系统设置
  app.setLoginItemSettings({
    openAtLogin: on,
    path: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()],
  });
}

function onSomeDisplay(s) {
  if (s.x == null || s.y == null) return false;
  return screen.getAllDisplays().some(({ workArea: w }) =>
    s.x >= w.x - 50 && s.y >= w.y - 10 && s.x < w.x + w.width - 50 && s.y < w.y + w.height - 30);
}

function createWindow() {
  const s = loadState();
  const { workArea } = screen.getPrimaryDisplay();
  const width = s.width || 320;
  const height = s.height || 440;
  const pos = onSomeDisplay(s)
    ? { x: s.x, y: s.y }
    : { x: workArea.x + workArea.width - width - 24, y: workArea.y + 80 };

  win = new BrowserWindow({
    ...pos,
    width,
    height,
    minWidth: 240,
    minHeight: COLLAPSED_HEIGHT,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true, // 有托盘图标了，不占任务栏
    backgroundColor: '#00000000',
    transparent: true,
    title: 'Claude 播报',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(s.pinned !== false, 'screen-saver');
  // 浮窗默认不抢前台：点列表行时前台保持原窗口，focus 脚本才能分辨「终端本来就在最前→最小化」。
  // 打开快速回复输入框时经 win:focusable 临时恢复可聚焦（不然打不了字）。
  win.setFocusable(false);
  win.loadFile('index.html');
  win.once('ready-to-show', () => { win.showInactive(); refreshTray(); });
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('show', refreshTray);
  win.on('hide', refreshTray);
  if (process.env.CLAUDE_FLOAT_SNAPSHOT) snapshot(process.env.CLAUDE_FLOAT_SNAPSHOT);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// 托盘图标：橙色圆点，现画，不依赖图片文件
function trayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const outer = Math.max(0, Math.min(1, 14.5 - d));
      const inner = Math.max(0, Math.min(1, 5.5 - d));
      const i = (y * size + x) * 4;
      // BGRA：#D97757 圆，中间白点
      buf[i] = Math.round(0x57 * (1 - inner) + 255 * inner);
      buf[i + 1] = Math.round(0x77 * (1 - inner) + 255 * inner);
      buf[i + 2] = Math.round(0xd9 * (1 - inner) + 255 * inner);
      buf[i + 3] = Math.round(255 * outer);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function toggleWindow() {
  if (win.isVisible()) win.hide();
  else { win.show(); win.focus(); }
}

function refreshTray() {
  if (!tray || !win || win.isDestroyed()) return;
  const p = prefs();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win.isVisible() ? '隐藏浮窗' : '显示浮窗', click: toggleWindow },
    { type: 'separator' },
    {
      label: '开机自动运行', type: 'checkbox', checked: p.autostart,
      click: (item) => { patchState({ autostart: item.checked }); applyAutostart(item.checked); refreshTray(); },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Claude 播报');
  tray.on('click', toggleWindow);
  refreshTray();
}

// 调试用：加载后截图并打印可用声音
function snapshot(out) {
  win.webContents.on('console-message', (e) => console.log('RENDERER', e.message));
  win.webContents.once('did-finish-load', () => setTimeout(async () => {
    if (process.env.CLAUDE_FLOAT_SNAPSHOT_JS) {
      console.log('JS', JSON.stringify(await win.webContents.executeJavaScript(process.env.CLAUDE_FLOAT_SNAPSHOT_JS)));
    }
    fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
    console.log('SNAPSHOT', out);
  }, 2500));
}

ipcMain.handle('sessions:list', (_e, limit) => sessions.list(limit));
ipcMain.handle('sessions:reply', (_e, file) => {
  // 只允许读 projects 目录里的文件
  const abs = path.resolve(file);
  if (!abs.startsWith(path.resolve(sessions.ROOT) + path.sep)) throw new Error('bad path');
  return sessions.reply(abs);
});
// 有活窗口时的终端发送：先试「控制台注入打字」（不切窗口不抢焦点），
// 不行了才退到「聚焦 + 粘贴」（会抢一下前台，只在兜底时用）
async function sendViaPid(pid, text, file) {
  const c = await reply.sendViaConsole({ pid, text, file });
  if (c.ok) return c;
  const t = await reply.sendViaTerminal({ pid, text, file });
  if (t.ok) return { ...t, message: `直接打字没成功，改用聚焦粘贴：${t.message}` };
  return { ok: false, message: `${c.message}；${t.message}` };
}

async function sendTo(id, text) {
  const s = sessions.list(200).find((x) => x.id === id);
  if (!s) return { ok: false, message: '找不到这个会话' };
  const channel = sessions.channelFor(id);
  const pid = sessions.pidFor(id);
  // 首选频道（静默、不抢焦点）；但 Claude Code 2.1.x 会静默吞频道消息（issue #44181），
  // 所以确认没送达就降级走终端。会话正在忙时频道消息可能只是在排队，不降级（会重复），
  // 多等一会儿直接报结果
  if (channel) {
    const busy = s.status === 'working';
    const r = await reply.sendViaChannel({ channel, text, file: s.file, timeoutMs: busy ? 10000 : 3000 });
    if (r.delivered) return r;
    if (busy || !pid) return r;
    const t = await sendViaPid(pid, text, s.file);
    if (t.ok) return { ...t, message: `频道没送达，已改用直接打字：${t.message}` };
    return { ...r, message: `${r.message}；终端发送也失败了：${t.message}` };
  }
  // 没频道（普通 claude 会话）但有活窗口：直接往终端打字也能回
  if (pid) return sendViaPid(pid, text, s.file);
  return { ok: false, message: '这个会话已经结束了，没法回复' };
}
ipcMain.handle('sessions:send', (_e, { id, text }) => sendTo(id, text));
// 点列表项：有活窗口就切到前台（已在前台则最小化）；会话已结束则新开一个 cf 终端
// 恢复（--resume）它。pid 只从会话登记表里查，renderer 传不进任意 pid
ipcMain.handle('session:focus', (_e, id) => {
  const pid = sessions.pidFor(String(id));
  if (pid) return focus.toPid(pid);
  const s = sessions.list(200).find((x) => x.id === id);
  if (!s) return { ok: false, message: '找不到这个会话，没法恢复' };
  // cwd 来自会话记录（jsonl 里的原始工作目录），不是 renderer 传的任意路径；
  // 极老的会话可能没有 cwd，退回用户主目录（claude --resume 按 id 全局找会话，不挑目录）
  spawnCfTerminal(s.cwd || os.homedir(), `--resume ${s.id}`);
  return { ok: true, resumed: true };
});
ipcMain.handle('win:focusable', (_e, on) => {
  win.setFocusable(!!on);
  if (on) win.focus(); // 恢复可聚焦后要显式激活一次，输入框才能拿到键盘焦点
  return !!on;
});

// ---- 快捷启动：从浮窗直接在常用目录起一个 cf 会话 ----
// 目录列表从 ~/.claude-float/quick-dirs.json 读，格式：[{"name":"显示名","path":"工作目录"}]。
// 没有这个文件就只给一个 home 按钮。启动时读一次，改完配置重启浮窗生效。
const QUICK_DIRS_FILE = path.join(os.homedir(), '.claude-float', 'quick-dirs.json');
function loadQuickDirs() {
  try {
    const list = JSON.parse(fs.readFileSync(QUICK_DIRS_FILE, 'utf8'));
    if (Array.isArray(list)) {
      return list.filter((d) => d && typeof d.name === 'string' && typeof d.path === 'string');
    }
  } catch { /* 没有配置文件就用默认 */ }
  return [{ name: 'home', path: os.homedir() }];
}
const QUICK_DIRS = loadQuickDirs();
ipcMain.handle('dirs:list', () => QUICK_DIRS);
// 经 wscript 跳板起一个 cf 终端（新窗口，工作目录 dir）。extraArgs 会原样拼进 cf.cmd
// 的命令行（如 "--resume <id>"，只传无空格无特殊字符的内容）。
// 浮窗是 GUI 程序、没有控制台。直接 spawn 控制台子进程时 Windows 会分一个新窗口，
// 但子进程拿到的是空 stdio 句柄（Node stdio:'ignore' 不传真实控制台句柄），claude 检测不到
// TTY 会以为自己在 --print 管道模式，报 "Input must be provided..." 秒退（2026-10 排查过的坑）。
// 所以经 WScript.Shell.Run 走 ShellExecute，系统会给新控制台分配真实控制台句柄。
// 也不要用 detached（实测静默吞脚本）或 cmd 的 start（这台机器上拉起 .cmd 不稳定）。
// spawn-cf.vbs 里用 powershell -NoExit 起，claude 退出后窗口留在提示符，方便回看记录。
function spawnCfTerminal(dir, extraArgs = '') {
  // 调试后门：设了 CLAUDE_FLOAT_SPAWN_CMD 就改拉别的 payload（排查 spawn 问题时用），正常运行永远走 cf.cmd
  const cfCmd = process.env.CLAUDE_FLOAT_SPAWN_CMD || path.join(__dirname, 'cf.cmd'); // 全路径，不依赖 PATH（浮窗进程的环境可能是旧 PATH）
  const hop = path.join(__dirname, 'spawn-cf.vbs');
  const args = [hop, dir, cfCmd];
  if (extraArgs) args.push(extraArgs);
  spawn('C:\\Windows\\System32\\wscript.exe', args, { stdio: 'ignore' }).unref();
}
ipcMain.handle('session:spawn', (_e, dir) => {
  // 只白名单里的目录可以起，防止 renderer 被注入任意路径
  const target = QUICK_DIRS.find((d) => d.path === dir);
  if (!target) throw new Error('bad dir');
  spawnCfTerminal(target.path);
  return { ok: true, name: target.name };
});
ipcMain.handle('tts:voices', () => edgeTts.VOICES);
ipcMain.handle('tts:synthesize', (_e, text, opts) => edgeTts.synthesize(String(text), opts));
ipcMain.handle('win:pin', () => {
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next, 'screen-saver');
  saveBounds();
  return next;
});
ipcMain.handle('win:isPinned', () => win.isAlwaysOnTop());
ipcMain.handle('win:collapse', () => {
  const b = win.getBounds();
  if (expandedHeight) {
    win.setBounds({ ...b, height: expandedHeight });
    expandedHeight = null;
  } else {
    expandedHeight = b.height;
    win.setBounds({ ...b, height: COLLAPSED_HEIGHT });
  }
  saveBounds();
  return !!expandedHeight;
});
ipcMain.handle('win:hide', () => win.hide());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    if (prefs().autostart) applyAutostart(true); // 刷新一下启动路径，项目挪过位置也不怕
    createWindow();
    createTray();
  });
  app.on('window-all-closed', () => app.quit());
}
