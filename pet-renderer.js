// 宠物窗口：精灵图动画 + 常驻会话托盘（有 进行中/等你 的会话时显示在宠物上方）+ 手动拖拽
// 窗口 focusable=false 不抢焦点；窗口高度随会话数自适应，锚点始终是宠物本体（右下角），
// 位置推算和状态保存都由主进程按 petOrigin 处理
const petEl = document.getElementById('pet');
const trayEl = document.getElementById('tray');
const listEl = trayEl;
const badgeEl = document.createElement('div');
badgeEl.id = 'badge';
badgeEl.hidden = true;

const TRAY_WIDTH = 280;
const PET_SIZE = { width: 150, height: 162 }; // 和 main.js 的 PET_WIDTH/PET_HEIGHT 对齐
const ROW_HEIGHT = 46; // 和 pet.css 里 .trow 实高对齐（两行文字 + padding）
const TRAY_GAP = 8; // 托盘卡片四周留白
const QUICK_GAP = 8; // 快捷目录卡片上下留白
const MAX_ROWS = 9;

let anims = {};
let current = null;
let startedAt = 0;
let timer = null;
let lastData = { working: false, waiting: false, finishedAt: 0, items: [] };
let celebratedAt = 0;
let sentSize = null; // 上次发给主进程的窗口尺寸，没变化就不重复 setBounds
let quickDirs = null; // null = 还没加载完；空数组 = 没配目录（点了不展开）
let quickVisible = false; // 快捷目录卡片默认隐藏，点宠物本体切换
let quickH = 0; // 快捷卡片实测高（含 padding/border），显隐切换后重算窗口

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// ---- 动画引擎：按每帧时长推进；loop 循环播，一次性播完回落到当前状态 ----
function showFrame(a, elapsed) {
  let total = 0;
  for (const f of a.frames) total += f.ms;
  let rest = a.loop ? elapsed % total : Math.min(elapsed, total - 1);
  for (const f of a.frames) {
    if (rest < f.ms) {
      const col = f.i % cols;
      const row = Math.floor(f.i / cols);
      petEl.style.backgroundPosition = `${-col * fw}px ${-row * fh}px`;
      return f.ms - rest;
    }
    rest -= f.ms;
  }
  return 60;
}

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(tick, Math.max(delay, 15));
}

function tick() {
  const a = anims[current];
  if (!a) return;
  const elapsed = performance.now() - startedAt;
  if (!a.loop) {
    let total = 0;
    for (const f of a.frames) total += f.ms;
    if (elapsed >= total) return setAnim(baseAnim()); // 一次性播完，回到当前状态
  }
  schedule(showFrame(a, elapsed));
}

function setAnim(name) {
  if (current === name && anims[name]) return;
  const a = anims[name];
  if (!a) return;
  current = name;
  startedAt = performance.now();
  schedule(0);
}

// 一次性动画（庆祝/挥手），播的时候状态变了就立刻切走
function playOneShot(name) {
  if (!anims[name]) return;
  current = name;
  startedAt = performance.now();
  schedule(0);
}

function baseAnim() {
  if (lastData.working) return 'running';
  if (lastData.waiting) return 'waiting';
  return 'idle';
}

// ---- 托盘尺寸：会话数/快捷目录显隐变了就调窗口（锚点在宠物本体，向上长） ----
function applySize() {
  const n = Math.min(lastData.items.length, MAX_ROWS);
  const quickPart = quickVisible && quickH ? quickH + QUICK_GAP : 0;
  const listPart = n > 0 ? n * ROW_HEIGHT + TRAY_GAP : 0;
  const size = listPart || quickPart
    ? { width: TRAY_WIDTH, height: PET_SIZE.height + quickPart + listPart }
    : { ...PET_SIZE };
  if (sentSize && sentSize.width === size.width && sentSize.height === size.height) return;
  sentSize = size;
  trayEl.hidden = n === 0;
  window.api.petExpand(size.width, size.height).catch(() => {});
}

function renderBadge() {
  const waiting = lastData.items.filter((s) => s.status === 'waiting').length;
  badgeEl.hidden = waiting === 0;
  badgeEl.textContent = waiting;
}

// 状态 chip：空闲的显示最后活动时间（刚完成的会话以此留在托盘等候查看）
function chipHtml(s) {
  if (s.status === 'working') return '<span class="chip working">进行中</span>';
  if (s.status === 'waiting') return '<span class="chip waiting">等你回复</span>';
  return `<span class="chip idle">空闲 · ${ago(s.mtime)}</span>`;
}

// 等待中的会话排最前（最需要你拍板），其次在跑的，其余按时间——对齐 CodeX/AgentPet 的信息优先级
function trayOrder(a, b) {
  const rank = (s) => (s.status === 'waiting' ? 0 : s.status === 'working' ? 1 : 2);
  return rank(a) - rank(b) || b.mtime - a.mtime;
}

function renderTray() {
  const items = lastData.items.slice().sort(trayOrder).slice(0, MAX_ROWS);
  listEl.replaceChildren(...items.map((s) => {
    const li = document.createElement('li');
    li.className = 'trow' + (s.status === 'waiting' ? ' waiting' : '');
    const t1 = document.createElement('div');
    t1.className = 't1';
    const dot = document.createElement('i');
    dot.className = `dot ${s.status}`;
    const title = document.createElement('b');
    title.textContent = s.title;
    t1.append(dot, title);
    t1.insertAdjacentHTML('beforeend', chipHtml(s));
    const t2 = document.createElement('div');
    t2.className = 't2';
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = s.mode === 'codex' ? 'Codex' : 'Claude';
    const pv = document.createElement('span');
    pv.className = 'pv';
    // 等待时优先显示在等什么（对齐 AgentPet 的 waiting 原因），否则给最后回复摘要
    pv.textContent = s.status === 'waiting' && s.waitingFor
      ? `在等你：${s.waitingFor}`
      : (s.preview || s.project || '');
    t2.append(src, pv);
    li.append(t1, t2);
    li.title = s.status === 'waiting'
      ? '在等你：点击切换，处理完就从托盘消失'
      : s.status === 'idle'
        ? '已完成：点击查看，看完从托盘消失'
        : '点击切换到这个会话的终端';
    li.addEventListener('click', async () => {
      if (s.status !== 'working') {
        // 点开等待中/刚完成的会话 = 已处理：立刻从托盘和徽章里消失（不等下一轮轮询），主进程记住不再显示
        lastData.items = lastData.items.filter((x) => x !== s);
        renderBadge();
        renderTray();
        applySize();
        window.api.petDismiss(`${s.mode}:${s.id}`).catch(() => {});
      }
      try {
        const res = await window.api.focus(s.id, s.mode);
        if (!res.ok) petEl.title = res.message || '没找到会话的窗口';
      } catch { /* 切不动就算了 */ }
    });
    return li;
  }));
}

// ---- 快捷目录：和浮窗底部共用 quick-dirs.json，点目录名在对应目录起一个 cf 会话 ----
const quickEl = document.getElementById('quick');

function renderQuick() {
  if (!quickDirs) return;
  quickEl.replaceChildren(...quickDirs.map((d) => {
    const b = document.createElement('button');
    b.className = 'qbtn';
    b.textContent = d.name;
    b.title = `在 ${d.path} 起一个 cf 会话`;
    b.addEventListener('click', () => window.api.spawn(d.path).catch(() => {}));
    return b;
  }));
}

function toggleQuick() {
  if (!quickDirs || !quickDirs.length) return; // 目录没加载完/没配置：点了不展开
  quickVisible = !quickVisible;
  quickEl.hidden = !quickVisible;
  renderQuick();
  requestAnimationFrame(() => { // 等布局出来再量实际高度
    quickH = quickVisible ? quickEl.offsetHeight : 0;
    applySize();
  });
}

// ---- 状态轮询：主进程聚合 claude + codex 两边，只回 在跑/等你 的会话 ----
async function pollSessions() {
  try {
    const data = await window.api.petSessions();
    lastData = data;
    renderBadge();
    renderTray();
    applySize();
    if (lastData.finishedAt && lastData.finishedAt > celebratedAt) {
      celebratedAt = lastData.finishedAt;
      playOneShot('jumping'); // 刚干完活，跳一下庆祝
      return;
    }
    if (anims[current] && !anims[current].loop) return; // 一次性动画播完自己会回落
    setAnim(baseAnim());
  } catch { /* 主进程忙时不更新 */ }
}

// ---- 手动拖拽（只在宠物本体上按下）；点一下切换快捷目录显隐（顺手挥个手），双击隐藏（托盘里再开） ----
let drag = null;
let moved = 0;

petEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  drag = { x: e.screenX, y: e.screenY };
  moved = 0;
});
addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (!dx && !dy) return;
  drag.x = e.screenX;
  drag.y = e.screenY;
  moved += Math.abs(dx) + Math.abs(dy);
  window.api.petMoveBy(dx, dy);
});
addEventListener('mouseup', () => {
  const d = drag;
  drag = null;
  if (d && moved < 6) { toggleQuick(); playOneShot('waving'); }
});
petEl.addEventListener('dblclick', () => window.api.petHide());

// ---- 启动 ----
let fw = 192;
let fh = 208;
let cols = 8;

(async () => {
  const data = await window.api.petLoad().catch(() => null);
  if (!data || !data.pet) {
    petEl.style.display = 'none';
    const tip = document.createElement('div');
    tip.id = 'fallback';
    tip.textContent = '没有可用的宠物。把 CodeX 的宠物目录放到 ~/.claude-float/pets/ 或 ~/.codex/pets/，托盘菜单可重开。';
    document.body.append(tip);
    return;
  }
  const { pet, sheet } = data;
  fw = pet.frameWidth;
  fh = pet.frameHeight;
  cols = pet.columns;
  petEl.style.backgroundImage = `url(${sheet})`;
  petEl.style.backgroundSize = `${fw * cols}px ${fh * pet.rows}px`;
  petEl.title = `${pet.name}${pet.description ? ' · ' + pet.description : ''}（点一下切换快捷目录，双击隐藏）`;
  anims = pet.animations;
  document.body.append(badgeEl);
  setAnim('idle');
  pollSessions();
  setInterval(pollSessions, 3000);
  window.api.quickDirs().then((dirs) => {
    quickDirs = Array.isArray(dirs) ? dirs : [];
  }).catch(() => { quickDirs = []; });
})();
