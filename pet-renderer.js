// 宠物窗口：精灵图动画 + 常驻会话托盘（有 进行中/等你 的会话时显示在宠物上方；多条默认叠成一摞，
// 顶层是进行中点卡展开、是等你/刚完成点卡即点会话，展开后鼠标离开热区 15 秒自动折叠）+ 手动拖拽
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
const MAX_ROWS = 9;
const STACK_PEEK = 26; // 叠起时每张底卡在上一层之上露出的高度（正好是自己的标题行+呼吸，和 pet.css 对齐）
const STACK_LAYERS = 3; // 叠起时最多画几张真卡片（顶层 + 两张垫底）

let anims = {};
let current = null;
let startedAt = 0;
let timer = null;
let lastData = { working: false, waiting: false, finishedAt: 0, items: [] };
let celebratedAt = 0;
let failedSeenAt = 0;
let expanded = false; // 多条会话默认叠成一张卡；顶层进行中点卡展开，离开热区 15 秒自动折叠
let sentSize = null; // 上次发给主进程的窗口尺寸，没变化就不重复 setBounds

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

let failedHold = false; // 报错收尾后一直趴着，直到又有活动或点宠物看过
let runLeft = false;    // 跑步方向：隔几秒掉个头，像来回踱步

function baseAnim() {
  if (failedHold) return 'failed';
  if (lastData.working) {
    // 多个会话同时在跑 = 监工模式（巡视/歪头摆动）；单个就跑步
    const n = lastData.items.filter((s) => s.status === 'working').length;
    if (n >= 2) return 'review';
    return runLeft ? 'running-left' : 'running';
  }
  if (lastData.waiting) return 'waiting';
  return 'idle';
}

// 跑步掉头：正在跑时每隔几秒换方向
setInterval(() => {
  if (current !== 'running' && current !== 'running-left') return;
  runLeft = !runLeft;
  setAnim(runLeft ? 'running-left' : 'running');
}, 6000);

// ---- 托盘尺寸：会话数变了就调窗口（锚点在宠物本体，向上长） ----
function applySize() {
  const n = Math.min(lastData.items.length, MAX_ROWS);
  const stacked = n > 1 && !expanded; // 多条会话默认叠成一摞，高度 = 顶层卡 + 每层垫卡露头
  const peek = stacked ? (Math.min(n, STACK_LAYERS) - 1) * STACK_PEEK : (n - 1) * ROW_HEIGHT;
  const listPart = n === 0 ? 0 : ROW_HEIGHT + peek + TRAY_GAP;
  const size = listPart
    ? { width: TRAY_WIDTH, height: PET_SIZE.height + listPart }
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

// 空闲的排最上面（最面上）：刚干完的最该被看到、点掉；等待有徽章和宠物歪头提示不靠位置，在跑的不用盯
function trayOrder(a, b) {
  const rank = (s) => (s.status === 'idle' ? 0 : s.status === 'waiting' ? 1 : 2);
  return rank(a) - rank(b) || b.mtime - a.mtime;
}

// 点一条会话 = 切到那个终端；等待中/刚完成的顺手从托盘和徽章里消失
async function activateSession(s) {
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
}

function rowTooltip(s) {
  return s.status === 'waiting'
    ? '在等你：点击切换，处理完就从托盘消失'
    : s.status === 'idle'
      ? '已完成：点击查看，看完从托盘消失'
      : '点击切换到这个会话的终端';
}

function buildRow(s, onClick) {
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
  li.title = rowTooltip(s);
  li.addEventListener('click', onClick);
  return li;
}

function renderTray() {
  const items = lastData.items.slice().sort(trayOrder).slice(0, MAX_ROWS);
  if (items.length > 1 && !expanded) {
    // 叠起（默认）：多张真卡片上下错开叠成一摞，底下各露一条自己的标题头（状态点+标题+chip），
    // 像通知堆一样一眼看出叠了几张。顶层是进行中 → 点摞展开列表；是等你/刚完成 → 等同点这条会话
    const top = items[0];
    const layers = Math.min(items.length, STACK_LAYERS);
    listEl.classList.add('stacked');
    const wrap = document.createElement('div');
    wrap.className = 'stack';
    wrap.style.height = `${(layers - 1) * STACK_PEEK + ROW_HEIGHT}px`;
    wrap.title = top.status === 'working'
      ? `${items.length} 个会话：点一下展开，离开 15 秒自动收起`
      : rowTooltip(top);
    wrap.addEventListener('click', () => {
      if (top.status === 'working') { expanded = true; renderTray(); applySize(); }
      else activateSession(top);
    });
    for (let i = layers - 1; i >= 0; i--) { // 从最底那张往上画，顶层最后画、压在所有卡上面
      const row = buildRow(items[i], () => {});
      row.classList.add('layer', `l${i}`);
      if (i === layers - 1 && items.length > layers) {
        // 会话比能画的层数多：最底下那张的 chip 换成总数，示意底下还压着更多
        const chip = row.querySelector('.chip');
        if (chip) { chip.textContent = `${items.length} 条`; chip.className = 'chip idle'; }
      }
      wrap.append(row);
    }
    listEl.replaceChildren(wrap);
    return;
  }
  listEl.classList.remove('stacked');
  listEl.replaceChildren(...items.map((s) => buildRow(s, () => activateSession(s))));
}

// ---- 状态轮询：主进程聚合 claude + codex 两边，只回 在跑/等你 的会话 ----
async function pollSessions() {
  try {
    const data = await window.api.petSessions();
    lastData = data;
    if (lastData.items.length <= 1) expanded = false; // 只剩一条（或没有）就没什么可叠的，回到单卡
    renderBadge();
    renderTray();
    applySize();
    if (lastData.finishedAt && lastData.finishedAt > celebratedAt) {
      celebratedAt = lastData.finishedAt;
      playOneShot('jumping'); // 刚干完活，跳一下庆祝
      return;
    }
    if (lastData.failedAt && lastData.failedAt > failedSeenAt) {
      failedSeenAt = lastData.failedAt;
      failedHold = true; // 报错收尾：趴下失落，直到又有活动或点宠物看过
      setAnim('failed');
      return;
    }
    if (lastData.working || lastData.waiting) failedHold = false;
    if (anims[current] && !anims[current].loop) return; // 一次性动画播完自己会回落
    setAnim(baseAnim());
  } catch { /* 主进程忙时不更新 */ }
}

// ---- 手动拖拽（只在宠物本体上按下）；点一下切换浮窗显隐（顺手挥个手），双击隐藏（托盘里再开） ----
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
  if (!d || moved >= 6) return;
  if (failedHold) failedHold = false; // 趴着时点一下 = 看过了；挥手播完自然回到常态
  window.api.petToggleMain().catch(() => {});
  playOneShot('waving');
});
petEl.addEventListener('dblclick', () => window.api.petHide());

// ---- 展开态自动折叠：鼠标离开 宠物+托盘 热区 15 秒收起（期间回来取消）；
// 点宠物不再收起，统一就是切浮窗 ----
const FOLD_DELAY = 15000;
let foldTimer = null;
function foldNow() {
  clearTimeout(foldTimer);
  foldTimer = null;
  if (!expanded) return;
  expanded = false;
  renderTray();
  applySize();
}
function armFold() {
  if (!expanded) return;
  clearTimeout(foldTimer);
  foldTimer = setTimeout(foldNow, FOLD_DELAY);
}
// mouseleave 不冒泡，挂 document 上；mouseout 兜底（离开窗口时 relatedTarget 为 null）
document.addEventListener('mouseleave', armFold);
document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) armFold(); });
document.addEventListener('mouseenter', () => { clearTimeout(foldTimer); foldTimer = null; });

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
  petEl.title = `${pet.name}${pet.description ? ' · ' + pet.description : ''}（点一下切换浮窗显隐，会话列表展开时点一下收起，双击隐藏）`;
  anims = pet.animations;
  document.body.append(badgeEl);
  setAnim('idle');
  pollSessions();
  setInterval(pollSessions, 3000);
})();
