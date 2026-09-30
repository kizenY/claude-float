const assert = require('assert');
const { toSpeech, chunk } = require('../speech-text');

const md = [
  '## 结果',
  '改好了，见 [main.js](src/app/main.js:42) 和 `E:/develop/code/foo/bar.ts`。',
  '```js',
  'const x = 1;',
  '```',
  '| 项 | 值 |',
  '|---|---|',
  '| a | **1** |',
  '- 第一点',
  '详情 https://example.com/x',
].join('\n');

const out = toSpeech(md);
assert.ok(!out.includes('const x'), 'code removed');
assert.ok(out.includes('（代码略）'));
assert.ok(out.includes('main.js 和 bar.ts'), out);
assert.ok(out.includes('a，1'), out);
assert.ok(!out.includes('**') && !out.includes('##') && !out.includes('|'), out);
assert.ok(out.includes('第一点。'), out);
assert.ok(out.includes('详情 链接'), out);

const parts = chunk('一'.repeat(100) + '。' + '二'.repeat(100) + '。' + '三'.repeat(400));
assert.ok(parts.every((p) => p.length <= 160), parts.map((p) => p.length));
assert.strictEqual(parts.join(''), '一'.repeat(100) + '。' + '二'.repeat(100) + '。' + '三'.repeat(400));
const first = chunk('短句。'.repeat(100), 400, 60);
assert.ok(first[0].length <= 60 && first[1].length > 60 && first[1].length <= 400, first.map((p) => p.length));
console.log('speech-text ok');
