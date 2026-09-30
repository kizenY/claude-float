const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const sessions = require('./sessions');

const COLLAPSED_HEIGHT = 40;
let win;
let expandedHeight = null;

function statePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; }
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const state = { ...loadState(), x: b.x, y: b.y, width: b.width, pinned: win.isAlwaysOnTop() };
  state.height = expandedHeight || b.height;
  try { fs.writeFileSync(statePath(), JSON.stringify(state)); } catch { /* 忽略 */ }
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
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    transparent: true,
    title: 'Claude 播报',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(s.pinned !== false, 'screen-saver');
  win.loadFile('index.html');
  win.on('moved', saveState);
  win.on('resized', saveState);
  if (process.env.CLAUDE_FLOAT_SNAPSHOT) snapshot(process.env.CLAUDE_FLOAT_SNAPSHOT);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// 调试用：加载后截图并打印可用声音
function snapshot(out) {
  win.webContents.once('did-finish-load', () => setTimeout(async () => {
    const voices = await win.webContents.executeJavaScript(
      'speechSynthesis.getVoices().map(v => v.name + " | " + v.lang + (v.localService ? "" : " (online)"))');
    console.log('VOICES', JSON.stringify(voices));
    if (process.env.CLAUDE_FLOAT_SNAPSHOT_CLICK) {
      await win.webContents.executeJavaScript(`document.querySelectorAll('.item')[${Number(process.env.CLAUDE_FLOAT_SNAPSHOT_CLICK)}].click()`);
      await new Promise((r) => setTimeout(r, 1500));
      console.log('SPEAKING', await win.webContents.executeJavaScript('speechSynthesis.speaking'));
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
ipcMain.handle('win:pin', () => {
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next, 'screen-saver');
  saveState();
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
  saveState();
  return !!expandedHeight;
});
ipcMain.handle('win:close', () => app.quit());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
