const $ = (id) => document.getElementById(id);
const listEl = $('list');
const synth = window.speechSynthesis;
const { sameWs, matchDir } = window.Tabs;

const settings = (() => {
  const defaults = { rate: 1.1, voice: 'edge:zh-CN-XiaoxiaoNeural', mode: 'claude', activeTab: '', todoStripOpen: false, sessStripOpen: true, railOpen: false, speakBtn: false, replyBtn: false, extOpen: {} };
  try {
    const saved = JSON.parse(localStorage.getItem('settings') || '{}');
    return {
      ...defaults,
      rate: saved.rate || defaults.rate,
      voice: saved.voice || defaults.voice,
      mode: saved.mode === 'codex' ? 'codex' : 'claude',
      activeTab: typeof saved.activeTab === 'string' ? saved.activeTab : '',
      todoStripOpen: saved.todoStripOpen === true,
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
  // 会话 ↔ 未完成任务的回显：绑了单的会话行加个「任·」标签
  const todoBySession = new Map();
  for (const t of todoData) {
    if (t.status !== 'open') continue;
    for (const sid of t.sessions || []) if (!todoBySession.has(sid)) todoBySession.set(sid, t);
  }
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
    const bound = todoBySession.get(s.id);
    if (bound) {
      const tt = document.createElement('span');
      tt.className = 'todo-tag';
      tt.textContent = '任·' + bound.title.slice(0, 10) + (bound.title.length > 10 ? '…' : '');
      tt.title = `任务：${bound.title}（点击查看）`;
      tt.addEventListener('click', (e) => { e.stopPropagation(); gotoTodo(bound.id); });
      preview.append(tt);
    }
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
  refreshPlan();
  refreshTodos();
}

// ---- 订阅用量（GLM Coding Plan）：底部一行各重置窗口的已用百分比 ----
// ~/.claude-float/glm.json 配了 apiKey 才显示；主进程 60s 拉一次，这里每轮拿缓存
const PLAN_CONSOLE_URL = 'https://open.bigmodel.cn/console';

function fmtReset(ms) {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// 各重置窗口的短标签：接口不回窗口名，按 nextResetTime 升序排好后对号入座
// （最近的=5 小时窗，其次是周窗）；真出现别的窗口结构，title 里还有完整信息
const WINDOW_LABELS = ['5-hour', 'weekly'];

function renderPlan(u) {
  const box = $('usage');
  if (!u || !u.windows || !u.windows.length) { box.hidden = true; return; }
  box.hidden = false;
  const label = (i) => WINDOW_LABELS[i] || `window ${i + 1}`;
  const short = (i) => (label(i) === '5-hour' ? '5h' : label(i) === 'weekly' ? '周' : label(i));
  box.title = ['GLM 订阅用量（点一下去控制台）',
    ...u.windows.map((w, i) => {
      const left = w.remaining != null ? ` · 剩 ${(w.remaining / 1000).toFixed(1)}k` : '';
      const reset = w.resetAt ? ` · ${fmtReset(w.resetAt)} 重置` : '';
      return `${label(i)}：已用 ${w.pct}%${left}${reset}`;
    }),
  ].join('\n');
  box.replaceChildren(...u.windows.map((w, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'usage-item' + (w.pct >= 80 ? ' hot' : '');
    const name = document.createElement('span');
    name.className = 'usage-name';
    name.textContent = short(i);
    const track = document.createElement('span');
    track.className = 'usage-track';
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(100, Math.max(0, w.pct))}%`;
    track.append(fill);
    const pct = document.createElement('span');
    pct.className = 'usage-pct';
    pct.textContent = `${w.pct}%`;
    b.append(name, track, pct);
    return b;
  }));
}

async function refreshPlan() {
  try {
    renderPlan(await window.api.planUsage());
  } catch { /* 拉不到就藏起来 */ }
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
$('usage').addEventListener('click', () => { window.open(PLAN_CONSOLE_URL); }); // 主进程转系统浏览器

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
let stripOpen = settings.todoStripOpen; // 任务区展开态
let sessOpen = settings.sessStripOpen; // 会话区展开态（默认展开）

const tabOf = (dir) => matchDir(dir, quickDirList) || OTHER_TAB;
const activeDir = () => quickDirList.find((d) => d.path === activeTab) || null;
const activeTabName = () => {
  const d = activeDir();
  return d ? d.name : '其他';
};

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
const openCountByTab = () => {
  const m = new Map();
  for (const t of todoData) {
    if (t.status !== 'open') continue;
    const key = tabOf(t.ws);
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
};

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
  const counts = openCountByTab();
  $('dir-rail').replaceChildren(railFoldBtn, ...dirEntries().map((t) => {
    const btn = el('button', 'dir-item' + (t.key === activeTab ? ' on' : ''));
    btn.type = 'button';
    btn.dataset.key = t.key;
    btn.title = t.key === OTHER_TAB ? '没归到启动目录里的会话和任务' : t.key;
    btn.append(el('span', 'dir-item-glyph', (t.name || '?')[0]));
    btn.append(el('span', 'dir-item-name', t.name));
    const n = counts.get(t.key) || 0;
    const cnt = el('i', 'dir-item-count', n > 9 ? '9+' : String(n));
    cnt.hidden = n === 0;
    btn.append(cnt);
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

// 3s 轮询的轻量刷新：只改目录项上的角标
function updateDirRailCounts() {
  const counts = openCountByTab();
  for (const btn of $('dir-rail').children) {
    if (!btn.dataset.key) continue;
    const cnt = btn.querySelector('.dir-item-count');
    const n = counts.get(btn.dataset.key) || 0;
    cnt.hidden = n === 0;
    cnt.textContent = n > 9 ? '9+' : String(n);
  }
}

function setActiveTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;
  settings.activeTab = tab;
  saveSettings();
  todoExpanded = null;
  todoPicking = null;
  markActiveDirRail();
  renderStrip();
  updateSessionNew();
  render();
  if (stripOpen) renderTodos();
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
  renderStrip();
  renderSessStrip();
  updateSessionNew();
  render();
  if (stripOpen) renderTodos();
  refreshExts();
}).catch(() => {
  restoreActiveTab();
  renderDirRail();
  renderStrip();
  renderSessStrip();
  updateSessionNew();
});

// ---- 任务单：按工作区管事，起会话自动挂单（数据在 ~/.claude-float/todos.json） ----
// 任务区在每个 Tab 头部（默认收起），只显示当前目录的任务。
// 浮窗对任务是只读的：创建/更新内容/记进度/完成/删除都由会话经 MCP 工具（todos_*）操作，
// 这样长任务分多个会话推进也不丢进度；浮窗上能动的只有「绑哪个会话」这一层。
let todoData = [];
let todoStatus = 'open'; // 'open' | 'done'
let todoExpanded = null; // 展开详情的任务 id
let todoPicking = null;  // 正在挑会话绑定的任务 id
let todoFlash = null;    // { id, until } 从会话行标签跳过来时高亮一下

function wsName(ws) {
  const d = quickDirList.find((x) => x.path === ws);
  if (d) return d.name;
  return String(ws || '').split(/[\\/]/).filter(Boolean).pop() || '(无工作区)';
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const UNBIND_ICON = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const TODO_EMPTY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 4h6V2H9v2zM7 4H5.5A1.5 1.5 0 0 0 4 5.5v15A1.5 1.5 0 0 0 5.5 22h13a1.5 1.5 0 0 0 1.5-1.5v-15A1.5 1.5 0 0 0 18.5 4H17"/><path d="M8.5 13l2.5 2.5L16 10.5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---- 通用右键菜单（自绘，跟浮窗同一套主题变量；先用在任务行上） ----
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

// 任务行的右键菜单：内容层面的增删改都在会话里做（MCP 工具），这里只留浮窗能动的
function openTodoMenu(t, x, y) {
  const items = [];
  if (t.status === 'open') {
    items.push({ label: '▶ 起会话并接手', onClick: async () => {
      closeCtxMenu();
      try {
        const res = await window.api.todosSpawn(t.id);
        flash(res.ok ? (res.trine ? '已打开 trine；在那里新建会话（选任务的工作区目录），上线后自动挂单' : '已起会话，会话上线后自动挂单') : (res.message || '启动失败'));
      } catch (err) { flash(`启动失败：${String(err.message || err)}`); }
    } });
  }
  items.push({ label: '⧉ 复制标题', onClick: () => { closeCtxMenu(); copyText(t.title, '标题已复制'); } });
  if (t.desc) items.push({ label: '⧉ 复制内容', onClick: () => { closeCtxMenu(); copyText(t.desc, '内容已复制'); } });
  if (t.goal) items.push({ label: '⧉ 复制目标', onClick: () => { closeCtxMenu(); copyText(t.goal, '目标已复制'); } });
  if (t.ws && quickDirList.some((d) => d.path === t.ws)) {
    items.push({ label: '📂 打开工作区目录', onClick: () => { closeCtxMenu(); window.api.openPath(t.ws).catch(() => flash('打开失败')); } });
  }
  showCtxMenu(x, y, items);
}

// 会话行的右键菜单：朗读/快速回复不再依赖行上按钮开关（默认藏着，这里常驻），另挂复制/开目录/起新会话/挂任务
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
  // 挂到同目录未完成的任务：补上「会话→任务」方向（之前只能从任务那边挑会话绑）
  const cands = todoData.filter((t) => t.status === 'open' && sameWs(t.ws, s.cwd) && !(t.sessions || []).includes(s.id));
  if (cands.length) {
    items.push('sep');
    for (const t of cands.slice(0, 4)) {
      const short = t.title.length > 10 ? t.title.slice(0, 10) + '…' : t.title;
      items.push({ label: '📌 挂任务：' + short, onClick: async () => {
        closeCtxMenu();
        try {
          await window.api.todosBind(t.id, s.id);
          flash('会话已挂到任务');
          refreshTodos();
        } catch (err) { flash(`挂任务失败：${String(err.message || err)}`); }
      } });
    }
    if (cands.length > 4) items.push({ label: `…还有 ${cands.length - 4} 张，去任务区挂`, disabled: true, onClick: () => {} });
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

function todoEmptyBox(text) {
  const d = el('div', 'todo-empty');
  d.innerHTML = TODO_EMPTY_ICON;
  d.append(el('span', null, text));
  return d;
}

async function refreshTodos() {
  try {
    todoData = await window.api.todosList();
  } catch { return; }
  updateStripCounts();
  if (stripOpen) renderTodos();
}

// 3s 轮询的轻量刷新：只更新收起行和目录栏角标上的计数，不重建列表
function updateStripCounts() {
  renderStrip();
  updateDirRailCounts();
}

function renderStrip() {
  $('strip-caret').classList.toggle('open', stripOpen);
  $('strip-body').hidden = !stripOpen;
  const n = todoData.filter((t) => t.status === 'open' && tabOf(t.ws) === activeTab).length;
  $('strip-count').hidden = n === 0;
  $('strip-count').textContent = String(n);
}

// 会话区收放行：跟任务区同款（caret + 标题 + 计数），列表整体显隐
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

// 绑定的会话挑个活状态透传：进行中 > 等待回复
function todoLive(t) {
  const bound = (t.sessions || []).map((id) => sessions.find((s) => s.id === id)).filter(Boolean);
  if (bound.some((s) => s.status === 'working')) return { bound, chip: ['进行中', 'working'] };
  if (bound.some((s) => s.status === 'waiting')) return { bound, chip: ['等待回复', 'waiting'] };
  return { bound, chip: null };
}

function sessChip(status) {
  if (status === 'working') return el('span', 'chip working', '进行中');
  if (status === 'waiting') return el('span', 'chip waiting', '等待回复');
  return null;
}

function visibleTodos() {
  const status = todoStatus === 'done' ? 'done' : 'open';
  return todoData
    .filter((t) => t.status === status && tabOf(t.ws) === activeTab)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// 任务行的进度条 + 百分比（pct 没设过就不显示）
function todoBarRow(t) {
  if (t.pct === undefined || t.pct === null) return null;
  const row = el('div', 'todo-bar-row');
  const bar = el('span', 'todo-bar');
  const fill = el('i');
  fill.style.width = `${Math.min(100, Math.max(0, t.pct))}%`;
  bar.append(fill);
  row.append(bar, el('span', 'todo-pct', `${t.pct}%`));
  return row;
}

function todoRow(t) {
  const li = el('li', 'todo-item'
    + (t.status === 'done' ? ' done' : '')
    + (todoFlash && todoFlash.id === t.id && Date.now() < todoFlash.until ? ' flash' : ''));

  // 完成/重开只由会话经 MCP 工具操作，这里只是状态圆点
  const dot = el('span', 'todo-dot');
  dot.title = t.status === 'done' ? '已完成（会话里 todos_toggle 可重开）' : '未完成';
  dot.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
  li.append(dot);

  const main = el('div', 'todo-main');
  const top = el('div', 'todo-top');
  top.append(el('div', 'todo-title', t.title));
  top.append(el('span', 'todo-time', ago(t.status === 'done' ? (t.doneAt || t.createdAt) : t.createdAt)));
  main.append(top);

  const meta = el('div', 'todo-meta');
  meta.append(el('span', 'todo-ws', wsName(t.ws)));
  if ((t.sessions || []).length) meta.append(el('span', null, `💬${t.sessions.length}`));
  const { bound, chip } = todoLive(t);
  if (chip) meta.append(el('span', 'chip ' + chip[1], chip[0]));
  main.append(meta);

  const bar = todoBarRow(t);
  if (bar) main.append(bar);
  const last = (t.progressLog || [])[((t.progressLog || []).length - 1)];
  if (last) {
    const pv = el('div', 'todo-desc todo-last');
    pv.textContent = last.text;
    pv.title = `最新进度（${ago(last.at)}）：${last.text}`;
    main.append(pv);
  }

  if (todoExpanded === t.id) main.append(todoDetail(t, bound));
  li.append(main);

  li.addEventListener('click', () => {
    todoExpanded = todoExpanded === t.id ? null : t.id;
    todoPicking = null;
    renderTodos();
  });
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openTodoMenu(t, e.clientX, e.clientY);
  });
  return li;
}

// 详情展开区：内容/目标/进度时间线 + 绑定会话 + 起会话接手。
// 标题内容目标进度都在会话里改（todos_update），浮窗上没有任何编辑控件
function todoDetail(t, bound) {
  const box = el('div', 'todo-detail');
  if (t.desc) {
    const f = el('div', 'todo-field');
    f.append(el('span', 'lbl', '内容'), el('span', 'val', t.desc));
    box.append(f);
  }
  if (t.goal) {
    const f = el('div', 'todo-field');
    f.append(el('span', 'lbl', '目标'), el('span', 'val', t.goal));
    box.append(f);
  }

  const log = t.progressLog || [];
  if (log.length) {
    const prog = el('div', 'todo-prog');
    prog.append(el('span', 'lbl', '进度'));
    for (const p of log.slice(-5).reverse()) {
      const item = el('div', 'todo-prog-item');
      item.append(el('span', 'at', ago(p.at)), el('span', 'tx', p.text));
      prog.append(item);
    }
    if (log.length > 5) prog.append(el('div', 'todo-prog-more', `…更早还有 ${log.length - 5} 条`));
    box.append(prog);
  }

  for (const s of bound) {
    const row = el('div', 'todo-sess-row');
    row.append(el('span', 'name', s.title));
    const c = sessChip(s.status);
    if (c) row.append(c);
    const un = el('button', 'unbind');
    un.type = 'button';
    un.title = '解绑这个会话';
    un.innerHTML = UNBIND_ICON;
    un.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.todosUnbind(t.id, s.id);
      refreshTodos();
    });
    row.append(un);
    box.append(row);
  }

  if (todoPicking === t.id) {
    const pick = el('div', 'todo-pick');
    pick.addEventListener('click', (e) => e.stopPropagation());
    const cands = sessions.filter((s) => sameWs(s.cwd, t.ws) && !(t.sessions || []).includes(s.id)).slice(0, 6);
    pick.append(el('div', 'hint', cands.length ? '点一个会话挂上来：' : '这个工作区最近没有可绑的会话'));
    for (const s of cands) {
      const c = el('button', 'cand', s.title);
      c.type = 'button';
      c.title = s.preview || s.title;
      c.addEventListener('click', async () => {
        await window.api.todosBind(t.id, s.id);
        todoPicking = null;
        flash('已挂上会话');
        refreshTodos();
      });
      pick.append(c);
    }
    box.append(pick);
  }

  const actions = el('div', 'todo-actions');
  if (t.status === 'open') {
    const go = el('button', 'todo-launch', '▶ 起会话并接手');
    go.type = 'button';
    go.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const res = await window.api.todosSpawn(t.id);
        flash(res.ok ? (res.trine ? '已打开 trine；在那里新建会话（选任务的工作区目录），上线后自动挂单' : '已起会话，会话上线后自动挂单') : (res.message || '启动失败'));
      } catch (err) { flash(`启动失败：${String(err.message || err)}`); }
    });
    actions.append(go);
  }
  const bindBtn = el('button', 'todo-act', '+ 绑定会话');
  bindBtn.type = 'button';
  bindBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    todoPicking = todoPicking === t.id ? null : t.id;
    renderTodos();
  });
  actions.append(bindBtn);
  box.append(actions);
  return box;
}

function renderTodos() {
  $('todo-tab-open').classList.toggle('on', todoStatus !== 'done');
  $('todo-tab-done').classList.toggle('on', todoStatus === 'done');
  const items = visibleTodos();
  const list = $('todo-list');
  if (!items.length) {
    list.replaceChildren(todoEmptyBox(todoStatus === 'done'
      ? '没有已完成的任务'
      : `「${activeTabName()}」还没有未完成的任务（让会话里的 ${modeInfo().agent} 调 todos_add 建一个）`));
    return;
  }
  list.replaceChildren(...items.map(todoRow));
}

// 会话行上的「任·」标签点进来：跳到那个任务的 Tab，展开任务区并高亮
function gotoTodo(id) {
  const t = todoData.find((x) => x.id === id);
  if (!t) return;
  setActiveTab(tabOf(t.ws));
  stripOpen = true;
  settings.todoStripOpen = true;
  saveSettings();
  todoStatus = t.status;
  todoExpanded = t.id;
  todoPicking = null;
  todoFlash = { id: t.id, until: Date.now() + 2500 };
  renderStrip();
  renderTodos();
  setTimeout(() => { todoFlash = null; if (stripOpen) renderTodos(); }, 2600);
}

// 任务区收起/展开（状态记住，重启还原）
$('strip-toggle').addEventListener('click', () => {
  stripOpen = !stripOpen;
  settings.todoStripOpen = stripOpen;
  saveSettings();
  renderStrip();
  if (stripOpen) renderTodos();
});
// 会话区收起/展开（同款收放行，状态记住；默认展开）
$('sess-toggle').addEventListener('click', () => {
  sessOpen = !sessOpen;
  settings.sessStripOpen = sessOpen;
  saveSettings();
  renderSessStrip();
});
$('todo-tab-open').addEventListener('click', () => { todoStatus = 'open'; renderTodos(); });
$('todo-tab-done').addEventListener('click', () => { todoStatus = 'done'; renderTodos(); });
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
  if (todoPicking) { todoPicking = null; renderTodos(); return; } // 取消挑会话
  if (todoExpanded) { todoExpanded = null; renderTodos(); return; } // 收起任务详情
  if (extDetail.size) { extDetail.clear(); renderExtStrips(); return; } // 收起扩展条目详情
  if (stripOpen) {                                          // 收起任务区（也算一次显式收起，记住状态）
    stripOpen = false;
    settings.todoStripOpen = false;
    saveSettings();
    renderStrip();
    return;
  }
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
renderStrip();
renderSessStrip();
updateSessionNew();
refresh();
setInterval(refresh, 3000);
