// 只测解析与判分纯函数(合成表格,与 zod 题目无关),不触发检索/改写。运行:node --test scripts/rag-eval-v2-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHoldoutV2, judgeV2 } from './rag-eval-v2-lib.mjs';

const P = 'packages/zod/src/v4/';
const table = (rows) =>
  [
    '| 编号 | 类型 | 问题 | 参考文件 | 参考符号 | 理由 |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
const row = (n, refs) => `| V${n} | 定位 | 合成问题${n}? | ${refs} | \`x\` | 合成 |`;

test('解析:全角/半角分号、完整路径', () => {
  const md = table([
    row(1, `\`${P}a/one.ts\`;\`${P}b/two.ts\``),
    row(2, `\`${P}c.ts\`; \`${P}d.ts\``),
  ]);
  const r = parseHoldoutV2(md, 2);
  assert.deepEqual(r[0], {
    id: 'V1',
    question: '合成问题1?',
    want: [`${P}a/one.ts`, `${P}b/two.ts`],
  });
  assert.deepEqual(r[1].want, [`${P}c.ts`, `${P}d.ts`]);
});

test('解析严格:行数不符、列数不符、非 v4 路径、目录、编号乱序都报错', () => {
  assert.throws(() => parseHoldoutV2(table([row(1, `\`${P}a.ts\``)]), 2), /行数/);
  assert.throws(() => parseHoldoutV2(table(['| V1 | 定位 | q | `x` |']), 1), /6 列/);
  assert.throws(
    () => parseHoldoutV2(table([row(1, '`packages/zod/src/v3/a.ts`')]), 1),
    /完整文件路径/,
  );
  assert.throws(() => parseHoldoutV2(table([row(1, `\`${P}dir/\``)]), 1), /完整文件路径/);
  assert.throws(() => parseHoldoutV2(table([row(1, `${P}a.ts`)]), 1), /反引号/);
  assert.throws(() => parseHoldoutV2(table([row(2, `\`${P}a.ts\``)]), 1), /编号/);
});

test('判分:完整路径精确、v3 同名不算、前 5 与首位', () => {
  const want = [`${P}core/x.ts`];
  assert.deepEqual(judgeV2(['packages/zod/src/v3/core/x.ts', `${P}core/x.ts`], want), {
    hit5: true,
    top1: false,
    firstRank: 2,
  });
  assert.deepEqual(judgeV2([`${P}core/x.ts`], want), { hit5: true, top1: true, firstRank: 1 });
  assert.equal(judgeV2(['a', 'b', 'c', 'd', 'e', `${P}core/x.ts`], want).hit5, false);
  assert.equal(judgeV2([`${P}core/x.tsx`, `src/v4/core/x.ts`], want).hit5, false);
});
