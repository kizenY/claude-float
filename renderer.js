const $ = (id) => document.getElementById(id);
const listEl = $('list');
const synth = window.speechSynthesis;

const settings = (() => {
  const defaults = { rate: 1.1, voice: 'edge:zh-CN-XiaoxiaoNeural', mode: 'claude' };
  try {
    const saved = JSON.parse(localStorage.getItem('settings') || '{}');
    return {
      ...defaults,
      rate: saved.rate || defaults.rate,
      voice: saved.voice || defaults.voice,
      mode: saved.mode === 'codex' ? 'codex' : 'claude',
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
  renderQuickDirs(quickDirList);
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
  $('empty').hidden = todoPanelOn() || sessions.length > 0;
  $('empty').textContent = mode === 'codex'
    ? '还没有找到 Codex 会话记录（在终端跑一次 codex 就有了）'
    : '还没有找到会话记录';
  // 会话 ↔ 未完成代办的回显：绑了单的会话行加个「单·」标签
  const todoBySession = new Map();
  for (const t of todoData) {
    if (t.status !== 'open') continue;
    for (const sid of t.sessions || []) if (!todoBySession.has(sid)) todoBySession.set(sid, t);
  }
  listEl.replaceChildren(...sessions.map((s) => {
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
    const speaking = s.id === speakingId;
    meta.append(rowButton(speaking ? STOP_ICON : SPEAK_ICON, speaking ? '停止朗读' : '朗读最新回复', () => toggleSpeak(s)));
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

    const preview = document.createElement('div');
    preview.className = 'preview';
    if (s.project) {
      const tag = document.createElement('span');
      tag.className = 'project';
      tag.textContent = s.project;
      preview.append(tag);
    }
    const bound = todoBySession.get(s.id);
    if (bound) {
      const tt = document.createElement('span');
      tt.className = 'todo-tag';
      tt.textContent = '单·' + bound.title.slice(0, 10) + (bound.title.length > 10 ? '…' : '');
      tt.title = `代办：${bound.title}（点击查看）`;
      tt.addEventListener('click', (e) => { e.stopPropagation(); openTodos(bound.id); });
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
    const fresh = await window.api.list(20, mode);
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
  const el = $('plan');
  if (!u || !u.windows || !u.windows.length) { el.hidden = true; return; }
  el.hidden = false;
  const label = (i) => WINDOW_LABELS[i] || `window ${i + 1}`;
  el.textContent = u.windows
    .map((w, i) => `${label(i)} ${w.pct}%${w.resetAt ? ` · ${fmtReset(w.resetAt)} 重置` : ''}`)
    .join('  ·  ');
  el.title = ['GLM 订阅用量',
    ...u.windows.map((w, i) => {
      const left = w.remaining != null ? ` · 剩 ${(w.remaining / 1000).toFixed(1)}k` : '';
      const reset = w.resetAt ? ` · ${fmtReset(w.resetAt)} 重置` : '';
      return `${label(i)}：已用 ${w.pct}%${left}${reset}`;
    }),
  ].join('\n');
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
$('plan').addEventListener('click', () => { window.open(PLAN_CONSOLE_URL); }); // 主进程转系统浏览器

// ---- 快捷启动：一键在常用目录起一个会话（Claude 形态走 cf，Codex 形态走 codex） ----
// 左键弹菜单：新会话 / 新建代办 / 这个工作区的未完成单（点单 = 起会话并挂单）
let quickDirList = [];
function renderQuickDirs(dirs) {
  $('launch').replaceChildren(...dirs.map((d) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `+ ${d.name}`;
    btn.title = `点一下选：新会话 / 新建代办 / 挂单起会话（${d.path}）`;
    btn.addEventListener('click', async () => {
      try {
        await window.api.launchMenu(d.path, mode);
      } catch (e) {
        flash(`启动失败：${String(e.message || e)}`);
      }
    });
    return btn;
  }));
}
window.api.quickDirs().then((dirs) => { quickDirList = dirs; renderQuickDirs(dirs); }).catch(() => {});

// ---- 代办单：按工作区管事，起会话自动挂单（数据在 ~/.claude-float/todos.json） ----
let todoData = [];
let todoFilter = { ws: null, status: 'open' }; // ws=null 看全部
let todoExpanded = null; // 展开详情的单 id
let todoPicking = null;  // 正在挑会话绑定的单 id
let deleteArm = null;    // { id, until } 删除按钮的两步确认状态
let todoFlash = null;    // { id, until } 从会话行标签跳过来时高亮一下

const todoPanelOn = () => !$('todos').hidden;

// renderer 里没有 path 模块，手动归一（斜杠/大小写/尾斜杠）
function sameWs(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

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

async function refreshTodos() {
  try {
    todoData = await window.api.todosList();
  } catch { return; }
  renderTodoBadge();
  if (todoPanelOn()) renderTodos();
}

function renderTodoBadge() {
  const n = todoData.filter((t) => t.status === 'open').length;
  const b = $('todo-badge');
  b.hidden = n === 0;
  b.textContent = n > 9 ? '9+' : String(n);
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

function renderTodoFilters() {
  const open = todoData.filter((t) => t.status === 'open');
  const chips = [
    { path: null, name: '全部', count: open.length },
    ...quickDirList.map((d) => ({ path: d.path, name: d.name, count: open.filter((t) => sameWs(t.ws, d.path)).length })),
  ];
  $('todo-filters').replaceChildren(...chips.map((c) => {
    const btn = el('button', 'todo-chip' + ((c.path === null && todoFilter.ws === null) || sameWs(todoFilter.ws, c.path) ? ' on' : ''),
      `${c.name}${c.count ? ` ${c.count}` : ''}`);
    btn.type = 'button';
    btn.title = c.path ? `只看 ${c.name} 的代办` : '看所有工作区的代办';
    btn.addEventListener('click', () => { todoFilter.ws = c.path; renderTodos(); });
    return btn;
  }));
}

function visibleTodos() {
  const status = todoFilter.status === 'done' ? 'done' : 'open';
  return todoData
    .filter((t) => t.status === status && (!todoFilter.ws || sameWs(t.ws, todoFilter.ws)))
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
          if (todoPanelOn()) renderTodos();
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
  if (!todoPanelOn()) return;
  $('todo-tab-open').classList.toggle('on', todoFilter.status !== 'done');
  $('todo-tab-done').classList.toggle('on', todoFilter.status === 'done');
  renderTodoFilters();
  const items = visibleTodos();
  const list = $('todo-list');
  if (!items.length) {
    list.replaceChildren(el('div', 'todo-empty', todoFilter.status === 'done'
      ? '没有已完成的代办'
      : (todoFilter.ws ? `「${wsName(todoFilter.ws)}」还没有未完成的代办` : '还没有代办，点右上「＋ 新建」建一张')));
    return;
  }
  if (todoFilter.ws) {
    list.replaceChildren(...items.map(todoRow));
    return;
  }
  // 「全部」视图：按 quick-dirs 顺序分组，不在启动目录里的单归「其他」
  const groups = quickDirList.map((d) => ({ name: d.name, items: items.filter((t) => sameWs(t.ws, d.path)) }));
  const rest = items.filter((t) => !quickDirList.some((d) => sameWs(t.ws, d.path)));
  if (rest.length) groups.push({ name: '其他', items: rest });
  const out = [];
  for (const g of groups) {
    if (!g.items.length) continue;
    out.push(el('div', 'todo-group', g.name));
    out.push(...g.items.map(todoRow));
  }
  list.replaceChildren(...out);
}

async function openTodos(highlightId) {
  closeTodoForm();
  $('todos').hidden = false;
  $('list').hidden = true;
  $('btn-todos').classList.add('on');
  if (highlightId) {
    const t = todoData.find((x) => x.id === highlightId);
    if (t) {
      todoFilter = { ws: t.ws, status: t.status };
      todoExpanded = t.id;
      todoFlash = { id: t.id, until: Date.now() + 2500 };
      setTimeout(() => { todoFlash = null; if (todoPanelOn()) renderTodos(); }, 2600);
    }
  }
  renderTodos();
  render(); // 同步会话列表的隐藏/空态
}

function closeTodos() {
  closeTodoForm();
  $('todos').hidden = true;
  $('list').hidden = false;
  $('btn-todos').classList.remove('on');
  render();
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
  fillTodoWs(preselectWs);
  $('todo-view').hidden = true;
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
  $('todo-view').hidden = false;
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
    todoFilter = { ws, status: 'open' };
    closeTodoForm();
    flash('代办已创建');
    refreshTodos();
  } catch (err) {
    flash(`创建失败：${String(err.message || err)}`);
  }
});
$('todo-form-close').addEventListener('click', closeTodoForm);
$('todo-cancel').addEventListener('click', closeTodoForm);

$('btn-todos').addEventListener('click', () => (todoPanelOn() ? closeTodos() : openTodos()));
$('todo-close').addEventListener('click', closeTodos);
$('todo-new').addEventListener('click', () => openTodoForm(todoFilter.ws));
$('todo-tab-open').addEventListener('click', () => { todoFilter.status = 'open'; renderTodos(); });
$('todo-tab-done').addEventListener('click', () => { todoFilter.status = 'done'; renderTodos(); });
// 启动条菜单里点「新建代办…」：打开面板直进表单，工作区已预选
window.api.onTodosNew(({ ws }) => { openTodos(); openTodoForm(ws); });

// ---- 形态切换按钮 ----
$('mode-claude').addEventListener('click', () => setMode('claude'));
$('mode-codex').addEventListener('click', () => setMode('codex'));

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
  if (!$('todo-form').hidden) { closeTodoForm(); return; } // 先关表单
  if (todoPanelOn()) { closeTodos(); return; }             // 再关代办面板
  stop();                                                  // 最后才是停止朗读
});

synth.onvoiceschanged = fillVoices;
window.api.edgeVoices().then((v) => { edgeVoices = v; fillVoices(); });
fillVoices();
applyMode();
refresh();
setInterval(refresh, 3000);
