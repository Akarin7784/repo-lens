import { createHash } from 'node:crypto';

/** 与 worker 写 code_chunk.content_hash 口径一致:sha256(content),不做换行/尾空白归一化 */
export function contentSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 片段 content 与索引时记录的 content_hash 是否一致;不一致的片段不进 prompt、不可被引用 */
export function chunkMatchesHash(content: string, contentHash: string): boolean {
  return contentSha256(content) === contentHash;
}

/**
 * 片段自身行号是否合法:startLine≥1、endLine≥startLine、行数与 content 分行数一致。
 * 不合法的片段不进 prompt。
 */
export function snippetSpanValid(c: {
  startLine: number;
  endLine: number;
  content: string;
}): boolean {
  if (c.startLine < 1 || c.endLine < c.startLine) return false;
  return c.endLine - c.startLine + 1 === c.content.split('\n').length;
}

/**
 * 下发前的行号区间断言:citation 必须完全落在片段 [startLine,endLine] 内。
 * 不满足则丢掉并计入 dropped(防 CitationStream.validate 以后被改坏)。
 */
export function citationWithinSnippet(
  c: { startLine: number; endLine: number },
  sn: { startLine: number; endLine: number },
): boolean {
  return sn.startLine <= c.startLine && c.startLine <= c.endLine && c.endLine <= sn.endLine;
}
