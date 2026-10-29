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
 * 与 `@repolens/rag` 的 MAX_CHUNK_CHARS 一致(测试里断言相等):worker 写入的 content 是
 * `${path}[ ${symbol}]\n${code}` 再 slice(0, 4000),长度达到上限即视为可能被截断。
 */
export const CHUNK_TEXT_MAX_CHARS = 4000;

/** code_chunk 行(content 为 worker 写入的原文 c.text,含标题行,可能被截断) */
export interface StoredChunk {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
}

/** 可进 prompt 的片段:content 只含代码(已剥标题),[startLine,endLine] 为有效区间 */
export interface PreparedSnippet {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

/** 标题行,与 rag buildChunks 的拼法一致:`${path}${symbol ? ` ${symbol}` : ''}` */
export function chunkHeader(path: string, symbol: string | null): string {
  return `${path}${symbol ? ` ${symbol}` : ''}`;
}

/**
 * 把 code_chunk 原文转成可进 prompt 的片段;任何一步对不上返回 null(丢弃该片段):
 * 1. 对原始 content 做 hash 校验;
 * 2. 剥掉第一行,必须等于 `path[ symbol]`;
 * 3. 代码行数多于 endLine-startLine+1 → 不合法;少于、或原文达到截断上限 → 视为被截断,
 *    丢掉可能不完整的最后一行,有效 endLine = startLine + 行数 - 2;剩不下完整行则丢弃。
 */
export function prepareSnippet(c: StoredChunk): PreparedSnippet | null {
  if (c.startLine < 1 || c.endLine < c.startLine) return null;
  if (!chunkMatchesHash(c.content, c.contentHash)) return null;
  const nl = c.content.indexOf('\n');
  if (nl < 0) return null;
  if (c.content.slice(0, nl) !== chunkHeader(c.path, c.symbol)) return null;
  const lines = c.content.slice(nl + 1).split('\n');
  const expected = c.endLine - c.startLine + 1;
  if (lines.length > expected) return null;
  const truncated = lines.length < expected || c.content.length >= CHUNK_TEXT_MAX_CHARS;
  if (!truncated) {
    return { path: c.path, startLine: c.startLine, endLine: c.endLine, content: lines.join('\n') };
  }
  const kept = lines.slice(0, -1);
  if (kept.length === 0) return null;
  return {
    path: c.path,
    startLine: c.startLine,
    endLine: c.startLine + lines.length - 2,
    content: kept.join('\n'),
  };
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
