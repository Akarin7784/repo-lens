import type { Embedder } from './embedder.js';
import type { CodeChunkRecord } from './chunks.js';
import { pointId, type VectorStore } from './vector-store.js';

export interface IndexResult {
  chunks: number;
  /** true:该 commit 已有完整索引,直接复用,没有调用 embedding */
  reused: boolean;
}

/**
 * 把切块写入向量库。同一 (repo, commit) 的 point 数等于切块数时视为已完整索引,直接复用;
 * 否则(首次或上次中途失败)先删掉该 commit 的旧 point 再按 batchSize 分批 embedding 写入。
 */
export async function indexChunks(
  o: { repoId: number; commitSha: string; chunks: CodeChunkRecord[]; batchSize: number },
  embedder: Embedder,
  store: VectorStore,
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<IndexResult> {
  const { repoId, commitSha, chunks, batchSize } = o;
  await store.ensureCollection();
  const have = await store.count(repoId, commitSha);
  if (have === chunks.length && have > 0) return { chunks: have, reused: true };
  if (have > 0) await store.deleteCommit(repoId, commitSha);
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const vecs = await embedder.embedDocuments(batch.map((c) => c.text));
    await store.upsert(
      batch.map((c, j) => {
        const payload = {
          repo_id: repoId,
          commit_sha: commitSha,
          path: c.path,
          symbol: c.symbol,
          start_line: c.startLine,
          end_line: c.endLine,
          content_hash: c.contentHash,
        };
        return { id: pointId(repoId, commitSha, payload), vector: vecs[j]!, payload };
      }),
    );
    await onProgress?.(Math.min(i + batchSize, chunks.length), chunks.length);
  }
  return { chunks: chunks.length, reused: false };
}
