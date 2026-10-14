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

// 行尾 usage 统计：高低档请求数（jev 分流口径）+ 当前上下文占用条（200k 窗口，>80% 变红提醒该 /compact 了）
const CONTEXT_WINDOW = 200000;
function renderStats(s) {
  const stat = document.createElement('span');
  stat.className = 'stat';
  const { ctx, hi, lo } = s.stats || {};
  if (hi + lo > 0) {
    const tiers = document.createElement('span');
    tiers.className = 'tiers';
    tiers.textContent = [hi ? `高${hi}` : '', lo ? `低${lo}` : ''].filter(Boolean).join('/');
    tiers.title = `按上游实际模型统计的高/低档请求数（opus·glm-strong=高，haiku·glm-flash=低）`;
    stat.append(tiers);
  }
  if (ctx) {
    const pct = Math.min(100, Math.round(ctx / CONTEXT_WINDOW * 100));
    const bar = document.createElement('span');
    bar.className = 'ctx' + (pct >= 80 ? ' hot' : '');
    bar.innerHTML = `<i style="width:${pct}%"></i>`;
    bar.title = `上下文约 ${Math.round(ctx / 1000)}k / ${CONTEXT_WINDOW / 1000}k tokens（${pct}%）`;
    stat.append(bar);
  }
  return stat;
}

function render() {
  $('empty').hidden = sessions.length > 0;
  $('empty').textContent = mode === 'codex'
    ? '还没有找到 Codex 会话记录（在终端跑一次 codex 就有了）'
    : '还没有找到会话记录';
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
    const ptext = document.createElement('span');
    ptext.className = 'ptext';
    ptext.append(s.preview || (s.channel ? '新会话，可以直接从这里发第一条消息' : ''));
    preview.append(ptext, renderStats(s));

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
  refreshJev();
}

// ---- jev-gateway 全局统计：底部一行，没配日志路径或读不到就不显示 ----
async function refreshJev() {
  try {
    const st = await window.api.jevStats();
    const el = $('jev');
    if (!st) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle('on', st.online);
    el.textContent = `${st.online ? '●' : '○'} Jev 高${st.hi}/低${st.lo} · 判分 ${st.judged}/${st.total} · 均 ${(st.avgMs / 1000).toFixed(1)}s`;
    el.title = `jev-gateway 最近 ${st.total} 个请求（日志尾部窗口）· 最后请求 ${ago(st.lastAt)}\n高低档口径：opus·glm-strong=高，haiku·glm-flash=低`;
  } catch { /* 网关行不显示就算了 */ }
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

// ---- 快捷启动：一键在常用目录起一个会话（Claude 形态走 cf，Codex 形态走 codex） ----
let quickDirList = [];
function renderQuickDirs(dirs) {
  $('launch').replaceChildren(...dirs.map((d) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `+ ${d.name}`;
    btn.title = `在 ${d.path} 启动 ${modeInfo().launch} 会话`;
    btn.addEventListener('click', async () => {
      try {
        const res = await window.api.spawn(d.path, mode);
        flash(`已从 ${res.name} 启动 ${modeInfo().launch} 会话`);
      } catch (e) {
        flash(`启动失败：${String(e.message || e)}`);
      }
    });
    return btn;
  }));
}
window.api.quickDirs().then((dirs) => { quickDirList = dirs; renderQuickDirs(dirs); }).catch(() => {});

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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') stop(); });

synth.onvoiceschanged = fillVoices;
window.api.edgeVoices().then((v) => { edgeVoices = v; fillVoices(); });
fillVoices();
applyMode();
refresh();
setInterval(refresh, 3000);
