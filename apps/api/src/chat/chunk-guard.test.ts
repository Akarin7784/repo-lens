import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  chunkMatchesHash,
  citationWithinSnippet,
  contentSha256,
  snippetSpanValid,
} from './chunk-guard.js';

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
  it('snippetSpanValid:行号与行数', () => {
    expect(snippetSpanValid({ startLine: 1, endLine: 1, content: 'x' })).toBe(true);
    expect(snippetSpanValid({ startLine: 10, endLine: 11, content: 'a\nb' })).toBe(true);
    expect(snippetSpanValid({ startLine: 0, endLine: 1, content: 'a\nb' })).toBe(false);
    expect(snippetSpanValid({ startLine: 2, endLine: 1, content: 'a' })).toBe(false);
    expect(snippetSpanValid({ startLine: 1, endLine: 2, content: 'only-one' })).toBe(false);
    expect(snippetSpanValid({ startLine: 1, endLine: 1, content: 'a\nb' })).toBe(false);
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
