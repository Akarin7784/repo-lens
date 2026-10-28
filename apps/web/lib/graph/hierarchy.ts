import type { GraphData, GraphEdge, GraphNode, ImportKind } from '@repolens/shared';
import { externalId, GraphDataSchema, MAX_NODES_PER_RESPONSE } from '@repolens/shared';

/** 一次 parentId 切片的结果,形状与 GET /api/repos/:id/graph?parentId= 一致 */
export type GraphSlice = GraphData;

export class SliceTooLargeError extends Error {
  constructor(
    readonly parentId: string | null,
    readonly count: number,
  ) {
    super(
      `单次返回节点数 ${count} 超过上限 ${MAX_NODES_PER_RESPONSE}(parentId=${parentId ?? 'null'})`,
    );
  }
}

/** 前端对单次返回的约束检查:超过 300 直接报错,不静默截断(由调用方提示用户) */
export function assertSliceSize(parentId: string | null, nodes: readonly unknown[]): void {
  if (nodes.length > MAX_NODES_PER_RESPONSE) throw new SliceTooLargeError(parentId, nodes.length);
}

export function childrenOf(nodes: readonly GraphNode[], parentId: string | null): GraphNode[] {
  return nodes.filter((n) => n.type !== 'external' && n.parentId === parentId);
}

/**
 * 用完整 fixture 模拟 `GET /graph?parentId=`:返回直接子节点,以及两端都落在本次返回范围内的
 * (上卷后的)边。结果用 shared 的 GraphDataSchema 校验,超过 300 节点抛 SliceTooLargeError。
 */
export function sliceGraph(full: GraphData, parentId: string | null): GraphSlice {
  const nodes = childrenOf(full.nodes, parentId);
  assertSliceSize(parentId, nodes);
  const byId = indexById(full.nodes);
  const inSlice = new Set(nodes.map((n) => n.id));
  const lift = (id: string): string | null => {
    let cur = byId.get(id);
    while (cur) {
      if (inSlice.has(cur.id)) return cur.id;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return null;
  };
  const edges = aggregateEdges(full.edges, lift);
  return GraphDataSchema.parse({ nodes, edges, meta: { ...full.meta, parentId } });
}

export function indexById(nodes: readonly GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/**
 * 可见性:module 总是可见;其余节点要求所有祖先都已展开。
 * `visibleAncestor` 返回自身或最近的可见祖先(折叠状态下边要上卷到这里)。
 */
export function makeVisibility(
  nodes: readonly GraphNode[],
  expanded: ReadonlySet<string>,
  /** 尚未加载的节点的父节点查询(fixture 模式由 GraphSource 提供),让指向未加载文件的原始边也能上卷 */
  parentOf?: (id: string) => string | null | undefined,
) {
  const byId = indexById(nodes);
  const visibleCache = new Map<string, boolean>();
  const isVisible = (id: string): boolean => {
    const hit = visibleCache.get(id);
    if (hit !== undefined) return hit;
    const n = byId.get(id);
    let v = false;
    if (n) v = n.parentId === null ? true : expanded.has(n.parentId) && isVisible(n.parentId);
    visibleCache.set(id, v);
    return v;
  };
  const visibleAncestor = (id: string): string | null => {
    let cur: string | null | undefined = id;
    while (cur) {
      if (isVisible(cur)) return cur;
      const n = byId.get(cur);
      cur = n ? n.parentId : parentOf?.(cur);
    }
    return null;
  };
  return { isVisible, visibleAncestor, byId };
}

/**
 * 把 file→file 原始边上卷到可见祖先之间(规则同 ARCHITECTURE.md §5.2 的派生聚合边):
 * - 两端都没被上卷 → 原样保留(aggregated 不设)
 * - 任一端被上卷 → 合并为一条 aggregated:true 的边,weight 累加,kind 取出现最多的一种,
 *   srcFileId 保留第一条被聚合边的源文件作代表
 * - 上卷后两端相同(内部边)→ 不画
 */
export function aggregateEdges(
  raw: readonly GraphEdge[],
  lift: (id: string) => string | null,
): GraphEdge[] {
  type Acc = {
    source: string;
    target: string;
    weight: number;
    kinds: Map<ImportKind, number>;
    srcFileId: GraphEdge['srcFileId'];
    lifted: boolean;
    first: GraphEdge;
  };
  const acc = new Map<string, Acc>();
  for (const e of raw) {
    const s = lift(e.source);
    const t = lift(e.target);
    if (!s || !t || s === t) continue;
    const lifted = s !== e.source || t !== e.target || e.aggregated === true;
    const key = lifted ? `${s}->${t}` : `raw:${e.id}`;
    const cur = acc.get(key) ?? {
      source: s,
      target: t,
      weight: 0,
      kinds: new Map(),
      srcFileId: e.srcFileId,
      lifted,
      first: e,
    };
    cur.weight += e.weight;
    cur.kinds.set(e.kind, (cur.kinds.get(e.kind) ?? 0) + e.weight);
    acc.set(key, cur);
  }
  const out: GraphEdge[] = [];
  for (const [key, a] of acc) {
    if (!a.lifted) {
      out.push(a.first);
      continue;
    }
    let kind: ImportKind = a.first.kind;
    let best = -1;
    for (const [k, c] of a.kinds) if (c > best) [kind, best] = [k, c];
    out.push({
      id: `agg:${key}`,
      source: a.source as GraphEdge['source'],
      target: a.target as GraphEdge['target'],
      type: 'imports',
      kind,
      srcFileId: a.srcFileId,
      weight: a.weight,
      aggregated: true,
    });
  }
  return out;
}

/** 派生 x: 外部节点和边(仅 includeExternal=true 时调用),来源是可见 file 的 externalDeps */
export function deriveExternal(
  files: readonly GraphNode[],
  lift: (id: string) => string | null,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const counts = new Map<
    string,
    { source: string; target: string; weight: number; srcFileId: GraphEdge['srcFileId'] }
  >();
  for (const f of files) {
    if (f.type !== 'file' || !f.externalDeps) continue;
    const s = lift(f.id);
    if (!s) continue;
    for (const pkg of f.externalDeps) {
      const xid = externalId(pkg) as GraphEdge['target'];
      if (!nodes.has(xid))
        nodes.set(xid, { id: xid, type: 'external', parentId: null, label: pkg, path: pkg });
      const key = `${s}->${xid}`;
      const cur = counts.get(key) ?? { source: s, target: xid, weight: 0, srcFileId: f.id };
      cur.weight += 1;
      counts.set(key, cur);
    }
  }
  const edges: GraphEdge[] = [...counts.entries()].map(([key, c]) => ({
    id: `ext:${key}`,
    source: c.source as GraphEdge['source'],
    target: c.target as GraphEdge['target'],
    type: 'imports',
    kind: 'static',
    srcFileId: c.srcFileId,
    weight: c.weight,
    ...(c.source !== c.srcFileId ? { aggregated: true } : {}),
  }));
  return { nodes: [...nodes.values()], edges };
}

/** 子节点数(用于卡片徽标与「可展开」判断) */
export function countChildren(nodes: readonly GraphNode[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of nodes) if (n.parentId) m.set(n.parentId, (m.get(n.parentId) ?? 0) + 1);
  return m;
}
