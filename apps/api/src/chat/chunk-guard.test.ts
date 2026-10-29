import { createHash } from 'node:crypto';
import { MAX_CHUNK_CHARS } from '@repolens/rag';
import { describe, expect, it } from 'vitest';
import {
  CHUNK_TEXT_MAX_CHARS,
  chunkHeader,
  chunkMatchesHash,
  citationWithinSnippet,
  contentSha256,
  prepareSnippet,
} from './chunk-guard.js';
import { realChunks } from './real-chunks.fixture.js';

const SRC = [
  "import { x } from './x.js';", // 1
  '', // 2
  'export function add(a: number, b: number) {', // 3
  '  return a + b;', // 4
  '}', // 5
  '', // 6
  'const top = 1;', // 7
].join('\n');

describe('chunk-guard', () => {
  it('contentSha256 与 worker 口径一致(裸 sha256,无归一化)', () => {
    expect(contentSha256('hello')).toBe(createHash('sha256').update('hello').digest('hex'));
    expect(contentSha256('a\n')).not.toBe(contentSha256('a'));
    expect(contentSha256('a ')).not.toBe(contentSha256('a'));
  });
  it('chunkMatchesHash:一致 true、改一字节 false', () => {
    const content = 'export function f() {}\n';
    const hash = contentSha256(content);
    expect(chunkMatchesHash(content, hash)).toBe(true);
    expect(chunkMatchesHash(content.replace('f', 'g'), hash)).toBe(false);
    expect(chunkMatchesHash(content, hash.replace(/0/, '1'))).toBe(false);
  });
  it('截断上限与 rag MAX_CHUNK_CHARS 一致', () => {
    expect(CHUNK_TEXT_MAX_CHARS).toBe(MAX_CHUNK_CHARS);
  });

  it('有 symbol:剥掉 `path symbol` 标题,区间不变,首行即 startLine 的代码', async () => {
    const [c] = await realChunks('src/math.ts', SRC, [{ symbol: 'add', startLine: 3, endLine: 5 }]);
    expect(c!.content.split('\n')[0]).toBe('src/math.ts add');
    expect(chunkHeader('src/math.ts', 'add')).toBe('src/math.ts add');
    expect(prepareSnippet(c!)).toEqual({
      path: 'src/math.ts',
      startLine: 3,
      endLine: 5,
      content: 'export function add(a: number, b: number) {\n  return a + b;\n}',
    });
  });

  it('无 symbol:标题行只有 path', async () => {
    const [c] = await realChunks('src/math.ts', SRC, [{ symbol: null, startLine: 7, endLine: 7 }]);
    expect(c!.content).toBe('src/math.ts\nconst top = 1;');
    expect(prepareSnippet(c!)).toEqual({
      path: 'src/math.ts',
      startLine: 7,
      endLine: 7,
      content: 'const top = 1;',
    });
  });

  it('超过 4000 字符被截断:丢掉可能不完整的最后一行,endLine = startLine + 行数 - 2', async () => {
    const big = Array.from({ length: 300 }, (_, i) => `const v${i} = '${'x'.repeat(20)}';`).join(
      '\n',
    );
    const [c] = await realChunks('src/big.ts', big, [
      { symbol: 'big', startLine: 1, endLine: 300 },
    ]);
    expect(c!.content.length).toBe(MAX_CHUNK_CHARS);
    const codeLines = c!.content.split('\n').slice(1);
    expect(codeLines.length).toBeLessThan(300);
    const sn = prepareSnippet(c!)!;
    expect(sn.startLine).toBe(1);
    expect(sn.endLine).toBe(1 + codeLines.length - 2);
    expect(sn.content.split('\n')).toEqual(codeLines.slice(0, -1));
    // 保留的每一行都是完整源码行
    const srcLines = big.split('\n');
    sn.content.split('\n').forEach((l, i) => expect(l).toBe(srcLines[i]));
    expect(citationWithinSnippet({ startLine: 1, endLine: sn.endLine }, sn)).toBe(true);
    expect(citationWithinSnippet({ startLine: 1, endLine: sn.endLine + 1 }, sn)).toBe(false);
  });

  it('截断恰好落在最后一行内(行数相等但达到上限)也去掉最后一行', async () => {
    const line = 'y'.repeat(5000);
    const [c] = await realChunks('src/one.ts', `${line}`, [
      { symbol: null, startLine: 1, endLine: 1 },
    ]);
    expect(c!.content.length).toBe(MAX_CHUNK_CHARS);
    expect(prepareSnippet(c!)).toBeNull();
  });

  it('hash 不一致、标题不符、行数多于区间、非法区间:丢弃', async () => {
    const [c] = await realChunks('src/math.ts', SRC, [{ symbol: 'add', startLine: 3, endLine: 5 }]);
    expect(prepareSnippet({ ...c!, contentHash: contentSha256('other') })).toBeNull();
    // 标题与 path/symbol 对不上(内容本身 hash 正确)
    expect(prepareSnippet({ ...c!, symbol: 'sub' })).toBeNull();
    expect(prepareSnippet({ ...c!, symbol: null })).toBeNull();
    expect(prepareSnippet({ ...c!, path: 'src/other.ts' })).toBeNull();
    // 无标题行
    const noHeader = 'export function add() {}';
    expect(
      prepareSnippet({
        ...c!,
        content: noHeader,
        contentHash: contentSha256(noHeader),
        startLine: 1,
        endLine: 1,
      }),
    ).toBeNull();
    expect(prepareSnippet({ ...c!, endLine: 4 })).toBeNull();
    expect(prepareSnippet({ ...c!, startLine: 0 })).toBeNull();
    expect(prepareSnippet({ ...c!, startLine: 6, endLine: 5 })).toBeNull();
  });
  it('citationWithinSnippet:必须完全落在片段内', () => {
    const sn = { startLine: 10, endLine: 20 };
    expect(citationWithinSnippet({ startLine: 10, endLine: 20 }, sn)).toBe(true);
    expect(citationWithinSnippet({ startLine: 12, endLine: 15 }, sn)).toBe(true);
    expect(citationWithinSnippet({ startLine: 9, endLine: 12 }, sn)).toBe(false);
    expect(citationWithinSnippet({ startLine: 18, endLine: 21 }, sn)).toBe(false);
    expect(citationWithinSnippet({ startLine: 15, endLine: 14 }, sn)).toBe(false);
  });
});
