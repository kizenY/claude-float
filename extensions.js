// 扩展系统（apiVersion 1）：浮窗以外部进程方式承载第三方面板，本体只渲染固定「视图词汇」
// 设计参照 trine 的 D18 扩展模型，按 claude-float 裁剪（单机单用户，无多设备/动作令牌）：
//   - 读取永远无副作用：显示/刷新只跑 view，不会执行任何动作
//   - 动作只在用户点击后执行；发消息/起会话类效果必须经用户两段确认
//   - 浮窗绝不执行扩展代码，扩展返回的文本一律当不可信数据（纯文本展示，不渲染 HTML/图片）
// 安装扩展 = 信任它的代码（等同 Claude Code hook）：它以当前用户身份运行，没有沙箱。
// 纯逻辑 + 进程调用都在这里，便于单测；IPC/UI 在 main.js / renderer.js。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REGISTRY_FILE = path.join(os.homedir(), '.claude-float', 'extensions.json');
const MANIFEST_NAME = 'float-extension.json';

const STDIN_LIMIT = 256 * 1024;   // 输入 JSON 上限
const STDOUT_LIMIT = 512 * 1024;  // 输出 JSON 上限
const READ_TIMEOUT = 5000;        // view 读取超时（毫秒）
const CACHE_TTL = 15e3;           // 读取结果缓存时长
const PER_EXT_PROCS = 2;          // 每个扩展同时最多几个进程
const GLOBAL_PROCS = 4;           // 全部扩展同时最多几个进程

// 视图词汇的上限（照 trine 契约）：超限整个输出判无效
const LIMITS = { sections: 20, items: 200, actions: 8, effects: 4, badges: 8, text: 2048, detail: 16 * 1024, prompt: 32 * 1024 };

// 扩展可以声明的能力。copy / refresh 无副作用不用声明；未声明的能力被用到一律拒绝
const CAPABILITIES = ['prompt.insert', 'prompt.send', 'session.create'];
const LOCAL_EFFECTS = ['prompt.insert', 'copy', 'refresh'];   // 浮窗本地直接执行
const CONFIRM_EFFECTS = ['prompt.send', 'session.create'];    // 必须经用户确认后才执行
const RESERVED_IDS = ['float', 'claude'];

function err(code, message) { return { code, message }; }

// ---- manifest ----

// 校验 manifest 对象，合法返回规范化后的 {id,name,version,description,entry,contributes,capabilities}
function validateManifest(m, where = '') {
  const at = where ? `${where}：` : '';
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw err('manifest', `${at}manifest 必须是 JSON 对象`);
  if (m.apiVersion !== 1) throw err('manifest', `${at}apiVersion 必须是 1`);
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(m.id) || m.id.endsWith('-')) {
    throw err('manifest', `${at}id 必须是 2-32 位小写字母/数字/连字符`);
  }
  if (RESERVED_IDS.includes(m.id)) throw err('manifest', `${at}id "${m.id}" 是保留字`);
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > LIMITS.text) {
    throw err('manifest', `${at}name 必填（${LIMITS.text} 字符内）`);
  }
  if (typeof m.version !== 'string' || !m.version.trim()) throw err('manifest', `${at}version 必填`);
  if (m.description != null && typeof m.description !== 'string') throw err('manifest', `${at}description 必须是字符串`);
  if (!Array.isArray(m.entry) || !m.entry.length || m.entry.some((a) => typeof a !== 'string' || !a.trim())) {
    throw err('manifest', `${at}entry 必须是非空字符串数组（argv，不经过 shell）`);
  }
  const c = m.contributes || {};
  if (typeof c !== 'object' || Array.isArray(c)) throw err('manifest', `${at}contributes 必须是对象`);
  const panel = c.panel || null; // v1 只有 panel 一个贡献点：{title?} 或 true
  if (panel && panel !== true && (typeof panel !== 'object' || Array.isArray(panel)
    || (panel.title != null && typeof panel.title !== 'string'))) {
    throw err('manifest', `${at}contributes.panel 必须是 true 或 {title}`);
  }
  const caps = m.capabilities || [];
  if (!Array.isArray(caps) || caps.some((x) => !CAPABILITIES.includes(x))) {
    throw err('manifest', `${at}capabilities 只能包含：${CAPABILITIES.join('、')}`);
  }
  return { id: m.id, name: m.name.trim(), version: m.version.trim(), description: m.description || '', entry: m.entry.slice(), contributes: { panel }, capabilities: caps.slice() };
}

// 读扩展目录里的 manifest 并校验（返回值带 dir，invoke 要用扩展目录当工作目录）
function loadManifest(dir) {
  const abs = path.resolve(dir);
  const file = path.join(abs, MANIFEST_NAME);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { throw err('manifest', `找不到 ${MANIFEST_NAME}`); }
  let m;
  try { m = JSON.parse(raw); } catch { throw err('manifest', `${MANIFEST_NAME} 不是合法 JSON`); }
  return { ...validateManifest(m, path.basename(abs)), dir: abs };
}

// ---- 注册表：~/.claude-float/extensions.json，[{id, dir, enabled, addedAt}] ----
// manifest 永远从扩展目录现读（升级扩展即生效），注册表只记「装了谁、启没启用」
function loadRegistry(file = REGISTRY_FILE) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(list)) {
      return list.filter((e) => e && typeof e.id === 'string' && typeof e.dir === 'string')
        .map((e) => ({ id: e.id, dir: e.dir, enabled: e.enabled !== false, addedAt: e.addedAt || null }));
    }
  } catch { /* 没有文件或写坏了一半，当空表 */ }
  return [];
}

function saveRegistry(list, file = REGISTRY_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

// 注册一个扩展目录：manifest 必须合法、入口文件（相对路径时）必须存在、id 不与已装的撞
function registryAdd(dir, file = REGISTRY_FILE) {
  const abs = path.resolve(dir);
  const m = loadManifest(abs);
  const list = loadRegistry(file);
  if (list.some((e) => e.id === m.id)) throw err('duplicate', `扩展 "${m.id}" 已经装过了`);
  checkEntryFiles(abs, m.entry);
  const entry = { id: m.id, dir: abs, enabled: true, addedAt: Date.now() };
  saveRegistry([...list, entry], file);
  return entry;
}

function registryRemove(id, file = REGISTRY_FILE) {
  const list = loadRegistry(file);
  const next = list.filter((e) => e.id !== id);
  if (next.length === list.length) return false;
  saveRegistry(next, file);
  invalidate(id);
  return true;
}

function registrySetEnabled(id, enabled, file = REGISTRY_FILE) {
  const list = loadRegistry(file);
  const e = list.find((x) => x.id === id);
  if (!e) return null;
  e.enabled = !!enabled;
  saveRegistry(list, file);
  invalidate(id);
  return e;
}

// 注册表 + manifest 合并视图：单条失败不拖垮整表，返回 {ext, error} 二选一的条目
function listInstalled(file = REGISTRY_FILE) {
  return loadRegistry(file).map((e) => {
    try { return { entry: e, manifest: loadManifest(e.dir) }; }
    catch (error) { return { entry: e, error: String(error.message || error) }; }
  });
}

// ---- 调用协议 ----

// entry[0]（及参数里的相对路径）按扩展目录解析；裸命令名查 PATH（结果缓存）。
// .cmd/.bat 一律拒绝：不经 shell 直跑它们在 Node 上本来就起不来，放开就得过 shell，会引入注入面
const resolveCache = new Map();
function resolveCommand(name) {
  if (resolveCache.has(name)) return resolveCache.get(name);
  let hit = null;
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(finder, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    hit = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
    if (hit && /\.(cmd|bat)$/i.test(hit)) hit = null; // 查到的也是 .cmd 就当没有
  } catch { /* PATH 里没有 */ }
  resolveCache.set(name, hit);
  return hit;
}

function checkEntryFiles(dir, entry) {
  for (const a of entry) {
    if (/\.(cmd|bat)$/i.test(a)) throw err('entry', `入口不能是 .cmd/.bat（不经 shell 起不来）：${a}。请用 ["node", "bin/xxx.js"] 形式`);
    if (a.includes('/') || a.includes('\\') || a.startsWith('.')) {
      const abs = path.resolve(dir, a);
      try { fs.accessSync(abs); } catch { throw err('entry', `入口文件不存在：${a}`); }
    }
  }
}

function resolveArgv(dir, entry) {
  return entry.map((a, i) => {
    if (/\.(cmd|bat)$/i.test(a)) throw err('entry', `入口不能是 .cmd/.bat：${a}`);
    if (i === 0 && !a.includes('/') && !a.includes('\\') && !a.startsWith('.')) {
      const hit = resolveCommand(a); // 裸命令名查 PATH
      if (!hit) throw err('entry', `PATH 里找不到命令：${a}`);
      return hit;
    }
    if (a.includes('/') || a.includes('\\') || a.startsWith('.') || i === 0) {
      const abs = path.resolve(dir, a); // 相对路径按扩展目录解析
      try { fs.accessSync(abs); } catch { throw err('entry', `入口文件不存在：${a}`); }
      return abs;
    }
    return a; // 不含路径分隔的参数原样传
  });
}

// 环境变量白名单：扩展进程只能看到这些 + FLOAT_EXT_DIR。
// USERPROFILE/SYSTEMROOT 是 Windows 侧补充的（os.homedir 与运行库要用），trine 面向 macOS/Linux 不需要
function buildEnv(extra = {}, env = process.env) {
  const out = {};
  for (const k of ['HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'SYSTEMROOT', 'LANG', 'TZ', 'TMPDIR', 'SHELL', 'TERM']) {
    if (env[k] !== undefined) out[k] = env[k];
  }
  for (const k of Object.keys(env)) if (/^LC_[A-Z_]+$/.test(k)) out[k] = env[k];
  const cleanPath = String(env.PATH || env.Path || '').split(path.delimiter)
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter((s) => s && s !== '.' && path.isAbsolute(s))
    .join(path.delimiter);
  if (cleanPath) out.PATH = cleanPath;
  return { ...out, ...extra };
}

// 并发闸门与读取缓存（进程内共享）
const inflight = new Map(); // extId -> count
let inflightGlobal = 0;

function viewCacheKey(id, op, point, cwd) { return `${id}|${op}|${point}|${cwd == null ? '' : String(cwd).toLowerCase()}`; }
const viewCache = new Map(); // key -> { at, result }
function invalidate(id) {
  for (const k of [...viewCache.keys()]) if (id == null || k.startsWith(id + '|')) viewCache.delete(k);
}

// 构造发给扩展的输入 JSON（view op）。cwd 只当数据上下文；
// sessions 是当前目录的会话元信息（只有 id/标题/状态/目录，不含对话内容），最多 200 条
function buildViewInput({ cwd = null, locale = '', sessions = [] } = {}) {
  const sess = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && typeof s.id === 'string')
    .slice(0, 200)
    .map((s) => ({ id: s.id, title: String(s.title || ''), status: String(s.status || ''), cwd: String(s.cwd || '') }));
  return { apiVersion: 1, op: 'view', point: 'panel', locale: String(locale || ''), context: { cwd: cwd || null, sessions: sess }, args: {} };
}

// 跑一次扩展进程：<entry...> view；stdin 写完即关，stdout 收一个 JSON。
// 协议失败（非零退出/坏 JSON/超时/超限/并发满）不抛异常，返回 {ok:false, error}
function invoke(manifestOrEntry, op, input, { timeout = READ_TIMEOUT } = {}) {
  const id = manifestOrEntry.id || path.basename(manifestOrEntry.dir || 'ext');
  const dir = manifestOrEntry.dir || process.cwd();
  let argv;
  try { argv = resolveArgv(dir, [...manifestOrEntry.entry, op]); }
  catch (e) { return Promise.resolve({ ok: false, error: e.code ? e : err('entry', String(e.message || e)) }); }
  const payload = JSON.stringify(input == null ? {} : input);
  if (Buffer.byteLength(payload) > STDIN_LIMIT) {
    return Promise.resolve({ ok: false, error: err('input', '输入超过 256KB 上限') });
  }
  const running = inflight.get(id) || 0;
  if (running >= PER_EXT_PROCS || inflightGlobal >= GLOBAL_PROCS) {
    return Promise.resolve({ ok: false, error: err('busy', '扩展进程并发已满，稍后再试') });
  }
  inflight.set(id, running + 1);
  inflightGlobal++;
  const done = () => { inflight.set(id, Math.max(0, (inflight.get(id) || 1) - 1)); inflightGlobal--; };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: dir, // 扩展进程的工作目录 = 扩展目录（要找自己的文件用 FLOAT_EXT_DIR 或相对路径）
        env: buildEnv({ FLOAT_EXT_DIR: dir, FLOAT_EXT_API: '1' }),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      done();
      resolve({ ok: false, error: err('spawn', `起不来扩展进程：${String(e.message || e)}`) });
      return;
    }
    let out = [];
    let outLen = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done();
      try { child.kill(); } catch { /* 已退出 */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: err('timeout', `扩展 ${op} 超时（${timeout}ms）`) }), timeout);
    child.on('error', (e) => finish({ ok: false, error: err('spawn', `起不来扩展进程：${e.message}`) }));
    child.stdout.on('data', (c) => {
      outLen += c.length;
      if (outLen > STDOUT_LIMIT) return finish({ ok: false, error: err('output', '输出超过 512KB 上限') });
      out.push(c);
    });
    child.stderr.on('data', () => {}); // 扩展自己的日志，不进浮窗
    child.on('close', (code) => {
      if (settled) return;
      const text = Buffer.concat(out).toString('utf8');
      if (code !== 0) return finish({ ok: false, error: err('exit', `扩展进程退出码 ${code}`) });
      let json;
      try { json = JSON.parse(text); } catch { return finish({ ok: false, error: err('output', 'stdout 不是合法 JSON') }); }
      finish({ ok: true, json });
    });
    child.stdin.on('error', () => {}); // 扩展不读 stdin 直接退时别把 EPIPE 抛出来
    child.stdin.end(payload);
  });
}

// 带缓存的 view 读取：同 (扩展, op, cwd) 15s 内只跑一次进程
async function readView(manifest, { cwd = null, locale = '', sessions = [], force = false, timeout } = {}) {
  const key = viewCacheKey(manifest.id, 'view', 'panel', cwd);
  const hit = viewCache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL) return hit.result;
  const run = invoke(manifest, 'view', buildViewInput({ cwd, locale, sessions }), timeout ? { timeout } : {});
  viewCache.set(key, { at: Date.now(), result: run });
  const res = await run;
  if (!res.ok) viewCache.delete(key); // 失败不缓存，下次重试
  return res;
}

// ---- 视图词汇校验（照 trine 契约裁剪）----
// View = { title?, sections, toolbar?, empty? }
// Section = { id, title?, collapsed?, items, empty? }
// Item = { id, title, subtitle?, badges?, meta?, detail?, actions? }
// Badge = { text, tone?, title? }
// Action = { id, label, primary?, destructive?, confirm?, effects? }
// Effect = { type:'prompt.insert', text, sessionId } | { type:'copy', text } | { type:'refresh' }
//         | { type:'prompt.send', text, sessionId } | { type:'session.create', cwd }

function s(v, max, what) {
  if (typeof v !== 'string') throw err('view', `${what} 必须是字符串`);
  if (v.length > max) throw err('view', `${what} 超过 ${max} 字符上限`);
  return v;
}
function b(v, what) {
  if (typeof v !== 'boolean') throw err('view', `${what} 必须是布尔值`);
  return v;
}

function validateEffect(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw err('view', 'effect 必须是对象');
  switch (e.type) {
    case 'prompt.insert':
    case 'prompt.send':
      s(e.text, LIMITS.prompt, `${e.type}.text`);
      s(e.sessionId, LIMITS.text, `${e.type}.sessionId`);
      return e;
    case 'copy':
      s(e.text, LIMITS.text, 'copy.text');
      return e;
    case 'refresh':
      return e;
    case 'session.create':
      s(e.cwd, LIMITS.text, 'session.create.cwd');
      return e;
    default:
      throw err('view', `未知的 effect 类型：${String(e.type)}`);
  }
}

function validateAction(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw err('view', 'action 必须是对象');
  s(a.id, LIMITS.text, 'action.id');
  s(a.label, LIMITS.text, 'action.label');
  if (a.primary != null) b(a.primary, 'action.primary');
  if (a.destructive != null) b(a.destructive, 'action.destructive');
  if (a.confirm != null) s(a.confirm, LIMITS.text, 'action.confirm');
  if (a.effects != null) {
    if (!Array.isArray(a.effects)) throw err('view', 'action.effects 必须是数组');
    if (a.effects.length > LIMITS.effects) throw err('view', `每个动作最多 ${LIMITS.effects} 个效果`);
    a.effects.forEach(validateEffect);
  }
  return a;
}

function validateItem(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) throw err('view', 'item 必须是对象');
  s(it.id, LIMITS.text, 'item.id');
  s(it.title, LIMITS.text, 'item.title');
  if (it.subtitle != null) s(it.subtitle, LIMITS.text, 'item.subtitle');
  if (it.meta != null) s(it.meta, LIMITS.text, 'item.meta');
  if (it.detail != null) s(it.detail, LIMITS.detail, 'item.detail');
  if (it.badges != null) {
    if (!Array.isArray(it.badges) || it.badges.length > LIMITS.badges) throw err('view', `badges 最多 ${LIMITS.badges} 个`);
    for (const bg of it.badges) {
      if (!bg || typeof bg !== 'object') throw err('view', 'badge 必须是对象');
      s(bg.text, LIMITS.text, 'badge.text');
      if (bg.tone != null && !['neutral', 'info', 'success', 'warning', 'danger'].includes(bg.tone)) {
        throw err('view', `未知的 badge tone：${String(bg.tone)}`);
      }
      if (bg.title != null) s(bg.title, LIMITS.text, 'badge.title');
    }
  }
  if (it.actions != null) {
    if (!Array.isArray(it.actions) || it.actions.length > LIMITS.actions) throw err('view', `每项最多 ${LIMITS.actions} 个动作`);
    it.actions.forEach(validateAction);
  }
  return it;
}

function validateViewBody(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw err('view', 'view 必须是对象');
  if (v.title != null) s(v.title, LIMITS.text, 'view.title');
  if (v.empty != null) s(v.empty, LIMITS.text, 'view.empty');
  if (!Array.isArray(v.sections)) throw err('view', 'view.sections 必须是数组');
  if (v.sections.length > LIMITS.sections) throw err('view', `sections 最多 ${LIMITS.sections} 个`);
  if (v.toolbar != null) {
    if (!Array.isArray(v.toolbar) || v.toolbar.length > LIMITS.actions) throw err('view', `toolbar 最多 ${LIMITS.actions} 个动作`);
    v.toolbar.forEach(validateAction);
  }
  for (const sec of v.sections) {
    if (!sec || typeof sec !== 'object') throw err('view', 'section 必须是对象');
    s(sec.id, LIMITS.text, 'section.id');
    if (sec.title != null) s(sec.title, LIMITS.text, 'section.title');
    if (sec.collapsed != null) b(sec.collapsed, 'section.collapsed');
    if (sec.empty != null) s(sec.empty, LIMITS.text, 'section.empty');
    if (!Array.isArray(sec.items)) throw err('view', 'section.items 必须是数组');
    if (sec.items.length > LIMITS.items) throw err('view', `每组 items 最多 ${LIMITS.items} 个`);
    sec.items.forEach(validateItem);
  }
  return v;
}

// 扩展 view op 的 stdout：{view: View} 或 {error:{code,message}}；前者整棵校验，坏一处整块无效
function parseViewOutput(json) {
  if (json && json.error) {
    return { ok: false, error: err(String(json.error.code || 'error').slice(0, 64), String(json.error.message || '扩展报错').slice(0, LIMITS.text)) };
  }
  try {
    return { ok: true, view: validateViewBody(json && json.view) };
  } catch (e) {
    return { ok: false, error: err('view', `扩展返回了无法识别的内容：${e.message}`) };
  }
}

// ---- 效果与能力检查（执行动作前的闸门）----

const isLocal = (type) => LOCAL_EFFECTS.includes(type);
const needsConfirm = (action) => {
  const types = (action.effects || []).map((e) => e.type);
  return (action.destructive === true || action.confirm != null) || types.some((t) => CONFIRM_EFFECTS.includes(t));
};

// 未声明能力的效果一律拒绝；顺带把形状再校验一遍（renderer 传来的 effects 不尽可信）
function checkEffects(effects, capabilities) {
  if (!Array.isArray(effects) || effects.length > LIMITS.effects) throw err('effects', 'effects 非法');
  effects.forEach(validateEffect);
  for (const e of effects) {
    if (e.type !== 'refresh' && e.type !== 'copy' && !capabilities.includes(e.type)) {
      throw err('capability', `扩展未声明 "${e.type}" 能力，拒绝执行`);
    }
  }
  return true;
}

module.exports = {
  REGISTRY_FILE, MANIFEST_NAME, LIMITS, CAPABILITIES, LOCAL_EFFECTS, CONFIRM_EFFECTS,
  READ_TIMEOUT, CACHE_TTL,
  validateManifest, loadManifest, checkEntryFiles,
  loadRegistry, saveRegistry, registryAdd, registryRemove, registrySetEnabled, listInstalled,
  resolveArgv, resolveCommand, buildEnv, buildViewInput,
  invoke, readView, invalidate,
  validateViewBody, parseViewOutput, checkEffects, isLocal, needsConfirm, err,
};
