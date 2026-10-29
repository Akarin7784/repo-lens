import { createHash } from 'node:crypto';
import { EMBEDDING_DIM } from './config.js';

export interface ChunkPayload {
  repo_id: number;
  commit_sha: string;
  path: string;
  symbol: string | null;
  start_line: number;
  end_line: number;
  content_hash: string;
}
export interface VectorPoint {
  id: string;
  vector: number[];
  payload: ChunkPayload;
}
export interface VectorHit {
  id: string;
  score: number;
  payload: ChunkPayload;
}

/** 向量库抽象(ARCHITECTURE §3:保留接口,默认 Qdrant) */
export interface VectorStore {
  ensureCollection(): Promise<void>;
  count(repoId: number, commitSha: string): Promise<number>;
  deleteCommit(repoId: number, commitSha: string): Promise<void>;
  upsert(points: VectorPoint[]): Promise<void>;
  search(repoId: number, commitSha: string, vector: number[], limit: number): Promise<VectorHit[]>;
}

/** point id:由 (repo, commit, path, 行区间, 符号) 确定性生成的 UUID,重跑同 commit 覆盖而不重复 */
export function pointId(
  repoId: number,
  commitSha: string,
  p: Omit<ChunkPayload, 'repo_id' | 'commit_sha' | 'content_hash'>,
) {
  const h = createHash('sha256')
    .update(`${repoId}\n${commitSha}\n${p.path}\n${p.start_line}-${p.end_line}\n${p.symbol ?? ''}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

export class MemoryVectorStore implements VectorStore {
  readonly points = new Map<string, VectorPoint>();
  async ensureCollection() {}
  private of(repoId: number, commitSha: string) {
    return [...this.points.values()].filter(
      (p) => p.payload.repo_id === repoId && p.payload.commit_sha === commitSha,
    );
  }
  async count(repoId: number, commitSha: string) {
    return this.of(repoId, commitSha).length;
  }
  async deleteCommit(repoId: number, commitSha: string) {
    for (const p of this.of(repoId, commitSha)) this.points.delete(p.id);
  }
  async upsert(points: VectorPoint[]) {
    for (const p of points) this.points.set(p.id, p);
  }
  async search(repoId: number, commitSha: string, vector: number[], limit: number) {
    return this.of(repoId, commitSha)
      .map((p) => ({ id: p.id, score: dot(p.vector, vector), payload: p.payload }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/**
 * Qdrant REST(BACKEND_AI_DESIGN §4:collection code_chunks,命名向量 dense,Cosine)。
 * 按 repo_id + commit_sha 过滤;两者与 path 建 payload index。api-key 只放请求头,不进日志。
 */
export class QdrantVectorStore implements VectorStore {
  constructor(
    private readonly o: { url: string; apiKey?: string; collection: string; dim?: number },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}
  private async req(method: string, path: string, body?: unknown, okStatus: number[] = []) {
    const res = await this.fetchFn(`${this.o.url.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.o.apiKey ? { 'api-key': this.o.apiKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok && !okStatus.includes(res.status))
      throw new Error(`Qdrant ${method} ${path.split('?')[0]} 返回 ${res.status}`);
    return res;
  }
  private get c() {
    return `/collections/${encodeURIComponent(this.o.collection)}`;
  }
  private filter(repoId: number, commitSha: string) {
    return {
      must: [
        { key: 'repo_id', match: { value: repoId } },
        { key: 'commit_sha', match: { value: commitSha } },
      ],
    };
  }
  async ensureCollection() {
    const r = await this.req('GET', this.c, undefined, [404]);
    if (r.status !== 404) return;
    await this.req('PUT', this.c, {
      vectors: { dense: { size: this.o.dim ?? EMBEDDING_DIM, distance: 'Cosine' } },
    });
    for (const [field_name, field_schema] of [
      ['repo_id', 'integer'],
      ['commit_sha', 'keyword'],
      ['path', 'keyword'],
    ])
      await this.req('PUT', `${this.c}/index?wait=true`, { field_name, field_schema });
  }
  async count(repoId: number, commitSha: string) {
    const r = await this.req('POST', `${this.c}/points/count`, {
      filter: this.filter(repoId, commitSha),
      exact: true,
    });
    return ((await r.json()) as { result: { count: number } }).result.count;
  }
  async deleteCommit(repoId: number, commitSha: string) {
    await this.req('POST', `${this.c}/points/delete?wait=true`, {
      filter: this.filter(repoId, commitSha),
    });
  }
  async upsert(points: VectorPoint[]) {
    if (!points.length) return;
    await this.req('PUT', `${this.c}/points?wait=true`, {
      points: points.map((p) => ({ id: p.id, vector: { dense: p.vector }, payload: p.payload })),
    });
  }
  async search(repoId: number, commitSha: string, vector: number[], limit: number) {
    const r = await this.req('POST', `${this.c}/points/search`, {
      vector: { name: 'dense', vector },
      filter: this.filter(repoId, commitSha),
      limit,
      with_payload: true,
    });
    const j = (await r.json()) as {
      result: { id: string; score: number; payload: ChunkPayload }[];
    };
    return j.result.map((h) => ({ id: String(h.id), score: h.score, payload: h.payload }));
  }
}
