// 桌面宠物：加载 CodeX 格式的宠物包（pet.json + spritesheet），并聚合会话状态给宠物窗口。
// 目录约定：~/.claude-float/pets/<id>/（自有）与 ~/.codex/pets/<id>/（CodeX 自动导入）。
// pet.json 格式与 CodeX 对齐：
//   { "displayName": "...", "description": "...", "spritesheetPath": "spritesheet.png",
//     "frame": { "width": 192, "height": 208, "columns": 8, "rows": 9 },   // 可省，省略时按图片尺寸自动算
//     "animations": { "名字": { "frames": [帧序号…], "fps": 8, "loop": true } } // 可省，省略用内置动画表
// 纯 Node 模块，不依赖 Electron，测试直接 require。
const fs = require('fs');
const os = require('os');
const path = require('path');

// 与 CodeX 一致的默认网格：一帧 192x208、8 列；行数按图片高度自动算（平安这类 11 行的自制图也兼容）
const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 208;
const FRAME_COLUMNS = 8;
const MAX_FRAMES = 256;

// ---- 图片尺寸嗅探：只认文件头，不解码整张图 ----
function imageDims(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' };
  }
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), mime: 'image/webp' };
    }
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, mime: 'image/webp' };
    }
    if (chunk === 'VP8L' && buf[20] === 0x2f) {
      const n = buf.readUInt32LE(21);
      return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1, mime: 'image/webp' };
    }
  }
  throw new Error('不支持的精灵图格式（只认 PNG / WebP）');
}

// ---- 内置动画表：行号与 CodeX 的精灵图布局一致 ----
// 0 待机 1 向右跑 2 向左跑 3 挥手 4 跳 5 失落 6 等待(歪头) 7 原地跑 8 巡视
function rowAnim(row, count, ms, lastMs, columns, loop) {
  const frames = [];
  for (let c = 0; c < count; c++) {
    frames.push({ i: row * columns + c, ms: c === count - 1 ? lastMs : ms });
  }
  return { frames, loop };
}

// 一次性动画播 3 遍再回落待机（和 CodeX 的 app_state_animation 同款手感）
function oneShot(frames) {
  return { frames: [...frames, ...frames, ...frames], loop: false };
}

function defaultAnimations(columns) {
  const row = (n, count, ms, lastMs, loop) => rowAnim(n, count, ms, lastMs, columns, loop);
  return {
    idle: {
      frames: [0, 1, 2, 3, 4, 5].map((i) => ({ i, ms: [1680, 660, 660, 840, 840, 1920][i] })),
      loop: true,
    },
    'running-right': row(1, 8, 120, 220, true),
    'running-left': row(2, 8, 120, 220, true),
    waving: oneShot(row(3, 4, 140, 280, true).frames),
    jumping: oneShot(row(4, 5, 140, 280, true).frames),
    failed: row(5, 8, 140, 240, true),
    waiting: row(6, 6, 150, 260, true),
    running: row(7, 6, 120, 220, true),
    review: row(8, 6, 150, 280, true),
  };
}

// ---- pet.json 解析 ----
// 精灵图路径只允许目录内的相对路径，和 CodeX 一样不给 ../ 开后门
function resolveSheetPath(petDir, sheetPath) {
  const p = path.normalize(sheetPath || 'spritesheet.webp');
  if (path.isAbsolute(p) || p.split(path.sep).includes('..')) {
    throw new Error('spritesheetPath 必须是宠物目录内的相对路径');
  }
  return path.join(petDir, p);
}

function buildAnimations(overrides, frameCount, columns) {
  const animations = defaultAnimations(columns);
  for (const [name, spec] of Object.entries(overrides || {})) {
    if (!Array.isArray(spec.frames) || !spec.frames.length) {
      throw new Error(`动画 ${name} 至少要有一帧`);
    }
    if (spec.frames.some((i) => !Number.isInteger(i) || i < 0 || i >= frameCount)) {
      throw new Error(`动画 ${name} 的帧序号越界（共 ${frameCount} 帧）`);
    }
    const ms = spec.fps != null ? Math.round(1000 / spec.fps) : 125;
    if (!Number.isFinite(ms) || ms <= 0 || ms > 5000) {
      throw new Error(`动画 ${name} 的 fps 不合法`);
    }
    animations[name] = {
      frames: spec.frames.map((i) => ({ i, ms })),
      loop: spec.loop !== false,
    };
  }
  return animations;
}

// 读目录里的 pet.json（CodeX 新格式）或 avatar.json（旧格式），返回统一的宠物定义
function loadPetManifest(petDir, id) {
  const manifestFile = ['pet.json', 'avatar.json'].find((f) => fs.existsSync(path.join(petDir, f)));
  if (!manifestFile) throw new Error(`${petDir} 里没有 pet.json`);
  const file = JSON.parse(fs.readFileSync(path.join(petDir, manifestFile), 'utf8'));

  const sheetPath = resolveSheetPath(petDir, file.spritesheetPath);
  const dims = imageDims(fs.readFileSync(sheetPath));

  const spec = file.frame || {};
  const width = spec.width || FRAME_WIDTH;
  const height = spec.height || FRAME_HEIGHT;
  // 没写 columns/rows 就从图片尺寸反推（自制精灵图多数只有整体尺寸是确定的）
  const columns = spec.columns || Math.round(dims.width / width);
  const rows = spec.rows || Math.round(dims.height / height);
  if (!width || !height || !columns || !rows) throw new Error('frame 的尺寸和网格数必须非零');
  if (columns * width !== dims.width || rows * height !== dims.height) {
    throw new Error(`网格铺不满精灵图：图是 ${dims.width}x${dims.height}，网格算出来 ${columns * width}x${rows * height}`);
  }
  const frameCount = columns * rows;
  if (frameCount > MAX_FRAMES) throw new Error(`帧数 ${frameCount} 超过上限 ${MAX_FRAMES}`);

  return {
    id,
    name: (file.displayName || '').trim() || id,
    description: (file.description || '').trim(),
    sheetPath,
    mime: dims.mime,
    frameWidth: width,
    frameHeight: height,
    columns,
    rows,
    frameCount,
    animations: buildAnimations(file.animations, frameCount, columns),
  };
}

// ---- 扫描宠物目录：自有目录优先，同 id 去重 ----
function listPetDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => !id.startsWith('.'));
  } catch {
    return [];
  }
}

function scanPets({ userDir, codexDir }) {
  const seen = new Map();
  const add = (root, source) => {
    for (const id of listPetDirs(root)) {
      if (seen.has(id)) continue;
      try {
        const pet = loadPetManifest(path.join(root, id), id);
        seen.set(id, { id, dir: path.join(root, id), source, name: pet.name, description: pet.description });
      } catch {
        // 半成品目录跳过，不挡别的宠物
      }
    }
  };
  add(userDir, 'user');
  add(codexDir, 'codex');
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function defaultDirs() {
  return {
    userDir: path.join(os.homedir(), '.claude-float', 'pets'),
    codexDir: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'pets'),
  };
}

// ---- 状态聚合：把 claude + codex 两份会话列表压成一个宠物状态 ----
// working  = 有会话在跑 → 跑步
// waiting  = 有会话在等回复 → 歪头
// finishedAt = 最近一次「从有会话在跑变成全部闲下来」的时刻（给庆祝动画用，0 表示没有）
function aggregateStatus(prev, items, now) {
  let working = false;
  let waiting = false;
  for (const s of items || []) {
    if (s.status === 'working') working = true;
    else if (s.status === 'waiting') waiting = true;
  }
  const prevFinishedAt = (prev && prev.finishedAt) || 0;
  const finishedAt = working ? 0 : (prev && prev.working ? now : prevFinishedAt);
  return { working, waiting, finishedAt };
}

module.exports = {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  FRAME_COLUMNS,
  imageDims,
  loadPetManifest,
  scanPets,
  defaultDirs,
  aggregateStatus,
};
