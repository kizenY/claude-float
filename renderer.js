const $ = (id) => document.getElementById(id);
const listEl = $('list');
const synth = window.speechSynthesis;
const { sameWs, matchDir } = window.Tabs;

const settings = (() => {
  const defaults = { rate: 1.1, voice: 'edge:zh-CN-XiaoxiaoNeural', mode: 'claude', activeTab: '', todoStripOpen: false, railOpen: false, speakBtn: false, replyBtn: false };
  try {
    const saved = JSON.parse(localStorage.getItem('settings') || '{}');
    return {
      ...defaults,
      rate: saved.rate || defaults.rate,
      voice: saved.voice || defaults.voice,
      mode: saved.mode === 'codex' ? 'codex' : 'claude',
      activeTab: typeof saved.activeTab === 'string' ? saved.activeTab : '',
      todoStripOpen: saved.todoStripOpen === true,
      railOpen: saved.railOpen === true,
      speakBtn: saved.speakBtn === true,
      replyBtn: saved.replyBtn === true,
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
  $('empty').hidden = shown.length > 0;
  $('empty-text').textContent = activeTab === OTHER_TAB
    ? (mode === 'codex' ? '没有归类到启动目录的 Codex 会话' : '没有归类到启动目录的会话')
    : (mode === 'codex'
      ? '这个目录还没有 Codex 会话记录（在终端跑一次 codex 就有了）'
      : '这个目录还没有会话记录');
  // 会话 ↔ 未完成代办的回显：绑了单的会话行加个「单·」标签
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
      const replyOffHint = mode === 'codex'
        ? '这个 Codex 会话没在终端里跑，点列表行恢复后再回'
        : '这个会话已经结束了，没法直接回复';
      const replyBtn = rowButton(REPLY_ICON, s.channel || s.pid ? '快速回复' : replyOffHint, () => {
        if (s.channel || s.pid) openComposer(s);
        else flash('会话已经结束，没法回复');
      });
      replyBtn.classList.add('reply-btn');
      if (!s.channel && !s.pid) replyBtn.classList.add('off');
      meta.append(replyBtn);
    }

    const preview = document.createElement('div');
    preview.className = 'preview';
    const bound = todoBySession.get(s.id);
    if (bound) {
      const tt = document.createElement('span');
      tt.className = 'todo-tag';
      tt.textContent = '单·' + bound.title.slice(0, 10) + (bound.title.length > 10 ? '…' : '');
      tt.title = `代办：${bound.title}（点击查看）`;
      tt.addEventListener('click', (e) => { e.stopPropagation(); gotoTodo(bound.id); });
      preview.append(tt);
    }
    preview.append(s.preview || (s.channel ? '新会话，可以直接从这里发第一条消息' : ''));

    li.append(title, meta, preview);
    li.addEventListener('click', () => focusSession(s));
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

// 点列表项：有窗口就切到会话的终端前台/后台；会话已结束则新开终端恢复它（快捷回复走 ↩ 按钮，不走这里）
async function focusSession(s) {
  try {
    const res = await window.api.focus(s.id, mode);
    if (!res.ok) flash(res.message || '没找到会话的窗口');
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

async function openComposer(s) {
  closeSettings();
  replyTo = s;
  $('composer').hidden = false;
  $('composer-title').textContent = s.title;
  setComposerStatus(s.status === 'working' ? `${modeInfo().agent} 还在干活，消息会排队` : '');
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

// ---- 目录侧栏：quick-dirs 生成 + 末尾「其他」兜底，会话和代办跟着目录过滤 ----
const OTHER_TAB = 'other';
let quickDirList = [];
let activeTab = settings.activeTab;     // 目录 path（quick-dirs 原样字符串）或 'other'
let stripOpen = settings.todoStripOpen; // 代办区展开态

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
    btn.title = t.key === OTHER_TAB ? '没归到启动目录里的会话和代办' : t.key;
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
  if (!$('todo-form').hidden) closeTodoForm(); // 表单开着换 Tab，先收掉别错位
  todoExpanded = null;
  todoPicking = null;
  markActiveDirRail();
  renderStrip();
  updateSessionNew();
  render();
  if (stripOpen) renderTodos();
}

// 会话区的「＋ 在这个目录起新会话」；「其他」Tab 没有可启动的目录，不显示
function updateSessionNew() {
  const dir = activeDir();
  const btn = $('session-new');
  btn.hidden = !dir;
  if (dir) btn.textContent = `＋ 在 ${dir.name} 起新会话`;
}

window.api.quickDirs().then((dirs) => {
  quickDirList = dirs;
  restoreActiveTab();
  renderDirRail();
  renderStrip();
  updateSessionNew();
  render();
  if (stripOpen) renderTodos();
}).catch(() => {
  restoreActiveTab();
  renderDirRail();
  renderStrip();
  updateSessionNew();
});

// ---- 代办单：按工作区管事，起会话自动挂单（数据在 ~/.claude-float/todos.json） ----
// 代办区在每个 Tab 头部（默认收起），只显示当前目录的单
let todoData = [];
let todoStatus = 'open'; // 'open' | 'done'
let todoExpanded = null; // 展开详情的单 id
let todoPicking = null;  // 正在挑会话绑定的单 id
let deleteArm = null;    // { id, until } 删除按钮的两步确认状态
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

function todoRow(t) {
  const li = el('li', 'todo-item'
    + (t.status === 'done' ? ' done' : '')
    + (todoFlash && todoFlash.id === t.id && Date.now() < todoFlash.until ? ' flash' : ''));

  const check = el('button', 'todo-check');
  check.type = 'button';
  check.title = t.status === 'open' ? '标记完成' : '重新打开';
  check.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
  check.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await window.api.todosToggle(t.id);
      flash(t.status === 'open' ? '已完成 ✔' : '已重新打开');
      refreshTodos();
    } catch (err) { flash(`操作失败：${String(err.message || err)}`); }
  });
  li.append(check);

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

  if (todoExpanded === t.id) main.append(todoDetail(t, bound));
  li.append(main);

  li.addEventListener('click', () => {
    todoExpanded = todoExpanded === t.id ? null : t.id;
    todoPicking = null;
    renderTodos();
  });
  return li;
}

function todoDetail(t, bound) {
  const box = el('div', 'todo-detail');
  if (t.desc) box.append(el('div', 'todo-desc', t.desc));

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
    const go = el('button', 'todo-launch', '▶ 起会话并挂单');
    go.type = 'button';
    go.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const res = await window.api.todosSpawn(t.id);
        flash(res.ok ? '已起会话，会话上线后自动挂单' : (res.message || '启动失败'));
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

  // 两步删除：点一下变红「确认删除」，3 秒内再点才真删
  const armed = deleteArm && deleteArm.id === t.id && Date.now() < deleteArm.until;
  const del = el('button', 'todo-act' + (armed ? ' danger' : ''), armed ? '确认删除' : '删除');
  del.type = 'button';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!armed) {
      deleteArm = { id: t.id, until: Date.now() + 3000 };
      renderTodos();
      setTimeout(() => {
        if (deleteArm && Date.now() >= deleteArm.until) {
          deleteArm = null;
          if (stripOpen) renderTodos();
        }
      }, 3100);
      return;
    }
    deleteArm = null;
    try {
      await window.api.todosDelete(t.id);
      if (todoExpanded === t.id) todoExpanded = null;
      flash('已删除');
      refreshTodos();
    } catch (err) { flash(`删除失败：${String(err.message || err)}`); }
  });
  actions.append(del);
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
      ? '没有已完成的代办'
      : `「${activeTabName()}」还没有未完成的代办`));
    return;
  }
  list.replaceChildren(...items.map(todoRow));
}

// 会话行上的「单·」标签点进来：跳到那张单的 Tab，展开代办区并高亮
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

// ---- 新建代办表单（可聚焦套路和快速回复一致：打开时临时 setFocusable(true)） ----
function fillTodoWs(preselect) {
  const sel = $('todo-ws');
  sel.replaceChildren(...quickDirList.map((d) => {
    const o = document.createElement('option');
    o.value = d.path;
    o.textContent = d.name;
    return o;
  }));
  if (preselect && quickDirList.some((d) => d.path === preselect)) sel.value = preselect;
  else if (quickDirList.length) sel.selectedIndex = 0;
}

async function openTodoForm(preselectWs) {
  closeSettings();
  fillTodoWs(preselectWs);
  $('dir-body').hidden = true;
  $('todo-form').hidden = false;
  $('todo-title').value = '';
  $('todo-desc').value = '';
  updateTodoSubmit();
  await window.api.setFocusable(true);
  $('todo-title').focus();
}

function closeTodoForm() {
  if ($('todo-form').hidden) return;
  $('todo-form').hidden = true;
  $('dir-body').hidden = false;
  window.api.setFocusable(false);
  renderTodos();
}

function updateTodoSubmit() {
  $('todo-submit').disabled = !$('todo-title').value.trim();
}

$('todo-title').addEventListener('input', updateTodoSubmit);
$('todo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('todo-title').value.trim();
  const ws = $('todo-ws').value;
  if (!title || !ws || !quickDirList.some((d) => d.path === ws)) return;
  try {
    await window.api.todosCreate({ title, desc: $('todo-desc').value.trim(), ws });
    todoStatus = 'open';
    closeTodoForm();
    flash('代办已创建');
    // 跳到这张单的工作区 Tab 并展开代办区，能看到刚建的单
    setActiveTab(tabOf(ws));
    stripOpen = true;
    settings.todoStripOpen = true;
    saveSettings();
    renderStrip();
    renderTodos();
    refreshTodos();
  } catch (err) {
    flash(`创建失败：${String(err.message || err)}`);
  }
});
$('todo-form-close').addEventListener('click', closeTodoForm);
$('todo-cancel').addEventListener('click', closeTodoForm);

// 代办区收起/展开（状态记住，重启还原）
$('strip-toggle').addEventListener('click', () => {
  stripOpen = !stripOpen;
  settings.todoStripOpen = stripOpen;
  saveSettings();
  renderStrip();
  if (stripOpen) renderTodos();
});
// 代办区的 ＋：工作区预填当前 Tab（「其他」没有对应目录，交给表单默认第一项）
$('todo-new').addEventListener('click', () => openTodoForm(activeTab === OTHER_TAB ? undefined : activeTab));
$('todo-tab-open').addEventListener('click', () => { todoStatus = 'open'; renderTodos(); });
$('todo-tab-done').addEventListener('click', () => { todoStatus = 'done'; renderTodos(); });
// 会话区的 ＋：在当前目录起一个新会话（Claude 形态走 cf，Codex 形态走 codex）
$('session-new').addEventListener('click', async () => {
  const dir = activeDir();
  if (!dir) return;
  try {
    await window.api.spawn(dir.path, mode);
    flash(`已在 ${dir.name} 起新会话`);
  } catch (e) {
    flash(`启动失败：${String(e.message || e)}`);
  }
});

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
  if (settingsOpen()) { closeSettings(); return; }          // 先关设置弹层
  if (!$('todo-form').hidden) { closeTodoForm(); return; }  // 再关表单
  if (!$('composer').hidden) { closeComposer(); return; }   // 再关回复框（textarea 里自处理，这里是兜底）
  if (deleteArm) { deleteArm = null; renderTodos(); return; } // 解除删除布防
  if (todoPicking) { todoPicking = null; renderTodos(); return; } // 取消挑会话
  if (todoExpanded) { todoExpanded = null; renderTodos(); return; } // 收起代办详情
  if (stripOpen) {                                          // 收起代办区（也算一次显式收起，记住状态）
    stripOpen = false;
    settings.todoStripOpen = false;
    saveSettings();
    renderStrip();
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
updateSessionNew();
refresh();
setInterval(refresh, 3000);
