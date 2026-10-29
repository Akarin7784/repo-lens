/**
 * T-214 混合检索:向量(Qdrant)+ 关键词(进程内 BM25)+ 精确匹配(标识符 / 路径),RRF 融合。
 * 向量不可用(embeddingStatus 非 ready/reused、未配置、或查询出错)时只用关键词 + 精确匹配,
 * 返回 retrieval: 'keyword-only',不抛错。关键词打分不走 MySQL FULLTEXT(MariaDB 无 ngram 解析器)。
 */
import type { Embedder } from './embedder.js';
import type { VectorStore } from './vector-store.js';

export type RetrievalMode = 'hybrid' | 'keyword-only';

export interface RetrievableChunk {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  qdrantPointId: string;
}

export interface RetrievalHit {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  score: number;
  /** 命中来源(调试/评测用) */
  sources: ('vector' | 'keyword' | 'exact')[];
}

export interface RetrievalResult {
  retrieval: RetrievalMode;
  hits: RetrievalHit[];
  /** 降级原因(keyword-only 时):status / no-vector-store / vector-error */
  degradedReason?: string;
}

/** RRF 常数(Cormack et al. 2009 的经验值) */
export const RRF_K = 60;

const STOP = new Set(
  'the a an of to in on for and or is are be by with from at as it this that which what where how does do file files code function functions defined define implemented implement handle handled handling used use'.split(
    ' ',
  ),
);

/** camelCase / snake / 路径拆词,小写;保留原整词(便于精确匹配) */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+/g) ?? []) {
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_$]+/)
      .filter(Boolean);
    for (const p of parts) {
      const w = p.toLowerCase();
      if (w.length >= 2 && !STOP.has(w)) out.push(w);
    }
    const whole = raw.toLowerCase();
    if (parts.length > 1 && whole.length >= 3) out.push(whole);
  }
  return out;
}

/** 轻量词干:去掉常见英文后缀,让 routes/routing/router 对上 */
export function stem(w: string): string {
  return w.replace(/(ings?|ers?|ed|es|s)$/, '') || w;
}

const terms = (text: string) => tokenize(text).map(stem);

export interface KeywordIndex {
  docs: { tf: Map<string, number>; len: number }[];
  df: Map<string, number>;
  avgLen: number;
}

/** 路径与符号权重高于正文:路径/符号词重复计入 3 次 */
export function buildKeywordIndex(chunks: RetrievableChunk[]): KeywordIndex {
  const df = new Map<string, number>();
  let total = 0;
  const docs = chunks.map((c) => {
    const head = `${c.path} ${c.symbol ?? ''}`;
    const ts = [...terms(head), ...terms(head), ...terms(head), ...terms(c.content)];
    const tf = new Map<string, number>();
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    total += ts.length;
    return { tf, len: ts.length };
  });
  return { docs, df, avgLen: docs.length ? total / docs.length : 0 };
}

/** BM25(k1=1.2, b=0.75);返回按分数降序的 [下标, 分数] */
export function bm25(idx: KeywordIndex, query: string, limit: number): [number, number][] {
  const q = [...new Set(terms(query))];
  const N = idx.docs.length;
  const scored: [number, number][] = [];
  idx.docs.forEach((d, i) => {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = idx.df.get(t)!;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += (idf * f * 2.2) / (f + 1.2 * (1 - 0.75 + (0.75 * d.len) / (idx.avgLen || 1)));
    }
    if (s > 0) scored.push([i, s]);
  });
  return scored.sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/** 精确匹配:问题里出现的标识符等于块符号,或像路径/文件名的词出现在块路径里 */
export function exactMatches(chunks: RetrievableChunk[], query: string, limit: number): number[] {
  const idents = new Set(
    (query.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []).filter(
      (w) => /[A-Z_$]/.test(w.slice(1)) || /[a-z][A-Z]/.test(w),
    ),
  );
  const pathish = (
    query.match(/[\w./-]+\.(?:[jt]sx?|mjs|cjs|json|md)\b|[\w-]+\/[\w./-]+/g) ?? []
  ).map((p) => p.toLowerCase());
  const out: number[] = [];
  chunks.forEach((c, i) => {
    const sym = c.symbol ?? '';
    if ((sym && idents.has(sym)) || pathish.some((p) => c.path.toLowerCase().includes(p)))
      out.push(i);
  });
  return out.slice(0, limit);
}

/** RRF:每个列表贡献 1/(k + rank),rank 从 1 起 */
export function rrf(lists: string[][], k = RRF_K): Map<string, number> {
  const s = new Map<string, number>();
  for (const l of lists) l.forEach((id, r) => s.set(id, (s.get(id) ?? 0) + 1 / (k + r + 1)));
  return s;
}

export interface HybridSearchInput {
  repoId: number;
  commitSha: string;
  /** 原问题 */
  question: string;
  /** 改写后的英文检索词;改写失败时等于原问题 */
  rewritten: string;
  chunks: RetrievableChunk[];
  /** task.stats.embeddingStatus;只有 ready / reused 才查向量 */
  embeddingStatus: string | null | undefined;
  embedder?: Embedder | null;
  vectorStore?: VectorStore | null;
  limit?: number;
  /** 每路候选数 */
  candidates?: number;
}

export async function hybridSearch(o: HybridSearchInput): Promise<RetrievalResult> {
  const limit = o.limit ?? 5;
  const cand = o.candidates ?? 50;
  const idOf = (i: number) => o.chunks[i]!.qdrantPointId;
  const byId = new Map(o.chunks.map((c) => [c.qdrantPointId, c]));
  const kwQuery = o.rewritten === o.question ? o.question : `${o.rewritten} ${o.question}`;
  const idx = buildKeywordIndex(o.chunks);
  const keyword = bm25(idx, kwQuery, cand).map(([i]) => idOf(i));
  const exact = exactMatches(o.chunks, kwQuery, cand).map(idOf);

  let vector: string[] | null = null;
  let degradedReason: string | undefined;
  if (o.embeddingStatus !== 'ready' && o.embeddingStatus !== 'reused')
    degradedReason = `status:${o.embeddingStatus ?? 'none'}`;
  else if (!o.embedder || !o.vectorStore) degradedReason = 'no-vector-store';
  else {
    try {
      const v = await o.embedder.embedQuery(o.rewritten);
      const hits = await o.vectorStore.search(o.repoId, o.commitSha, v, cand);
      vector = hits.map((h) => h.id).filter((id) => byId.has(id));
    } catch {
      degradedReason = 'vector-error';
    }
  }
  const lists: [RetrievalHit['sources'][number], string[]][] = [
    ['keyword', keyword],
    ['exact', exact],
  ];
  if (vector) lists.unshift(['vector', vector]);
  const fused = rrf(lists.map((l) => l[1]));
  const hits = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => {
      const c = byId.get(id)!;
      return {
        path: c.path,
        symbol: c.symbol,
        startLine: c.startLine,
        endLine: c.endLine,
        score,
        sources: lists.filter((l) => l[1].includes(id)).map((l) => l[0]),
      };
    });
  return vector
    ? { retrieval: 'hybrid', hits }
    : { retrieval: 'keyword-only', hits, degradedReason };
}
