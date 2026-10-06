const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const sessions = require('./sessions');
const edgeTts = require('./edge-tts');
const reply = require('./reply');

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
async function sendTo(id, text) {
  const s = sessions.list(200).find((x) => x.id === id);
  if (!s) return { ok: false, message: '找不到这个会话' };
  const channel = sessions.channelFor(id);
  if (!channel) return { ok: false, message: '这个会话没有浮窗频道，用 cc 启动的命令行会话才能直接回复' };
  return reply.sendViaChannel({ channel, text, file: s.file });
}
ipcMain.handle('sessions:send', (_e, { id, text }) => sendTo(id, text));
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
