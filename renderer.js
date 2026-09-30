const $ = (id) => document.getElementById(id);
const listEl = $('list');
const synth = window.speechSynthesis;

const settings = (() => {
  try { return { rate: 1.2, voiceURI: '', ...JSON.parse(localStorage.getItem('settings') || '{}') }; }
  catch { return { rate: 1.2, voiceURI: '' }; }
})();
function saveSettings() {
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch { /* 忽略 */ }
}

let sessions = [];
let speakingId = null;
let speakToken = 0;

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function render() {
  $('empty').hidden = sessions.length > 0;
  listEl.replaceChildren(...sessions.map((s) => {
    const li = document.createElement('li');
    li.className = 'item' + (s.id === speakingId ? ' speaking' : '');
    li.title = '点击朗读最新回复，再点一次停止';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = s.title;

    const time = document.createElement('div');
    time.className = 'time';
    if (s.id === speakingId) {
      time.innerHTML = '<span class="bars"><i></i><i></i><i></i></span>';
    } else if (s.working && Date.now() - s.mtime < 60_000) {
      time.innerHTML = '<span class="working">进行中</span>';
    } else {
      time.textContent = ago(s.mtime);
    }

    const preview = document.createElement('div');
    preview.className = 'preview';
    if (s.project) {
      const tag = document.createElement('span');
      tag.className = 'project';
      tag.textContent = s.project;
      preview.append(tag);
    }
    preview.append(s.preview);

    li.append(title, time, preview);
    li.addEventListener('click', () => toggleSpeak(s));
    return li;
  }));
}

async function refresh() {
  try {
    sessions = await window.api.list(20);
    render();
  } catch (e) {
    console.error(e);
  }
}

function pickVoice() {
  const voices = synth.getVoices();
  return voices.find((v) => v.voiceURI === settings.voiceURI)
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

function stop() {
  speakToken++;
  synth.cancel();
  setSpeaking(null);
}

async function toggleSpeak(s) {
  if (speakingId === s.id) return stop();
  stop();
  const token = speakToken;
  setSpeaking(s.id);

  let text;
  try {
    text = window.SpeechText.toSpeech(await window.api.reply(s.file));
  } catch (e) {
    console.error(e);
    text = '读取会话失败。';
  }
  if (token !== speakToken) return;

  const chunks = window.SpeechText.chunk(text || '这条会话还没有文字回复。');
  const voice = pickVoice();
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = settings.rate;
    if (i === chunks.length - 1) {
      u.onend = () => { if (token === speakToken) setSpeaking(null); };
    }
    u.onerror = (ev) => {
      if (ev.error !== 'canceled' && ev.error !== 'interrupted') console.error('tts', ev.error);
      if (token === speakToken && i === chunks.length - 1) setSpeaking(null);
    };
    synth.speak(u);
  });
}

function fillVoices() {
  const voices = synth.getVoices();
  if (!voices.length) return;
  const current = pickVoice();
  const sel = $('voice');
  sel.replaceChildren(...voices.map((v) => {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = v.name.replace(/^Microsoft\s+/, '').replace(/\s+-\s+.*$/, '') + ` (${v.lang})`;
    o.selected = current && v.voiceURI === current.voiceURI;
    return o;
  }));
}

$('voice').addEventListener('change', (e) => { settings.voiceURI = e.target.value; saveSettings(); });
$('rate').value = settings.rate;
$('rate-val').textContent = `${settings.rate}x`;
$('rate').addEventListener('input', (e) => {
  settings.rate = Number(e.target.value);
  $('rate-val').textContent = `${settings.rate}x`;
  saveSettings();
});

$('btn-stop').addEventListener('click', stop);
$('btn-close').addEventListener('click', () => window.api.close());
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
fillVoices();
refresh();
setInterval(refresh, 3000);
