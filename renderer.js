const $ = (id) => document.getElementById(id);
const listEl = $('list');
const synth = window.speechSynthesis;
const { sameWs, matchDir } = window.Tabs;

const settings = (() => {
  const defaults = { rate: 1.1, voice: 'edge:zh-CN-XiaoxiaoNeural', mode: 'claude', activeTab: '', sessStripOpen: true, railOpen: false, speakBtn: false, replyBtn: false, extOpen: {} };
  try {
    const saved = JSON.parse(localStorage.getItem('settings') || '{}');
    return {
      ...defaults,
      rate: saved.rate || defaults.rate,
      voice: saved.voice || defaults.voice,
      mode: saved.mode === 'codex' ? 'codex' : 'claude',
      activeTab: typeof saved.activeTab === 'string' ? saved.activeTab : '',
      sessStripOpen: saved.sessStripOpen !== false, // 会话列表默认展开
      railOpen: saved.railOpen === true,
      speakBtn: saved.speakBtn === true,
      replyBtn: saved.replyBtn === true,
      extOpen: saved.extOpen && typeof saved.extOpen === 'object' ? saved.extOpen : {},
    };
  } catch { return defaults; }
})();
function saveSettings() {
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch { /* 忽略 */ }
}

let sessions = [];
let speakingId = null;
let speakToken = 0;
let replyTo = null; // 正在回复的会话
// trine 联动：主进程配了 ~/.claude-float/trine.json 就是 trine 模式（点行开 trine web，不走终端）
let trineMode = false;
window.api.trineMode().then((v) => { trineMode = v; }).catch(() => {});

// ---- 形态切换：Claude Code / Codex，一键换列表、换主题色、换启动命令 ----
let mode = settings.mode;
const MODES = {
  claude: { title: 'Claude 播报', agent: 'Claude', launch: 'cf' },
  codex: { title: 'Codex 播报', agent: 'Codex', launch: 'codex' },
};
const modeInfo = () => MODES[mode] || MODES.claude;

function applyMode() {
  const info = modeInfo();
  document.body.classList.toggle('codex', mode === 'codex');
  document.title = info.title;
  $('brand-name').textContent = info.title;
  $('mode-claude').classList.toggle('on', mode === 'claude');
  $('mode-codex').classList.toggle('on', mode === 'codex');
}

function setMode(next) {
  if (next === mode) return;
  mode = next;
  settings.mode = mode;
  saveSettings();
  stop();          // 换形态后别接着读上一个工具的回复
  closeComposer();
  lastStatus.clear();
  statusPrimed = false; // 别把切换当完成，误叮一声
  applyMode();
  refresh();
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const REPLY_ICON = '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v4"/></svg>';
const SPEAK_ICON = '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';

function rowButton(icon, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'row-btn';
  btn.title = title;
  btn.innerHTML = icon;
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

function render() {
  const shown = visibleSessions();
  updateSessCount();
  $('empty').hidden = shown.length > 0;
  $('empty-text').textContent = activeTab === OTHER_TAB
    ? (mode === 'codex' ? '没有归类到启动目录的 Codex 会话' : '没有归类到启动目录的会话')
    : (mode === 'codex'
      ? '这个目录还没有 Codex 会话记录（在终端跑一次 codex 就有了）'
      : '这个目录还没有会话记录');
  listEl.replaceChildren(...shown.map((s) => {
    const li = document.createElement('li');
    li.className = 'item'
      + (s.id === speakingId ? ' speaking' : '')
      + (s.status === 'waiting' ? ' waiting' : '')
      + (replyTo && s.id === replyTo.id ? ' replying' : '');
    li.title = s.pid ? '点击切换到会话窗口' : '会话已结束，点击新开终端并恢复';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = s.title;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = document.createElement('span');
    time.className = 'time';
    if (s.id === speakingId) {
      time.innerHTML = '<span class="bars"><i></i><i></i><i></i></span>';
    } else if (s.status === 'working') {
      time.innerHTML = '<span class="chip working">进行中</span>';
    } else if (s.status === 'waiting') {
      time.innerHTML = '<span class="chip waiting">等待回复</span>';
      time.title = s.waitingFor ? `${modeInfo().agent} 在等你：${s.waitingFor}` : `${modeInfo().agent} 在等你：提问、确认计划或批准操作`;
    } else {
      time.textContent = ago(s.mtime);
    }
    meta.append(time);
    // 朗读/回复按钮默认藏起来（设置里开），别挤标题；朗读中了还有标题栏停止键 + Esc 兜底
    const speaking = s.id === speakingId;
    if (settings.speakBtn) {
      meta.append(rowButton(speaking ? STOP_ICON : SPEAK_ICON, speaking ? '停止朗读' : '朗读最新回复', () => toggleSpeak(s)));
    }
    if (settings.replyBtn) {
      // trine 模式下只有带频道的会话能快速回复（trine 起的会话没有频道，回它请去 trine web）
      const canReply = s.channel || (!trineMode && s.pid);
      const replyOffHint = mode === 'codex'
        ? (trineMode ? '请在 trine 里回复这个 Codex 会话' : '这个 Codex 会话没在终端里跑，点列表行恢复后再回')
        : (trineMode && !s.channel ? '这个会话没有频道，请在 trine 里回复它' : '这个会话已经结束了，没法直接回复');
      const replyBtn = rowButton(REPLY_ICON, canReply ? '快速回复' : replyOffHint, () => {
        if (canReply) openComposer(s);
        else flash(replyOffHint);
      });
      replyBtn.classList.add('reply-btn');
      if (!canReply) replyBtn.classList.add('off');
      meta.append(replyBtn);
    }

    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.append(s.preview || (s.channel ? '新会话，可以直接从这里发第一条消息' : ''));

    li.append(title, meta, preview);
    li.addEventListener('click', () => focusSession(s));
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openSessionMenu(s, e.clientX, e.clientY);
    });
    return li;
  }));
}

// ---- 完成提示音：会话从「进行中」变「空闲/等待回复」时叮一声 ----
const lastStatus = new Map();
let statusPrimed = false;
let audioCtx = null;

function ding() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    [[880, 0, 0.12], [1318.5, 0.1, 0.22]].forEach(([freq, delay, dur]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + delay);
      gain.gain.linearRampToValueAtTime(0.18, t0 + delay + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + delay + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + delay);
      osc.stop(t0 + delay + dur + 0.05);
    });
  } catch (e) { console.error('ding', e); }
}

async function refresh() {
  try {
    const fresh = await window.api.list(50, mode);
    // 第一轮只建基线，不把存量会话当「刚完成」
    const finished = statusPrimed && fresh.some((s) =>
      lastStatus.get(s.id) === 'working' && (s.status === 'idle' || s.status === 'waiting'));
    lastStatus.clear();
    for (const s of fresh) lastStatus.set(s.id, s.status);
    statusPrimed = true;
    sessions = fresh;
    render();
    if (finished) ding();
  } catch (e) {
    console.error(e);
  }
}

// 点列表项：trine 模式在浏览器打开 trine 会话；否则有窗口就切到会话的终端前台/后台，
// 会话已结束则新开终端恢复它（快捷回复走 ↩ 按钮，不走这里）
async function focusSession(s) {
  try {
    const res = await window.api.focus(s.id, mode);
    if (!res.ok) flash(res.message || '没找到会话的窗口');
    else if (res.trine) flash('已在浏览器打开 trine 会话');
    else if (res.resumed) flash('已在新终端恢复这个会话');
  } catch (e) {
    flash(`切换失败：${String(e.message || e)}`);
  }
}

// settings.voice: "edge:<神经语音 id>" 或 "sys:<系统语音 voiceURI>"
let edgeVoices = [];
let currentAudio = null;

function sysVoice(uri) {
  const voices = synth.getVoices();
  return voices.find((v) => v.voiceURI === uri)
    || voices.find((v) => /^zh[-_]CN/i.test(v.lang))
    || voices.find((v) => /^zh/i.test(v.lang))
    || voices[0];
}

function setSpeaking(id) {
  speakingId = id;
  $('btn-stop').hidden = !id;
  $('speaking-dot').hidden = !id;
  render();
}

let statusTimer;
function flash(msg) {
  $('status').textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $('status').textContent = ''; }, 6000);
}

function stop() {
  speakToken++;
  synth.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.onended && currentAudio.onended();
    currentAudio = null;
  }
  setSpeaking(null);
}

function playMp3(bytes) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    const a = new Audio(url);
    const finish = (err) => {
      a.onended = a.onerror = null;
      URL.revokeObjectURL(url);
      if (currentAudio === a) currentAudio = null;
      err ? reject(err) : resolve();
    };
    a.onended = () => finish();
    a.onerror = () => finish(new Error('audio playback failed: ' + (a.error ? a.error.code + ' ' + a.error.message : '?') + ' bytes=' + bytes.length));
    currentAudio = a;
    a.play().catch(finish);
  });
}

function speakSystem(chunks, token) {
  return new Promise((resolve) => {
    if (!chunks.length) return resolve();
    const voice = sysVoice(settings.voice.startsWith('sys:') ? settings.voice.slice(4) : '');
    chunks.forEach((c, i) => {
      const u = new SpeechSynthesisUtterance(c);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = settings.rate;
      const last = i === chunks.length - 1;
      u.onend = () => { if (last) resolve(); };
      u.onerror = (ev) => {
        if (ev.error !== 'canceled' && ev.error !== 'interrupted') console.error('tts', ev.error);
        if (last) resolve();
      };
      if (token === speakToken) synth.speak(u);
    });
  });
}

// 边播边合成：当前段播放时，后面两段已经在请求
async function speakEdge(chunks, voice, token) {
  const pending = [];
  const fetchAt = (i) => {
    if (i >= chunks.length || pending[i]) return;
    pending[i] = window.api.synthesize(chunks[i], { voice, rate: settings.rate });
    pending[i].catch(() => {}); // 停止后没人等的请求别报未处理
  };
  fetchAt(0); fetchAt(1);
  for (let i = 0; i < chunks.length; i++) {
    let bytes;
    try {
      bytes = await pending[i];
    } catch (e) {
      console.error('edge-tts', e);
      if (token !== speakToken) return;
      flash('在线语音连不上，改用系统语音');
      return speakSystem(chunks.slice(i), token);
    }
    if (token !== speakToken) return;
    fetchAt(i + 2);
    await playMp3(bytes).catch((e) => console.error(e));
    if (token !== speakToken) return;
  }
}

async function toggleSpeak(s) {
  if (speakingId === s.id) return stop();
  stop();
  const token = speakToken;
  setSpeaking(s.id);

  let text;
  try {
    text = s.file ? window.SpeechText.toSpeech(await window.api.reply(s.file, mode)) : '';
  } catch (e) {
    console.error(e);
    text = '读取会话失败。';
  }
  if (token !== speakToken) return;
  text = text || '这条会话还没有文字回复。';

  if (settings.voice.startsWith('edge:')) {
    // 第一段短一点，尽快出声
    await speakEdge(window.SpeechText.chunk(text, 400, 60), settings.voice.slice(5), token);
  } else {
    await speakSystem(window.SpeechText.chunk(text), token);
  }
  if (token === speakToken) setSpeaking(null);
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  o.selected = value === settings.voice;
  return o;
}

function fillVoices() {
  const groups = [];
  if (edgeVoices.length) {
    const g = document.createElement('optgroup');
    g.label = '在线神经语音';
    g.append(...edgeVoices.map((v) => option(`edge:${v.id}`, v.name)));
    groups.push(g);
  }
  const sys = synth.getVoices();
  if (sys.length) {
    const g = document.createElement('optgroup');
    g.label = '系统语音（离线）';
    g.append(...sys.map((v) => option(`sys:${v.voiceURI}`,
      v.name.replace(/^Microsoft\s+/, '').replace(/\s+-\s+.*$/, '') + ` (${v.lang})`)));
    groups.push(g);
  }
  $('voice').replaceChildren(...groups);
}

$('voice').addEventListener('change', (e) => { settings.voice = e.target.value; saveSettings(); });
$('rate').value = settings.rate;
$('rate-val').textContent = `${settings.rate}x`;
$('rate').addEventListener('input', (e) => {
  settings.rate = Number(e.target.value);
  $('rate-val').textContent = `${settings.rate}x`;
  saveSettings();
});

$('btn-stop').addEventListener('click', stop);
// ---- 快速回复 ----
let sending = false;

function setComposerStatus(text, kind = '') {
  const el = $('composer-status');
  el.textContent = text;
  el.className = 'composer-status' + (kind ? ` ${kind}` : '');
}

async function openComposer(s, prefill) {
  closeSettings();
  replyTo = s;
  $('composer').hidden = false;
  $('composer-title').textContent = s.title;
  setComposerStatus(s.status === 'working' ? `${modeInfo().agent} 还在干活，消息会排队` : '');
  if (prefill) $('composer-input').value = String(prefill).slice(0, 32 * 1024);
  render();
  // 浮窗平时不可聚焦（点列表行不抢前台），要打字了才临时恢复
  await window.api.setFocusable(true);
  $('composer-input').focus();
}

function closeComposer() {
  if (sending) return;
  replyTo = null;
  $('composer').hidden = true;
  $('composer-input').value = '';
  window.api.setFocusable(false);
  render();
}

async function sendReply() {
  const text = $('composer-input').value.trim();
  if (!replyTo || !text || sending) return;
  sending = true;
  $('composer-send').disabled = true;
  setComposerStatus(`正在发送到 ${modeInfo().agent}…`);
  let res;
  try {
    res = await window.api.send(replyTo.id, text, mode);
  } catch (e) {
    res = { ok: false, message: String(e.message || e) };
  }
  sending = false;
  $('composer-send').disabled = false;
  if (res.ok) {
    $('composer-input').value = '';
    setComposerStatus(res.message || '已发送', res.delivered === false ? '' : 'ok');
    setTimeout(() => { if (!$('composer-input').value) closeComposer(); }, 1500);
    refresh();
  } else {
    setComposerStatus(res.message || '发送失败', 'error');
  }
}

$('composer').addEventListener('submit', (e) => { e.preventDefault(); sendReply(); });
$('composer-cancel').addEventListener('click', closeComposer);
$('composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendReply(); }
  if (e.key === 'Escape') { e.stopPropagation(); closeComposer(); }
});

$('btn-close').addEventListener('click', () => window.api.hide());

// ---- 设置弹层：声音/语速低频，收进齿轮后的浮层（渐进披露，入口常驻可见） ----
const settingsOpen = () => !$('settings-pop').hidden;

function closeSettings() {
  if (!settingsOpen()) return;
  $('settings-pop').hidden = true;
  $('btn-settings').classList.remove('on');
  window.api.setFocusable(false);
}

async function openSettings() {
  if (settingsOpen() || !$('composer').hidden) return; // 打字优先，弹层别盖回复框
  $('settings-pop').hidden = false;
  $('btn-settings').classList.add('on');
  await window.api.setFocusable(true);
}

$('btn-settings').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (settingsOpen()) closeSettings();
  else await openSettings();
});
$('settings-pop').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { if (settingsOpen()) closeSettings(); });

// ---- 目录侧栏：quick-dirs 生成 + 末尾「其他」兜底，会话和任务跟着目录过滤 ----
const OTHER_TAB = 'other';
let quickDirList = [];
let activeTab = settings.activeTab;     // 目录 path（quick-dirs 原样字符串）或 'other'
let sessOpen = settings.sessStripOpen; // 会话区展开态（默认展开）

const tabOf = (dir) => matchDir(dir, quickDirList) || OTHER_TAB;
const activeDir = () => quickDirList.find((d) => d.path === activeTab) || null;

function visibleSessions() {
  return sessions.filter((s) => tabOf(s.cwd) === activeTab);
}

// 存的 Tab 得还在 quick-dirs 里才有效（配置改过就回第一个），并归一成 dir 的原样 path
function restoreActiveTab() {
  if (activeTab === OTHER_TAB) return;
  const hit = quickDirList.find((d) => sameWs(activeTab, d.path));
  activeTab = hit ? hit.path : (quickDirList.length ? quickDirList[0].path : OTHER_TAB);
}

const dirEntries = () => [
  ...quickDirList.map((d) => ({ key: d.path, name: d.name })),
  { key: OTHER_TAB, name: '其他' },
];

// 左侧目录栏：竖排常驻；默认收起成窄条（只有目录首字方块），点目录块展开 + 切目录，
// 展开态顶部 « 收起；quick-dirs 加载时全量重建，切 Tab 只挪高亮
let railOpen = settings.railOpen;

const railFoldBtn = (() => {
  const b = el('button', 'rail-fold');
  b.type = 'button';
  b.title = '收起目录栏';
  b.textContent = '«';
  b.addEventListener('click', () => setRailOpen(false));
  return b;
})();

function setRailOpen(open) {
  railOpen = open;
  settings.railOpen = open;
  saveSettings();
  $('dir-rail').classList.toggle('collapsed', !open);
  railFoldBtn.hidden = !open;
}

function renderDirRail() {
  $('dir-rail').replaceChildren(railFoldBtn, ...dirEntries().map((t) => {
    const btn = el('button', 'dir-item' + (t.key === activeTab ? ' on' : ''));
    btn.type = 'button';
    btn.dataset.key = t.key;
    btn.title = t.key === OTHER_TAB ? '没归到启动目录里的会话' : t.key;
    btn.append(el('span', 'dir-item-glyph', (t.name || '?')[0]));
    btn.append(el('span', 'dir-item-name', t.name));
    btn.addEventListener('click', () => {
      if (!railOpen) setRailOpen(true); // 收起态点目录块：先展开侧栏再切目录，一步到位
      setActiveTab(t.key);
    });
    return btn;
  }));
  setRailOpen(railOpen); // 重建后恢复当前形态（顺带摆好 « 按钮）
}

// 只挪高亮不重建，免得打断 hover
function markActiveDirRail() {
  for (const btn of $('dir-rail').children) {
    if (!btn.dataset.key) continue; // « 按钮不是目录项
    btn.classList.toggle('on', btn.dataset.key === activeTab);
  }
}

function setActiveTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;
  settings.activeTab = tab;
  saveSettings();
  markActiveDirRail();
  updateSessionNew();
  render();
  refreshExts(); // 扩展的目录上下文换了，开着的面板重拉
}

// 会话收放行右侧的 ＋：在当前目录起新会话；「其他」Tab 没有可启动的目录，不显示
function updateSessionNew() {
  const dir = activeDir();
  $('session-new').hidden = !dir;
  if (dir) $('session-new').title = `在 ${dir.name} 起新会话`;
}

window.api.quickDirs().then((dirs) => {
  quickDirList = dirs;
  restoreActiveTab();
  renderDirRail();
  renderSessStrip();
  updateSessionNew();
  render();
  refreshExts();
}).catch(() => {
  restoreActiveTab();
  renderDirRail();
  renderSessStrip();
  updateSessionNew();
});

// ---- 任务单面板已是官方扩展（exts/todos）：这里只剩会话列表本体 ----
// 数据（todos.json）的读写一直走会话里的 MCP todos_* 工具，浮窗不再自带任务 UI；
// 浮窗侧装 `node ext.js add exts/todos`、trine 侧装 `trine-agent ext add exts/todos`。

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---- 通用右键菜单（自绘，跟浮窗同一套主题变量；先用在会话行上） ----
// items: { label, danger, onClick(btn) } | 'sep'。onClick 里自己决定要不要 closeCtxMenu
// （两段确认的项第一击不关，改按钮文案等第二击）
let ctxMenuEl = null;
function onCtxDismiss(e) {
  // 点/右键在菜单外一律关；在菜单上再右键也当「关掉重选」
  if (e.type === 'contextmenu' || !ctxMenuEl.contains(e.target)) closeCtxMenu();
}
function closeCtxMenu() {
  if (!ctxMenuEl) return;
  ctxMenuEl.remove();
  ctxMenuEl = null;
  document.removeEventListener('pointerdown', onCtxDismiss, true);
  document.removeEventListener('contextmenu', onCtxDismiss, true);
}
function showCtxMenu(x, y, items) {
  closeCtxMenu();
  const m = el('div', 'ctx-menu');
  for (const it of items) {
    if (it === 'sep') { m.append(el('div', 'ctx-sep')); continue; }
    const b = el('button', 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''), it.label);
    b.type = 'button';
    if (it.disabled) b.disabled = true;
    b.addEventListener('click', (e) => { e.stopPropagation(); it.onClick(b); });
    m.append(b);
  }
  document.body.append(m);
  // 先量尺寸再贴边收拢，浮窗小，菜单不能被窗口边缘裁掉
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  ctxMenuEl = m;
  document.addEventListener('pointerdown', onCtxDismiss, true);
  document.addEventListener('contextmenu', onCtxDismiss, true);
}

async function copyText(text, okMsg) {
  try {
    await window.api.clipboardWrite(text);
    flash(okMsg || '已复制');
  } catch { flash('复制失败'); }
}

// 会话行的右键菜单：朗读/快速回复不再依赖行上按钮开关（默认藏着，这里常驻），另挂复制/开目录/起新会话
function openSessionMenu(s, x, y) {
  const speaking = s.id === speakingId;
  const items = [
    { label: speaking ? '⏹ 停止朗读' : '🔊 朗读最新回复', onClick: () => { closeCtxMenu(); toggleSpeak(s); } },
  ];
  // 已结束的会话没法回复，不给这一项（点行本身就会 --resume 恢复）；trine 模式只认带频道的
  if (s.channel || (!trineMode && s.pid)) {
    items.push({ label: '↩ 快速回复', onClick: () => { closeCtxMenu(); openComposer(s); } });
  }
  items.push('sep', { label: '⧉ 复制标题', onClick: () => { closeCtxMenu(); copyText(s.title, '标题已复制'); } });
  if (s.preview) {
    items.push({ label: '⧉ 复制最新输出', onClick: () => { closeCtxMenu(); copyText(s.preview, '最新输出已复制'); } });
  }
  if (s.cwd) {
    items.push({ label: '📂 打开会话目录', onClick: () => { closeCtxMenu(); window.api.openPath(s.cwd).catch(() => flash('打开失败')); } });
  }
  // 起新会话在主进程只认 quick-dirs 白名单（防注入）；matchDir 命中才有这一项，拿白名单原样 path 去比对
  const spawnDir = matchDir(s.cwd, quickDirList);
  if (spawnDir) {
    items.push({ label: '＋ 在此目录起新会话', onClick: () => {
      closeCtxMenu();
      window.api.spawn(spawnDir, mode)
        .then((r) => flash(r.trine ? '已打开 trine，请在那里新建会话并选这个目录' : `已在 ${s.project || '该目录'} 起新会话`))
        .catch((e) => flash(`启动失败：${String(e.message || e)}`));
    } });
  }
  // 移出列表（两段确认）：只藏不删，记录文件不动；移出后不再出现在浮窗（设置里也没有恢复入口）
  items.push('sep');
  items.push({ label: '移出列表', danger: true, onClick: (btn) => {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = '再点一次移出';
      setTimeout(() => {
        if (!ctxMenuEl || !ctxMenuEl.contains(btn)) return;
        btn.classList.remove('armed');
        btn.textContent = '移出列表';
      }, 3000);
      return;
    }
    closeCtxMenu();
    window.api.sessionHide(s.id, s.title).then(() => {
      flash('已移出列表');
      refresh();
    }).catch((err) => flash(`移出失败：${String(err.message || err)}`));
  } });
  showCtxMenu(x, y, items);
}

// 会话区收放行：caret + 标题 + 计数，列表整体显隐
function renderSessStrip() {
  $('sess-caret').classList.toggle('open', sessOpen);
  $('list-wrap').hidden = !sessOpen;
  updateSessCount();
}

function updateSessCount() {
  const n = sessions.filter((s) => tabOf(s.cwd) === activeTab).length;
  $('sess-count').hidden = n === 0;
  $('sess-count').textContent = String(n);
}

// 会话区收起/展开（状态记住；默认展开）
$('sess-toggle').addEventListener('click', () => {
  sessOpen = !sessOpen;
  settings.sessStripOpen = sessOpen;
  saveSettings();
  renderSessStrip();
});
// 会话收放行的 ＋：在当前目录起一个新会话（Claude 形态走 cf，Codex 形态走 codex；trine 模式打开 trine）
$('session-new').addEventListener('click', async () => {
  const dir = activeDir();
  if (!dir) return;
  try {
    const r = await window.api.spawn(dir.path, mode);
    flash(r.trine ? '已打开 trine，请在那里新建会话并选这个目录' : `已在 ${dir.name} 起新会话`);
  } catch (e) {
    flash(`启动失败：${String(e.message || e)}`);
  }
});

// ---- 扩展面板：已注册扩展（node ext.js add）各占一条收放行，排在会话列表下面 ----
// 浮窗只渲染扩展进程吐出的固定视图词汇（分组/条目/徽章/详情/动作），不执行任何扩展代码。
// 读取永远无副作用：只在展开/切目录/点动作后拉一次（主进程还有 15s 缓存）；
// 发消息/起会话类动作两段确认后才执行，确认前后内容不变。
let extPanels = [];
const extViews = new Map();   // 扩展 id -> { loading? } | { ok, view? } | { ok:false, error? }
const extDetail = new Map();  // 扩展 id -> 展开详情的条目 id
let extOpen = { ...settings.extOpen };

const EXT_REFRESH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
const extTitle = (p) => p.title || p.name || p.id;
const extBodyEl = (id) => document.getElementById(`ext-body-${CSS.escape(id)}`);

async function refreshExts() {
  try { extPanels = await window.api.extList(); } catch { return; }
  renderExtStrips();
  for (const p of extPanels) if (extOpen[p.id]) fetchExtView(p.id);
}

async function fetchExtView(id, force) {
  extViews.set(id, { loading: true });
  renderExtStrips();
  try {
    const dir = activeDir();
    extViews.set(id, await window.api.extView(id, dir ? dir.path : null, !!force));
  } catch (e) {
    extViews.set(id, { ok: false, error: { message: String(e.message || e) } });
  }
  renderExtStrips();
}

function extBadgeEl(bg) {
  const b = el('span', 'ext-badge' + (bg.tone ? ' ' + bg.tone : ''), bg.text);
  if (bg.title) b.title = bg.title;
  return b;
}

// 动作按钮：带发消息/起会话效果、或标了 confirm/destructive 的要两段确认（先亮「确认执行？」）
function extActionButton(p, action) {
  const btn = el('button', 'ext-act' + (action.primary ? ' primary' : '') + (action.destructive ? ' danger' : ''));
  btn.type = 'button';
  btn.textContent = action.label;
  const needConfirm = (action.effects || []).some((e) => e.type === 'prompt.send' || e.type === 'session.create')
    || action.confirm != null || action.destructive === true;
  if (action.confirm) btn.title = action.confirm;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (needConfirm && !btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.dataset.label = btn.textContent;
      btn.textContent = action.confirm || '确认执行？';
      setTimeout(() => {
        if (!btn.classList.contains('armed')) return;
        btn.classList.remove('armed');
        if (btn.dataset.label) btn.textContent = btn.dataset.label;
      }, 3000);
      return;
    }
    btn.classList.remove('armed');
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    await runExtAction(p, action);
  });
  return btn;
}

async function runExtAction(p, action) {
  const effects = action.effects || [];
  // 本地效果浮窗直接做：复制、刷新、往快速回复框预填（目标会话不在了就退化成复制）
  for (const e of effects) {
    if (e.type === 'copy') await copyText(e.text, '已复制');
    else if (e.type === 'refresh') fetchExtView(p.id, true);
    else if (e.type === 'prompt.insert') {
      const s = sessions.find((x) => x.id === e.sessionId);
      if (s && (s.channel || s.pid)) await openComposer(s, e.text);
      else await copyText(e.text, '目标会话不在了，文字已复制到剪贴板');
    }
  }
  // 要经主进程的效果（发消息/起会话）：两段确认已过，主进程再查一遍能力
  if (effects.some((e) => e.type === 'prompt.send' || e.type === 'session.create')) {
    const dir = activeDir();
    try {
      const res = await window.api.extAction({ extId: p.id, actionId: action.id, effects, cwd: dir ? dir.path : null });
      flash(res.message || (res.ok ? '已执行' : '执行失败'));
    } catch (err) {
      flash(`执行失败：${String(err.message || err)}`);
    }
    fetchExtView(p.id, true); // 动作可能改了扩展背后的数据，刷新一眼
  }
}

function extItemEl(p, it) {
  const row = el('div', 'ext-item');
  const top = el('div', 'ext-item-top');
  top.append(el('span', 'ext-item-title', it.title));
  if (it.meta) top.append(el('span', 'ext-item-meta', it.meta));
  if (it.badges) for (const bg of it.badges) top.append(extBadgeEl(bg));
  row.append(top);
  if (it.subtitle) row.append(el('div', 'ext-item-sub', it.subtitle));
  if (it.detail && extDetail.get(p.id) === it.id) row.append(el('div', 'ext-item-detail', it.detail));
  if (it.actions && it.actions.length) {
    const bar = el('div', 'ext-actions');
    for (const a of it.actions) bar.append(extActionButton(p, a));
    row.append(bar);
  }
  if (it.detail) {
    row.classList.add('has-detail');
    row.title = '点击展开/收起详情';
    row.addEventListener('click', () => {
      extDetail.set(p.id, extDetail.get(p.id) === it.id ? null : it.id);
      renderExtStrips();
    });
  }
  return row;
}

function renderExtBody(p) {
  const body = extBodyEl(p.id);
  if (!body) return;
  const v = extViews.get(p.id);
  if (!v || v.loading) { body.replaceChildren(el('div', 'ext-hint', '读取中…')); return; }
  if (!v.ok) { body.replaceChildren(el('div', 'ext-error', (v.error && v.error.message) || '扩展没返回内容')); return; }
  const view = v.view;
  const frag = document.createDocumentFragment();
  if (view.toolbar && view.toolbar.length) {
    const bar = el('div', 'ext-actions ext-toolbar');
    for (const a of view.toolbar) bar.append(extActionButton(p, a));
    frag.append(bar);
  }
  if (!view.sections.length && view.empty != null) frag.append(el('div', 'ext-hint', view.empty));
  for (const sec of view.sections) {
    const box = el('div', 'ext-section');
    if (sec.title) box.append(el('div', 'ext-section-title', sec.title));
    if (!sec.items.length && sec.empty != null) box.append(el('div', 'ext-hint', sec.empty));
    for (const it of sec.items) box.append(extItemEl(p, it));
    frag.append(box);
  }
  body.replaceChildren(frag);
}

function renderExtStrips() {
  $('ext-panels').replaceChildren(...extPanels.map((p) => {
    const open = !!extOpen[p.id];
    const panel = el('div', 'ext-panel');
    const head = el('div', 'strip-head ext-head');
    const toggle = el('button', 'strip-toggle');
    toggle.type = 'button';
    toggle.title = '展开/收起扩展面板';
    toggle.innerHTML = `<svg class="strip-caret${open ? ' open' : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    toggle.append(el('span', 'strip-title', extTitle(p)));
    const v = extViews.get(p.id);
    const count = v && v.ok ? v.view.sections.reduce((n, s) => n + s.items.length, 0) : 0;
    if (count) toggle.append(el('span', 'strip-count', count > 99 ? '99+' : String(count)));
    toggle.addEventListener('click', () => {
      extOpen[p.id] = !extOpen[p.id];
      settings.extOpen = { ...extOpen };
      saveSettings();
      renderExtStrips();
      if (extOpen[p.id]) fetchExtView(p.id);
    });
    const ref = el('button', 'strip-plus ext-refresh');
    ref.type = 'button';
    ref.title = '刷新这个扩展';
    ref.innerHTML = EXT_REFRESH_ICON;
    ref.addEventListener('click', (e) => { e.stopPropagation(); fetchExtView(p.id, true); });
    head.append(toggle, ref);
    const bodyWrap = el('div', 'strip-body');
    bodyWrap.hidden = !open;
    const body = el('div', 'ext-body');
    body.id = `ext-body-${p.id}`;
    bodyWrap.append(body);
    panel.append(head, bodyWrap);
    return panel;
  }));
  for (const p of extPanels) renderExtBody(p);
}

// ---- 形态切换按钮 ----
$('mode-claude').addEventListener('click', () => setMode('claude'));
$('mode-codex').addEventListener('click', () => setMode('codex'));

// ---- 会话行按钮开关：朗读/快速回复默认隐藏（设置弹层里开），标题不再被挤 ----
function applyRowSwitches() {
  $('speak-on').classList.toggle('on', settings.speakBtn);
  $('speak-off').classList.toggle('on', !settings.speakBtn);
  $('reply-on').classList.toggle('on', settings.replyBtn);
  $('reply-off').classList.toggle('on', !settings.replyBtn);
}
$('speak-on').addEventListener('click', () => { settings.speakBtn = true; saveSettings(); applyRowSwitches(); render(); });
$('speak-off').addEventListener('click', () => { settings.speakBtn = false; saveSettings(); applyRowSwitches(); render(); });
$('reply-on').addEventListener('click', () => { settings.replyBtn = true; saveSettings(); applyRowSwitches(); render(); });
$('reply-off').addEventListener('click', () => { settings.replyBtn = false; saveSettings(); applyRowSwitches(); render(); });

$('btn-collapse').addEventListener('click', async () => {
  const collapsed = await window.api.toggleCollapse();
  $('btn-collapse').title = collapsed ? '展开' : '收起';
});
$('btn-pin').addEventListener('click', async () => {
  $('btn-pin').classList.toggle('on', await window.api.togglePin());
});
window.api.isPinned().then((on) => $('btn-pin').classList.toggle('on', on));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (ctxMenuEl) { closeCtxMenu(); return; }                // 先关右键菜单
  if (settingsOpen()) { closeSettings(); return; }          // 先关设置弹层
  if (!$('composer').hidden) { closeComposer(); return; }   // 再关回复框（textarea 里自处理，这里是兜底）
  if (extDetail.size) { extDetail.clear(); renderExtStrips(); return; } // 收起扩展条目详情
  if (sessOpen) {                                           // 再收起会话列表
    sessOpen = false;
    settings.sessStripOpen = false;
    saveSettings();
    renderSessStrip();
    return;
  }
  stop();                                                   // 最后才是停止朗读
});

synth.onvoiceschanged = fillVoices;
window.api.edgeVoices().then((v) => { edgeVoices = v; fillVoices(); });
fillVoices();
applyMode();
applyRowSwitches();
renderSessStrip();
updateSessionNew();
refresh();
setInterval(refresh, 3000);
