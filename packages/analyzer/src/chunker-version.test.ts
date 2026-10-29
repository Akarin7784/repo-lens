import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CHUNKER_VERSION } from '@repolens/shared';
import { parseWithTreeSitter } from './typescript/treesitter.js';

/**
 * 把 CHUNKER_VERSION 与当前切块输出绑定:固定小样例的切块结果哈希变了,
 * 说明切块行为变了,必须同时递增 CHUNKER_VERSION 并更新下面的 PINNED。
 * 只改哈希不改版本号(或反之)都会失败。
 */
const PINNED = { version: 2, hash: '30c947c20989aa3c' };

const method = (name: string) => [
  `  ${name}(qty: number): number {`,
  ...Array.from({ length: 8 }, (_, i) => `    qty += ${i};`),
  '    return qty;',
  '  }',
];
const SAMPLE = [
  "import { log } from './log';",
  '',
  'export interface Item {',
  '  sku: string;',
  '  price: number;',
  '}',
  '',
  'export class Cart {',
  '  private items: Item[] = [];',
  ...method('add'),
  ...method('remove'),
  ...method('total'),
  ...method('discount'),
  '}',
  '',
  'export type Pair<T> = {',
  '  <A extends T = T,',
  '  >(a: A): [A]',
  '}',
  '',
  'export function checkout(cart: Cart): number {',
  "  log('checkout');",
  '  return 0;',
  '}',
  '',
  'export const TAX = 0.1;',
  '',
].join('\n');

const outputHash = () => {
  const chunks = parseWithTreeSitter({ path: 'src/sample.ts', content: SAMPLE }).chunks.map((c) => [
    c.symbol,
    c.startLine,
    c.endLine,
  ]);
  return createHash('sha256').update(JSON.stringify(chunks)).digest('hex').slice(0, 16);
};

describe('CHUNKER_VERSION 与切块输出绑定', () => {
  it('固定样例的切块哈希与 PINNED 一致,且版本号未变', () => {
    expect({ version: CHUNKER_VERSION, hash: outputHash() }).toEqual(PINNED);
  });
});
