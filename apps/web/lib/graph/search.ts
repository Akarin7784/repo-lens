import type { GraphNode } from '@repolens/shared';

/** 路径搜索命中(T-224) */
export type SearchHit = { id: string; path: string; type: GraphNode['type']; score: number };

/** 是否为 hay 的子序列(按字符顺序出现,可不连续) */
function isSubsequence(q: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < q.length; j++) if (hay[j] === q[i]) i++;
  return i === q.length;
}

/**
 * 单条路径的匹配分(0 = 不匹配)。路径末段(文件/目录名)优先:
 * 末段精确 > 末段前缀 > 末段包含 > 整路径包含 > 末段子序列 > 整路径子序列。
 * 查询含 `/` 时按整路径片段匹配(末段档位跳过)。大小写不敏感。
 */
export function matchScore(query: string, path: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf('/') + 1);
  const seg = !q.includes('/');
  if (seg && base === q) return 600;
  if (seg && base.startsWith(q)) return 500;
  if (seg && base.includes(q)) return 400;
  if (p.endsWith(q)) return 350;
  if (p.includes(q)) return 300;
  if (seg && isSubsequence(q, base)) return 200;
  if (isSubsequence(q, p)) return 100;
  return 0;
}

/**
 * 在已加载节点里按路径模糊搜索,返回前 limit 条。外部依赖(x:)不参与。
 * 同分时路径短的在前(层级浅、更可能是想要的),再按字典序,保证结果稳定。
 */
export function searchNodes(nodes: readonly GraphNode[], query: string, limit = 8): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.type === 'external' || seen.has(n.id)) continue;
    seen.add(n.id);
    const path = n.path;
    const score = matchScore(query, path);
    if (score > 0) hits.push({ id: n.id, path, type: n.type, score });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return hits.slice(0, limit);
}
