// 仅测试用(tsconfig.build 已排除 *.fixture.ts),不进 dist
import { buildChunks, type ChunkSpan } from '@repolens/rag';
import type { StoredChunk } from './chunk-guard.js';

/** 用 rag buildChunks 的真实输出构造 code_chunk 行(与 worker 写库口径一致:content = c.text) */
export async function realChunks(
  path: string,
  src: string,
  spans: ChunkSpan[],
): Promise<StoredChunk[]> {
  const { chunks } = await buildChunks([{ path, chunks: spans }], async () => src);
  return chunks.map((c) => ({
    path: c.path,
    symbol: c.symbol,
    startLine: c.startLine,
    endLine: c.endLine,
    content: c.text,
    contentHash: c.contentHash,
  }));
}
