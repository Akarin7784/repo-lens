import { describe, expect, it } from 'vitest';
import { parseWithTreeSitter } from './typescript/treesitter.js';
import { CLASS_SPLIT_MIN_LINES } from './typescript/chunking.js';

const chunksOf = (content: string) => parseWithTreeSitter({ path: 'src/a.ts', content }).chunks;

// tree-sitter-typescript 0.23.2 对「对象类型里换行分隔、以 < 开头的泛型调用签名」报 ERROR,
// 错误恢复会吞掉其后的顶层声明;以下样例在修复前只切出 Wrap 和被截断的 Overloads。
const sig = (n: number) =>
  [
    `  // ${n}`,
    '  <',
    ...Array.from({ length: n }, (_, i) => `    A${i} extends T = T,`),
    '  >(',
    ...Array.from({ length: n }, (_, i) => `    a${i}: A${i},`),
    '  ): [',
    ...Array.from({ length: n }, (_, i) => `    Wrap<A${i}>,`),
    '  ]',
  ].join('\n');
const OVERLOADED = [
  'type Wrap<X> = { x: X }',
  '',
  'export interface Overloads<T> {',
  '  <A0 extends T = T>(a0: A0): [Wrap<A0>]',
  '',
  sig(2),
  '',
  sig(3),
  '}',
  '',
  '/** 盒子 */',
  'export class Box<T> {',
  '  private v: T',
  '  constructor(v: T) {',
  '    this.v = v',
  '  }',
  '  map = <U,>(f: (v: T) => U): Box<U> => new Box<U>(f(this.v))',
  '}',
  '',
  'export const makeBox = <',
  '  T,',
  '>(v: T): Box<T> => new Box<T>(v)',
  '',
].join('\n');

describe('切块:语法错误兜底', () => {
  it('换行分隔的泛型调用签名导致 ERROR 时,其后的 export const 与类仍各自成块且边界完整', () => {
    const r = parseWithTreeSitter({ path: 'src/a.ts', content: OVERLOADED });
    expect(r.hasSyntaxError).toBe(true);
    const by = new Map(r.chunks.map((c) => [c.symbol, c]));
    const lines = OVERLOADED.split('\n');
    const line = (s: string) => lines.findIndex((l) => l.startsWith(s)) + 1;
    expect(by.get('Overloads')).toEqual({
      symbol: 'Overloads',
      startLine: line('export interface Overloads'),
      endLine: line('}'),
    });
    expect(by.get('Box')).toMatchObject({ startLine: line('export class Box') });
    expect(by.get('Box')!.endLine).toBe(lines.lastIndexOf('}') + 1);
    expect(by.get('makeBox')).toMatchObject({ startLine: line('export const makeBox') });
    expect(by.get('makeBox')!.endLine).toBe(line('>(v: T)'));
  });
  it('没有语法错误的文件切块不变', () => {
    const src = 'export const f = () => 1\n\nexport class K {\n  m() {}\n}\n';
    expect(chunksOf(src)).toEqual([
      { symbol: 'f', startLine: 1, endLine: 1 },
      { symbol: 'K', startLine: 3, endLine: 5 },
    ]);
  });
});

describe('切块:大类按方法拆块', () => {
  const pad = (n: number) => Array.from({ length: n }, (_, i) => `  f${i} = ${i}`).join('\n');
  const BIG = [
    'export class Store {',
    pad(CLASS_SPLIT_MIN_LINES),
    '  // 取值',
    '  get(k: string) {',
    '    return k',
    '  }',
    '  put = (k: string) => {',
    '    return k',
    '  }',
    '}',
    '',
  ].join('\n');
  it('超过阈值的类:类头一块,每个方法(含箭头函数字段)一块', () => {
    const n = CLASS_SPLIT_MIN_LINES;
    expect(chunksOf(BIG)).toEqual([
      { symbol: 'Store', startLine: 1, endLine: n + 1 },
      { symbol: 'Store.get', startLine: n + 2, endLine: n + 5 },
      { symbol: 'Store.put', startLine: n + 6, endLine: n + 8 },
    ]);
  });
  it('小类仍整类一块', () => {
    const src = 'class S {\n  a() {}\n  b() {}\n}\n';
    expect(chunksOf(src)).toEqual([{ symbol: 'S', startLine: 1, endLine: 4 }]);
  });
});
