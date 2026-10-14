// 桌面宠物模块：pet.json 解析 / 网格推算 / 动画校验 / 目录扫描 / 状态聚合（夹具放临时目录）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { imageDims, loadPetManifest, scanPets, aggregateStatus } = require('../pet');

// ---- 测试用 PNG 合成：纯 node 手写 chunk（IHDR/IDAT/IEND），w/h 随便给 ----
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 每行一个 filter 字节 + RGBA 像素，全 0（透明），压出来很小
  const raw = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 尺寸嗅探 ----
{
  const { width, height, mime } = imageDims(makePng(1536, 2288));
  assert.strictEqual(width, 1536);
  assert.strictEqual(height, 2288);
  assert.strictEqual(mime, 'image/png');
}
assert.throws(() => imageDims(Buffer.from('not an image at all')));

// ---- pet.json 解析：显式 frame 网格 + 默认动画表 ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-float-'));
  fs.writeFileSync(path.join(dir, 'spritesheet.png'), makePng(16, 16)); // 2x2 帧网格，每帧 8x8
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({
    displayName: '平安',
    description: '毛绒小狗',
    spritesheetPath: 'spritesheet.png',
    frame: { width: 8, height: 8, columns: 2, rows: 2 },
  }));
  const pet = loadPetManifest(dir, 'pingan');
  assert.strictEqual(pet.name, '平安');
  assert.strictEqual(pet.frameWidth, 8);
  assert.strictEqual(pet.frameCount, 4);
  assert.strictEqual(pet.mime, 'image/png');
  // 内置动画表要齐（行号和 CodeX 精灵图对齐）
  for (const name of ['idle', 'running', 'waiting', 'jumping', 'waving']) {
    assert.ok(pet.animations[name], `缺动画 ${name}`);
  }
  // 越界帧号要拒绝
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({
    spritesheetPath: 'spritesheet.png',
    frame: { width: 8, height: 8, columns: 2, rows: 2 },
    animations: { wave: { frames: [4] } },
  }));
  assert.throws(() => loadPetManifest(dir, 'pingan'), /越界/);
  // 非法 fps 要拒绝
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({
    spritesheetPath: 'spritesheet.png',
    frame: { width: 8, height: 8, columns: 2, rows: 2 },
    animations: { wave: { frames: [0], fps: -1 } },
  }));
  assert.throws(() => loadPetManifest(dir, 'pingan'), /fps/);
  // 精灵图路径不许越出目录
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({
    spritesheetPath: '../elsewhere.png',
    frame: { width: 8, height: 8, columns: 2, rows: 2 },
  }));
  assert.throws(() => loadPetManifest(dir, 'pingan'), /相对路径/);
}

// ---- 省略 frame：按图片尺寸自动推算（平安是 1536x2288 = 8 列 x 11 行的 192x208） ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-float-'));
  fs.writeFileSync(path.join(dir, 'spritesheet.png'), makePng(1536, 2288));
  fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({ displayName: '平安', spritesheetPath: 'spritesheet.png' }));
  const pet = loadPetManifest(dir, 'pingan');
  assert.strictEqual(pet.frameWidth, 192);
  assert.strictEqual(pet.frameHeight, 208);
  assert.strictEqual(pet.columns, 8);
  assert.strictEqual(pet.rows, 11);
  assert.strictEqual(pet.frameCount, 88);
  // 网格铺不满要报错
  fs.writeFileSync(path.join(dir, 'spritesheet.png'), makePng(1500, 2288));
  assert.throws(() => loadPetManifest(dir, 'pingan'), /铺不满/);
}

// ---- 目录扫描：自有目录优先，同名去重；坏目录跳过 ----
{
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-user-'));
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-codex-'));
  const writePet = (root, id, name) => {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'spritesheet.png'), makePng(16, 16));
    fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({
      displayName: name,
      spritesheetPath: 'spritesheet.png',
      frame: { width: 8, height: 8, columns: 2, rows: 2 },
    }));
  };
  writePet(userDir, 'pingan', '平安（自有）');
  writePet(codexDir, 'pingan', '平安（CodeX）');
  writePet(codexDir, 'dewey', 'Dewey');
  fs.mkdirSync(path.join(codexDir, 'broken'));
  fs.writeFileSync(path.join(codexDir, 'broken', 'pet.json'), '{ 坏 json');

  const pets = scanPets({ userDir, codexDir });
  assert.deepStrictEqual(pets.map((p) => p.id).sort(), ['dewey', 'pingan']);
  assert.strictEqual(pets.find((p) => p.id === 'pingan').source, 'user');
  assert.strictEqual(pets.find((p) => p.id === 'pingan').name, '平安（自有）');
  // 空目录 → 空列表不报错
  assert.deepStrictEqual(scanPets({ userDir: path.join(userDir, '无'), codexDir: path.join(codexDir, '无') }), []);
}

// ---- 状态聚合：跑→闲 给出 finishedAt，继续跑则清零 ----
{
  const items = (statuses) => statuses.map((status, i) => ({ id: String(i), status }));
  const t0 = 1000;
  let st = aggregateStatus(null, items(['working', 'idle']), t0);
  assert.deepStrictEqual(st, { working: true, waiting: false, finishedAt: 0 });
  // 还在跑 → 没有 finished
  st = aggregateStatus(st, items(['working']), t0 + 3000);
  assert.strictEqual(st.finishedAt, 0);
  // 全闲下来 → 记下完成时刻
  st = aggregateStatus(st, items(['idle', 'waiting']), t0 + 6000);
  assert.strictEqual(st.finishedAt, t0 + 6000);
  assert.strictEqual(st.waiting, true);
  // 完成时刻保留到下次开跑
  st = aggregateStatus(st, items(['idle']), t0 + 9000);
  assert.strictEqual(st.finishedAt, t0 + 6000);
  // 空列表也安全
  assert.strictEqual(aggregateStatus(null, null, t0).working, false);
}

console.log('pet.test.js 通过');
