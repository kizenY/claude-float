const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessions = require('./sessions');
const codex = require('./codex-sessions');
const todos = require('./todos');
const edgeTts = require('./edge-tts');
const reply = require('./reply');
const focus = require('./focus');
const petMod = require('./pet');
const glmUsage = require('./glm-usage');

const COLLAPSED_HEIGHT = 40;
// 宠物窗口 = 一帧 192x208 × zoom 0.78（和 pet.css 对齐）
const PET_WIDTH = 150;
const PET_HEIGHT = 162;

let win;
let tray;
let petWin = null;
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
  if (process.env.CLAUDE_FLOAT_SNAPSHOT) snapshot(win, process.env.CLAUDE_FLOAT_SNAPSHOT);
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

// ---- jev 网关开关：控制 cf 新起的会话走不走本地分流网关 ----
// 网关健康检查地址和 --settings 配置文件都在 ~/.claude-float/gateway.conf（cf.cmd 读同一个文件）；
// 开关落地为 ~/.claude-float/gateway-off（存在=关），cmd 一行 if exist 就能识别。
// 没配 gateway.conf 的环境（绝大多数开源用户）整个菜单项都不出现
const GATEWAY_CONF = path.join(os.homedir(), '.claude-float', 'gateway.conf');
const GATEWAY_OFF = path.join(os.homedir(), '.claude-float', 'gateway-off');

function gatewayConfigured() {
  try { return fs.statSync(GATEWAY_CONF).isFile(); } catch { return false; }
}

function gatewayEnabled() {
  return gatewayConfigured() && !fs.existsSync(GATEWAY_OFF);
}

function setGatewayEnabled(on) {
  try {
    if (on) fs.unlinkSync(GATEWAY_OFF);
    else fs.writeFileSync(GATEWAY_OFF, '');
  } catch { /* 已是目标状态 */ }
}

function refreshTray() {
  if (!tray || !win || win.isDestroyed()) return;
  const p = prefs();
  const pet = petPrefs();
  const petItems = PETS.length ? [
    { label: '桌面宠物', type: 'checkbox', checked: pet.enabled, click: (item) => setPetEnabled(item.checked) },
    {
      label: '选择宠物',
      enabled: PETS.length > 1,
      submenu: Menu.buildFromTemplate(PETS.map((x) => ({
        label: x.name,
        type: 'radio',
        checked: x.id === pet.id,
        click: () => switchPet(x.id),
      }))),
    },
    { type: 'separator' },
  ] : [];
  const gwItems = gatewayConfigured() ? [
    {
      label: '新会话走 jev 网关',
      type: 'checkbox',
      checked: gatewayEnabled(),
      click: (item) => { setGatewayEnabled(item.checked); refreshTray(); },
    },
    { type: 'separator' },
  ] : [];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win.isVisible() ? '隐藏浮窗' : '显示浮窗', click: toggleWindow },
    ...gwItems,
    ...petItems,
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
function snapshot(target, out) {
  target.webContents.on('console-message', (e) => console.log('RENDERER', e.message));
  target.webContents.once('did-finish-load', () => setTimeout(async () => {
    if (process.env.CLAUDE_FLOAT_SNAPSHOT_JS && target === win) {
      console.log('JS', JSON.stringify(await win.webContents.executeJavaScript(process.env.CLAUDE_FLOAT_SNAPSHOT_JS)));
    }
    fs.writeFileSync(out, (await target.webContents.capturePage()).toPNG());
    console.log('SNAPSHOT', out);
    if (process.env.CLAUDE_FLOAT_QUIT_AFTER_SNAPSHOT) app.quit(); // 调试：截图完自动退出，脚本化 smoke 用
  }, 2500));
}

ipcMain.handle('sessions:list', async (_e, limit, mode) => {
  const res = mode === 'codex' ? codex.attachPids(codex.list(limit)) : sessions.list(limit);
  // 起会话挂单：等新会话在列表里冒头了就把 id 写进代办（只匹配 claude 会话）
  if (pendingBind && mode !== 'codex') {
    const hitId = todos.matchPending(res, pendingBind);
    if (hitId) {
      todos.bind(pendingBind.todoId, hitId);
      pendingBind = null;
    } else if (Date.now() - pendingBind.at > todos.PENDING_TTL) {
      pendingBind = null; // 新会话一直没来（起失败/太久），放弃
    }
  }
  return res;
});
ipcMain.handle('sessions:reply', (_e, file, mode) => {
  // 只允许读会话记录目录里的文件
  const root = mode === 'codex' ? codex.ROOT : sessions.ROOT;
  const abs = path.resolve(file);
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new Error('bad path');
  return mode === 'codex' ? codex.reply(abs) : sessions.reply(abs);
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

// Codex 没有频道，会话还开在终端里时直接往控制台打字（不抢焦点、不碰剪贴板）
async function sendToCodex(id, text) {
  const s = codex.list(200).find((x) => x.id === id);
  if (!s) return { ok: false, message: '找不到这个会话' };
  const pid = await codex.pidFor(id);
  if (!pid) {
    return { ok: false, message: '这个 Codex 会话没在终端里跑，点列表行用 codex resume 恢复后再回' };
  }
  return sendViaPid(pid, text, s.file);
}
ipcMain.handle('sessions:send', (_e, { id, text, mode }) => (
  mode === 'codex' ? sendToCodex(id, text) : sendTo(id, text)
));
// 点列表项：有活窗口就切到前台（已在前台则最小化）；会话已结束则新开一个终端
// 恢复它（Claude 用 cf --resume，Codex 用 codex resume）。pid 只在主进程这边查，
// renderer 传不进任意 pid
ipcMain.handle('session:focus', async (_e, id, mode) => {
  if (mode === 'codex') {
    const livePid = await codex.pidFor(id);
    if (livePid) return focus.toPid(livePid);
    const c = codex.list(200).find((x) => x.id === id);
    if (!c) return { ok: false, message: '找不到这个会话，没法恢复' };
    spawnCodexTerminal(c.cwd || os.homedir(), `resume ${c.id}`);
    return { ok: true, resumed: true };
  }
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
// 起会话前剥掉 CLAUDE* 环境变量：浮窗若从 Claude Code 会话里启动（调试重启很常见），
// 会继承 CLAUDECODE / CLAUDE_CODE_CHILD_SESSION / CLAUDE_CODE_SESSION_ID 等嵌套标记，
// 新起的 claude 就被当成别的会话的 child session——不写 transcript、不写状态登记，
// 浮窗和宠物全都看不到它（10/14 实锤过）。ANTHROPIC_* 不受影响，认证仍由 cf.cmd/jev settings 管
function cleanSpawnEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^CLAUDE/i.test(key)) delete env[key];
  // 浮窗若从 Claude Code 会话里启动，还会继承 CC 注入的 NO_COLOR=1（不以 CLAUDE 开头，
  // 上面削不掉；10/14 排查「浮窗点行新开的终端里 claude 全黑白」就是它）。
  // 用户级/系统级注册表里没有 NO_COLOR，可放心摘掉；FORCE_COLOR=0 同理（=1/2/3 是强制开色，保留）。
  delete env.NO_COLOR;
  if (env.FORCE_COLOR === '0') delete env.FORCE_COLOR;
  return env;
}

function spawnCfTerminal(dir, extraArgs = '') {
  // 调试后门：设了 CLAUDE_FLOAT_SPAWN_CMD 就改拉别的 payload（排查 spawn 问题时用），正常运行永远走 cf.cmd
  const cfCmd = process.env.CLAUDE_FLOAT_SPAWN_CMD || path.join(__dirname, 'cf.cmd'); // 全路径，不依赖 PATH（浮窗进程的环境可能是旧 PATH）
  const hop = path.join(__dirname, 'spawn-cf.vbs');
  const args = [hop, dir, cfCmd];
  if (extraArgs) args.push(extraArgs);
  spawn('C:\\Windows\\System32\\wscript.exe', args, { env: cleanSpawnEnv(), stdio: 'ignore' }).unref();
}

// ---- Codex 终端：同一个 wscript 跳板，换成 codex 命令 ----
// 启动时解析一次全路径：浮窗进程的环境可能是旧 PATH，直接写 codex 会找不到
function resolveCodexCmd() {
  try {
    const out = execFileSync('where.exe', ['codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((s) => s.trim()).find((p) => /\.(cmd|exe)$/i.test(p)) || 'codex';
  } catch { return 'codex'; }
}
const CODEX_CMD = resolveCodexCmd();
function spawnCodexTerminal(dir, extraArgs = '') {
  const hop = path.join(__dirname, 'spawn-cf.vbs'); // 通用终端跳板：给新控制台真实句柄
  const args = [hop, dir, CODEX_CMD];
  if (extraArgs) args.push(extraArgs);
  spawn('C:\\Windows\\System32\\wscript.exe', args, { env: cleanSpawnEnv(), stdio: 'ignore' }).unref();
}

ipcMain.handle('session:spawn', (_e, dir, mode) => {
  // 只白名单里的目录可以起，防止 renderer 被注入任意路径
  const target = QUICK_DIRS.find((d) => d.path === dir);
  if (!target) throw new Error('bad dir');
  if (mode === 'codex') spawnCodexTerminal(target.path);
  else spawnCfTerminal(target.path);
  return { ok: true, name: target.name };
});

// ---- 代办单：~/.claude-float/todos.json，工作区 = quick-dirs 白名单里的目录 ----
// 起会话前先记下「这个目录当前已知的会话 id」，之后冒出来的新会话就是要挂的那条
let pendingBind = null; // { todoId, ws, knownIds, at }，内存态：浮窗重启丢了就手动补挂
function armPending(todoId, ws) {
  const knownIds = sessions.list(200).filter((s) => todos.sameDir(s.cwd, ws)).map((s) => s.id);
  pendingBind = { todoId, ws, knownIds, at: Date.now() };
}

// 启动条左键弹菜单：新会话 / 新建代办 / 这个工作区的未完成单（点单 = 起会话并挂单）。
// 挂单只对 Claude 会话有效（Codex 会话 id 是另一套，v1 不挂）
ipcMain.handle('launch:menu', (_e, dir, mode) => {
  const target = QUICK_DIRS.find((d) => d.path === dir);
  if (!target) throw new Error('bad dir');
  const spawnFn = mode === 'codex' ? spawnCodexTerminal : spawnCfTerminal;
  const items = [
    { label: `新会话（${target.name}）`, click: () => spawnFn(target.path) },
    { label: '新建代办…', click: () => win.webContents.send('todos:new', { ws: target.path }) },
  ];
  if (mode !== 'codex') {
    const open = todos.list().filter((t) => t.status === 'open' && todos.sameDir(t.ws, target.path));
    if (open.length) {
      items.push(
        { type: 'separator' },
        { label: '起会话并挂单：', enabled: false },
        ...open.slice(0, 10).map((t) => ({
          label: t.title,
          click: () => { armPending(t.id, t.ws); spawnCfTerminal(t.ws); },
        })),
      );
    }
  }
  Menu.buildFromTemplate(items).popup({ window: win });
});

ipcMain.handle('todos:list', () => todos.list());
ipcMain.handle('todos:create', (_e, { title, desc, ws }) => {
  const t = { title: String(title || ''), desc: String(desc || ''), ws: String(ws || '') };
  if (!t.title.trim()) throw new Error('title required');
  // 工作区必须是 quick-dirs 白名单里的目录，和 session:spawn 同一套防注入
  if (!QUICK_DIRS.some((d) => d.path === t.ws)) throw new Error('bad ws');
  return todos.create(t);
});
ipcMain.handle('todos:toggle', (_e, id) => todos.toggle(String(id)));
ipcMain.handle('todos:delete', (_e, id) => ({ ok: todos.remove(String(id)) }));
ipcMain.handle('todos:bind', (_e, { id, sessionId }) => todos.bind(String(id), String(sessionId)));
ipcMain.handle('todos:unbind', (_e, { id, sessionId }) => todos.unbind(String(id), String(sessionId)));
ipcMain.handle('todos:spawn', (_e, id) => {
  const t = todos.list().find((x) => x.id === String(id));
  if (!t || t.status !== 'open' || !QUICK_DIRS.some((d) => d.path === t.ws)) {
    return { ok: false, message: '这张代办不在了，或工作区不在启动目录列表里' };
  }
  armPending(t.id, t.ws);
  spawnCfTerminal(t.ws);
  return { ok: true };
});
ipcMain.handle('tts:voices', () => edgeTts.VOICES);
ipcMain.handle('tts:synthesize', (_e, text, opts) => edgeTts.synthesize(String(text), opts));
ipcMain.handle('usage:plan', () => glmUsage.usage());
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

// ---- 桌面宠物：独立小窗，跟着会话状态换表情（跑动/歪头/庆祝），拖拽不抢焦点 ----
// 宠物包从 ~/.claude-float/pets/ 和 ~/.codex/pets/（CodeX 的宠物自动导入）里找，启动时扫一次
const PETS = petMod.scanPets(petMod.defaultDirs());
let petStatusCache = { working: false, waiting: false, finishedAt: 0 };
// 托盘展开时窗口会变大，petX/petY 始终记「宠物本体」（收起态）的左上角
let petOrigin = null;
let petExpanded = null; // {width, height} | null

// 点开过的会话（等待中/刚完成）：当作已处理，不再进托盘；它再次活跃就解除标记
const petDismissed = new Set(); // 'claude:<id>' / 'codex:<id>'
// 刚完成的会话（working→idle）：留在托盘「空闲」等候查看，直到被点开或再次开跑
const petDone = new Set();
const petPrevStatus = new Map(); // key -> 上一轮状态（给「刚完成」检测用）

function petListItems() {
  // claude + codex 两边合并，各取最近几条；托盘显示 在跑 / 等你 / 刚完成（空闲等候）
  try {
    const claudeItems = sessions.list(10).map((s) => ({ ...s, mode: 'claude' }));
    const codexItems = codex.list(10).map((s) => ({ ...s, mode: 'codex' }));
    const all = [...claudeItems, ...codexItems];
    const seen = new Set();
    for (const s of all) {
      const key = `${s.mode}:${s.id}`;
      seen.add(key);
      const prev = petPrevStatus.get(key);
      if (prev === 'working' && s.status === 'idle') petDone.add(key);
      else if (s.status !== 'idle') petDone.delete(key); // 又开跑了，从「等候」回到「进行中」
      if (s.status === 'working') petDismissed.delete(key); // 开跑的会话永远显示，dismiss 压不住它
      petPrevStatus.set(key, s.status);
    }
    for (const key of [...petDone.keys(), ...petPrevStatus.keys()]) {
      if (!seen.has(key)) { // 会话掉出最近列表就不跟踪了
        petDone.delete(key);
        petPrevStatus.delete(key);
        petDismissed.delete(key);
      }
    }
    return all.filter((s) => {
      const key = `${s.mode}:${s.id}`;
      if (s.status === 'working') return true;
      if (petDismissed.has(key)) return false;
      return s.status === 'waiting' || petDone.has(key);
    }).sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function petPrefs() {
  const s = loadState();
  return { enabled: s.petEnabled !== false, id: s.petId || (PETS[0] && PETS[0].id) || null };
}

function createPetWindow() {
  if (petWin || !PETS.length) return;
  const { workArea } = screen.getPrimaryDisplay();
  const saved = { x: loadState().petX, y: loadState().petY };
  const pos = onSomeDisplay(saved)
    ? { x: saved.x, y: saved.y }
    : { x: workArea.x + workArea.width - PET_WIDTH - 6, y: workArea.y + workArea.height - PET_HEIGHT - 6 };
  petOrigin = pos;
  petWin = new BrowserWindow({
    ...pos,
    width: PET_WIDTH,
    height: PET_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false, // 永远不抢焦点，鼠标事件照常（拖拽、点击）
    title: 'Claude 宠物',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.loadFile('pet.html');
  if (process.env.CLAUDE_FLOAT_PET_SNAPSHOT) snapshot(petWin, process.env.CLAUDE_FLOAT_PET_SNAPSHOT);
  petWin.on('moved', savePetBounds);
  petWin.once('ready-to-show', () => { if (petPrefs().enabled) petWin.showInactive(); });
}

// 拖拽/展开都从 petOrigin（宠物本体左上角）推窗口位置，位置状态也只存它
function petWindowPos() {
  const { workArea } = screen.getPrimaryDisplay();
  const offX = petExpanded ? petExpanded.width - PET_WIDTH : 0;
  const offY = petExpanded ? petExpanded.height - PET_HEIGHT : 0;
  return {
    x: Math.min(Math.max(workArea.x, petOrigin.x - offX), workArea.x + workArea.width - (PET_WIDTH + offX)),
    y: Math.min(Math.max(workArea.y, petOrigin.y - offY), workArea.y + workArea.height - (PET_HEIGHT + offY)),
  };
}

function applyPetBounds() {
  if (!petWin || petWin.isDestroyed()) return;
  petWin.setBounds({
    ...petWindowPos(),
    width: PET_WIDTH + (petExpanded ? petExpanded.width - PET_WIDTH : 0),
    height: PET_HEIGHT + (petExpanded ? petExpanded.height - PET_HEIGHT : 0),
  });
}

function savePetBounds() {
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  petOrigin = { x: b.x + (petExpanded ? petExpanded.width - PET_WIDTH : 0), y: b.y + (petExpanded ? petExpanded.height - PET_HEIGHT : 0) };
  patchState({ petX: petOrigin.x, petY: petOrigin.y });
}

function setPetEnabled(on) {
  patchState({ petEnabled: !!on });
  if (!petWin) createPetWindow();
  if (petWin) { if (on) petWin.showInactive(); else petWin.hide(); }
  refreshTray();
}

function switchPet(id) {
  patchState({ petId: id });
  if (petWin) {
    petWin.reload();
    if (petPrefs().enabled) petWin.showInactive();
  }
}

ipcMain.handle('pet:load', () => {
  const entry = PETS.find((p) => p.id === petPrefs().id) || PETS[0];
  if (!entry) return null;
  const pet = petMod.loadPetManifest(entry.dir, entry.id);
  const buf = fs.readFileSync(pet.sheetPath);
  return { pet, sheet: `data:${pet.mime};base64,${buf.toString('base64')}` };
});
// 状态只在宠物窗口可见时刷新（省得白读一遍会话记录），隐藏时返回缓存
// 宠物窗的轮询入口：每次都现算（和浮窗 3s 一轮同量级），renderer 收起时自己用缓存
ipcMain.handle('pet:sessions', () => {
  const items = petListItems();
  petStatusCache = petMod.aggregateStatus(petStatusCache, items, Date.now());
  return { ...petStatusCache, items };
});
// 托盘尺寸自适应：窗口变大变小，锚点始终是宠物本体（右下），超屏就 clamp
ipcMain.handle('pet:expand', (_e, width, height) => {
  if (!petWin || petWin.isDestroyed()) return;
  petExpanded = { width: Math.round(width), height: Math.round(height) };
  applyPetBounds();
});
ipcMain.handle('pet:move', (_e, dx, dy) => {
  if (!petWin || petWin.isDestroyed()) return;
  petOrigin = { x: petOrigin.x + Math.round(dx), y: petOrigin.y + Math.round(dy) };
  applyPetBounds();
});
// 点开了等待中的会话 = 已处理：托盘里不再显示它（它状态一变就自动回来）
ipcMain.handle('pet:dismiss', (_e, key) => {
  if (typeof key === 'string') petDismissed.add(key);
  return true;
});
ipcMain.handle('pet:hide', () => setPetEnabled(false));
// 点宠物本体 = 切换浮窗显隐（和托盘图标单击同款）
ipcMain.handle('pet:toggle-main', () => toggleWindow());

// 调试截图（CLAUDE_FLOAT_SNAPSHOT）时豁免单实例锁：正主浮窗在跑也能起第二个实例出图，
// 截完自动退出；channel server 是随机端口，不会撞
if (!app.requestSingleInstanceLock() && !process.env.CLAUDE_FLOAT_SNAPSHOT) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    if (prefs().autostart) applyAutostart(true); // 刷新一下启动路径，项目挪过位置也不怕
    createWindow();
    createPetWindow();
    createTray();
  });
  app.on('window-all-closed', () => app.quit());
}
