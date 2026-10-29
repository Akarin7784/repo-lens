// 可配置留出集纯函数的单测(全部合成数据,不读任何真实题表)。运行:node --test scripts/rag-eval-holdout-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLDOUTS,
  resolveHoldoutConfig,
  parseHoldout,
  judge,
  scoreQuestion,
  assertRunOnce,
} from './rag-eval-holdout-lib.mjs';

const table = (rows) =>
  [
    '| 编号 | 类型 | 问题 | 参考文件 | 参考符号 | 理由 |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
const row = (L, n, refs) => `| ${L}${n} | 定位 | 合成问题${n}? | ${refs} | \`x\` | 合成 |`;
const W = { idLetter: 'W', prefix: 'src/', expectedRows: 3 };
const wTable = (n = 3) =>
  table(Array.from({ length: n }, (_, k) => row('W', k + 1, `\`src/m${k}.ts\`;\`src/n${k}.ts\``)));

test('配置:v3 = h3 提交、W 前缀、src/ 前缀、10 题;v2 保持原值', () => {
  const v3 = resolveHoldoutConfig('v3');
  assert.equal(v3.commit, 'f0e17808ac2439b6434bb10609a961067f4d555b');
  assert.equal(v3.idLetter, 'W');
  assert.equal(v3.prefix, 'src/');
  assert.equal(v3.expectedRows, 10);
  assert.equal(v3.file, 'docs/RAG_HOLDOUT_V3.md');
  assert.equal(HOLDOUTS.v2.commit, 'b1f6ba06c5de0e600640917615e5df70fa73f060');
  assert.equal(HOLDOUTS.v2.idLetter, 'V');
  assert.equal(HOLDOUTS.v2.prefix, 'packages/zod/src/v4/');
});

test('配置:显式参数覆盖,非法值报错', () => {
  const c = resolveHoldoutConfig('v3', [
    '--id-letter',
    'Q',
    '--prefix',
    'lib/core/',
    '--rows',
    '4',
    '--commit',
    'a'.repeat(40),
  ]);
  assert.deepEqual(
    [c.idLetter, c.prefix, c.expectedRows, c.commit],
    ['Q', 'lib/core/', 4, 'a'.repeat(40)],
  );
  assert.throws(() => resolveHoldoutConfig('v9'), /未知留出集/);
  assert.throws(() => resolveHoldoutConfig('v3', ['--id-letter', 'w']), /大写字母/);
  assert.throws(() => resolveHoldoutConfig('v3', ['--commit', 'abc']), /40 位/);
  assert.throws(() => resolveHoldoutConfig('v3', ['--prefix', 'src']), /以 \/ 结尾/);
  assert.throws(() => resolveHoldoutConfig('v3', ['--rows', '0']), /正整数/);
  assert.throws(() => resolveHoldoutConfig('v3', ['--rows']), /缺少取值/);
});

test('解析:W 前缀、src/ 前缀', () => {
  const r = parseHoldout(wTable(), W);
  assert.deepEqual(
    r.map((x) => x.id),
    ['W1', 'W2', 'W3'],
  );
  assert.deepEqual(r[0].want, ['src/m0.ts', 'src/n0.ts']);
});

test('解析:任意判分前缀', () => {
  const md = table([row('K', 1, '`a/b/c/x.ts`'), row('K', 2, '`a/b/c/d/y.ts`')]);
  const r = parseHoldout(md, { idLetter: 'K', prefix: 'a/b/c/', expectedRows: 2 });
  assert.deepEqual(r[1].want, ['a/b/c/d/y.ts']);
  assert.throws(
    () => parseHoldout(md, { idLetter: 'K', prefix: 'a/z/', expectedRows: 2 }),
    /a\/z\/ 下/,
  );
});

test('解析严格:题数不符、编号乱序、错字母、test/ 路径、目录、列数不符都报错', () => {
  assert.throws(() => parseHoldout(wTable(2), W), /应为 3,实际 2/);
  assert.throws(() => parseHoldout(wTable(4), W), /应为 3,实际 4/);
  const swap = table([
    row('W', 2, '`src/a.ts`'),
    row('W', 1, '`src/b.ts`'),
    row('W', 3, '`src/c.ts`'),
  ]);
  assert.throws(() => parseHoldout(swap, W), /编号应依次/);
  // V 前缀行不会被 W 配置当成题目
  const vRows = table([
    row('V', 1, '`src/a.ts`'),
    row('V', 2, '`src/b.ts`'),
    row('V', 3, '`src/c.ts`'),
  ]);
  assert.throws(() => parseHoldout(vRows, W), /实际 0/);
  const t = table([
    row('W', 1, '`test/a.test.ts`'),
    row('W', 2, '`src/b.ts`'),
    row('W', 3, '`src/c.ts`'),
  ]);
  assert.throws(() => parseHoldout(t, W), /src\/ 下/);
  const d = table([
    row('W', 1, '`src/dir/`'),
    row('W', 2, '`src/b.ts`'),
    row('W', 3, '`src/c.ts`'),
  ]);
  assert.throws(() => parseHoldout(d, W), /完整文件路径/);
  assert.throws(
    () => parseHoldout(table(['| W1 | 少列 | 问题 |']), { ...W, expectedRows: 1 }),
    /6 列/,
  );
});

test('判分:文件级完整路径精确匹配,前 5 个切块,首位另计', () => {
  const want = ['src/utils/body.ts'];
  assert.deepEqual(judge(['src/utils/body.ts'], want, 'src/'), {
    hit5: true,
    top1: true,
    firstRank: 1,
  });
  // 同名但不同目录、test/ 下同名都不算
  assert.equal(
    judge(['src/body.ts', 'test/utils/body.ts', 'src/utils/body.tsx'], want, 'src/').hit5,
    false,
  );
  // 同一文件多个切块:第 5 位命中算,第 6 位不算
  const p = ['src/a.ts', 'src/a.ts', 'src/b.ts', 'src/b.ts', 'src/utils/body.ts'];
  assert.deepEqual(judge(p, want, 'src/'), { hit5: true, top1: false, firstRank: 5 });
  assert.equal(
    judge([...p.slice(0, 4), 'src/c.ts', 'src/utils/body.ts'], want, 'src/').hit5,
    false,
  );
  // 前缀外的路径即使相等也不算
  assert.equal(judge(['lib/x.ts'], ['lib/x.ts'], 'src/').hit5, false);
});

test('计分:改写失败与检索降级都记 FAILED 且计未命中', () => {
  const want = ['src/a.ts'];
  assert.deepEqual(
    scoreQuestion({
      rewriteUsed: false,
      retrieval: 'hybrid',
      paths: ['src/a.ts'],
      want,
      prefix: 'src/',
    }),
    {
      failed: true,
      hit5: false,
      top1: false,
      firstRank: null,
    },
  );
  const deg = scoreQuestion({
    rewriteUsed: true,
    retrieval: 'keyword-only',
    paths: ['src/a.ts'],
    want,
    prefix: 'src/',
  });
  assert.equal(deg.failed, true);
  assert.equal(deg.hit5, false);
  assert.equal(deg.top1, false);
  const ok = scoreQuestion({
    rewriteUsed: true,
    retrieval: 'hybrid',
    paths: ['src/a.ts'],
    want,
    prefix: 'src/',
  });
  assert.deepEqual(ok, { failed: false, hit5: true, top1: true, firstRank: 1 });
});

test('一次性运行保护:结果文件已存在拒绝,--force 放行', () => {
  assert.throws(
    () => assertRunOnce({ name: 'v3', resultFile: '/tmp/x', exists: true, force: false }),
    /只许跑一次/,
  );
  assert.doesNotThrow(() =>
    assertRunOnce({ name: 'v3', resultFile: '/tmp/x', exists: true, force: true }),
  );
  assert.doesNotThrow(() =>
    assertRunOnce({ name: 'v3', resultFile: '/tmp/x', exists: false, force: false }),
  );
});
