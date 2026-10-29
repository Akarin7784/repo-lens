import { createHash } from 'node:crypto';
import type { Embedder } from './embedder.js';
import type { CodeChunkRecord } from './chunks.js';
import { pointId, type VectorStore } from './vector-store.js';

export interface IndexResult {
  chunks: number;
  /** true:该 commit 已有完整索引,直接复用,没有调用 embedding */
  reused: boolean;
  /** 本次切块内容的 hash 汇总,写进 task.stats.embeddingDigest,下次据此判断能否复用 */
  digest: string;
}

/** 切块内容 hash 汇总:模型 + 每块(路径、行区间、符号、内容 hash),排序后整体 sha256 */
export function chunksDigest(model: string, chunks: CodeChunkRecord[]): string {
  const lines = chunks
    .map((c) => `${c.path}\n${c.startLine}-${c.endLine}\n${c.symbol ?? ''}\n${c.contentHash}`)
    .sort();
  return createHash('sha256').update(model).update('\n').update(lines.join('\n')).digest('hex');
}

/**
 * 把切块写入向量库。同一 (repo, commit) 的 point 数等于切块数、且上次记录的内容 hash 汇总
 * (prevDigest)与本次一致时视为已完整索引,直接复用(排除规则变化但块数相同不会误判);
 * 否则(首次或上次中途失败)先删掉该 commit 的旧 point 再按 batchSize 分批 embedding 写入。
 */
export async function indexChunks(
  o: {
    repoId: number;
    commitSha: string;
    chunks: CodeChunkRecord[];
    batchSize: number;
    prevDigest?: string | null;
  },
  embedder: Embedder,
  store: VectorStore,
  onProgress?: (done: number, total: number) => Promise<void> | void,
  /** 持锁时传入:删除与每批写入前校验仍持锁,失锁抛错中止,不再写 */
  beforeWrite?: () => Promise<void>,
): Promise<IndexResult> {
  const { repoId, commitSha, chunks, batchSize } = o;
  const digest = chunksDigest(embedder.model, chunks);
  await store.ensureCollection();
  const have = await store.count(repoId, commitSha);
  if (have === chunks.length && have > 0 && o.prevDigest === digest)
    return { chunks: have, reused: true, digest };
  if (have > 0) {
    await beforeWrite?.();
    await store.deleteCommit(repoId, commitSha);
  }
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const vecs = await embedder.embedDocuments(batch.map((c) => c.text));
    await beforeWrite?.();
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
  return { chunks: chunks.length, reused: false, digest };
}
