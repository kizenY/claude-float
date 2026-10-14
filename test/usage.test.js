const assert = require('assert');
const { parse, tierOf, usageStats } = require('../sessions');

// 档位分类：对齐 jev-gateway 的路由位
assert.strictEqual(tierOf('claude-opus-5-5'), 'hi');
assert.strictEqual(tierOf('claude-opus-4-1'), 'hi');
assert.strictEqual(tierOf('glm-strong'), 'hi');
assert.strictEqual(tierOf('claude-haiku-5-5'), 'lo');
assert.strictEqual(tierOf('glm-5.3-flash'), 'lo');
assert.strictEqual(tierOf('glm-4.5-flash'), 'lo');
assert.strictEqual(tierOf('claude-sonnet-4-5'), null); // 不认识的不计
assert.strictEqual(tierOf(''), null);
assert.strictEqual(tierOf(undefined), null);

const asst = (id, model, usage, extra = {}) => ({
  type: 'assistant', isSidechain: false,
  message: { id, model, usage, content: [{ type: 'text', text: 'x' }] },
  ...extra,
});
const U = (input, cacheRead, cacheCreate, output) => ({
  input_tokens: input, cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreate, output_tokens: output,
});

// 空记录
assert.deepStrictEqual(usageStats([]), { ctx: null, hi: 0, lo: 0, out: 0 });

// 高低档计数 + ctx 取最后一条
const s1 = usageStats([
  asst('m1', 'claude-haiku-5-5', U(10, 1000, 0, 50)),
  asst('m2', 'claude-opus-5-5', U(20, 2000, 5, 100)),
]);
assert.strictEqual(s1.hi, 1);
assert.strictEqual(s1.lo, 1);
assert.strictEqual(s1.out, 150);
assert.strictEqual(s1.ctx, 2025); // 20 + 2000 + 5

// 同一条消息拆多行：usage 每行重复，按 message.id 去重
const s2 = usageStats([
  asst('m1', 'claude-opus-5-5', U(10, 100, 0, 40)),
  asst('m1', 'claude-opus-5-5', U(10, 100, 0, 40)), // 同 id 的续行
]);
assert.strictEqual(s2.hi, 1);
assert.strictEqual(s2.out, 40);

// 子 Agent 的记录不计
const s3 = usageStats([
  asst('m1', 'claude-opus-5-5', U(10, 100, 0, 40)),
  asst('s1', 'claude-haiku-5-5', U(5, 50, 0, 20), { isSidechain: true }),
]);
assert.strictEqual(s3.hi, 1);
assert.strictEqual(s3.lo, 0);

// parse() 带出 stats
const p = parse([asst('m1', 'claude-haiku-5-5', U(10, 1000, 0, 50))]);
assert.strictEqual(p.stats.lo, 1);
assert.strictEqual(p.stats.ctx, 1010);

console.log('usage ok');
