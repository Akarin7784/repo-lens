import type { RepoFlowEdge, RepoFlowNode } from './toFlow';

export type HighlightedView = {
  nodes: RepoFlowNode[];
  edges: RepoFlowEdge[];
  /** 选中节点的出边/入边条数(当前可见层级) */
  out: number;
  in: number;
};

/** 淡出的非邻居透明度(FRONTEND_DESIGN.md §5) */
export const DIM_OPACITY = 0.15;

/**
 * 单击选中:选中节点 + 一跳邻居保持不透明,相连边高亮,其余节点/边淡出。
 * 展开后的容器节点不淡出(否则其中的邻居会一起变淡)。
 */
export function highlightSelection(
  flow: { nodes: RepoFlowNode[]; edges: RepoFlowEdge[] },
  selectedId: string | null,
): HighlightedView {
  if (!selectedId || !flow.nodes.some((n) => n.id === selectedId))
    return { ...flow, out: 0, in: 0 };
  const near = new Set([selectedId]);
  let out = 0;
  let inn = 0;
  for (const e of flow.edges) {
    if (e.source === selectedId) {
      near.add(e.target);
      out++;
    }
    if (e.target === selectedId) {
      near.add(e.source);
      inn++;
    }
  }
  const nodes = flow.nodes.map((n) => {
    const dim = !near.has(n.id) && !n.data.isContainer;
    return {
      ...n,
      selected: n.id === selectedId,
      style: { ...n.style, opacity: dim ? DIM_OPACITY : 1 },
      data: { ...n.data, highlighted: near.has(n.id) },
    };
  });
  const edges = flow.edges.map((e) => {
    const hit = e.source === selectedId || e.target === selectedId;
    return { ...e, data: { ...e.data!, highlight: hit ? 'on' : 'dim' } as const };
  });
  return { nodes, edges, out, in: inn };
}
