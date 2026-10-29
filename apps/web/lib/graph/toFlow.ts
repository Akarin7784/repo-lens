import type { Edge, Node } from '@xyflow/react';
import type { GraphEdge, GraphNode } from '@repolens/shared';
import { NODE_SIZE, type LayoutResult } from '../layout/elk';

export type RepoNodeData = {
  node: GraphNode;
  expanded: boolean;
  /** 已知的直接子节点数;未加载时为 undefined */
  childCount: number | undefined;
  isContainer: boolean;
  /** 选中节点或其一跳邻居 */
  highlighted?: boolean;
};
export type RepoFlowNode = Node<RepoNodeData, GraphNode['type']>;
export type RepoEdgeData = {
  weight: number;
  aggregated: boolean;
  kind: GraphEdge['kind'];
  /** 有选中节点时:与之相连为 on,否则 dim;无选中为 undefined */
  highlight?: 'on' | 'dim';
  /** 环边:只来自 edge.inCycle === true(T-203 起不再读 meta.cycles) */
  cycle?: boolean;
};
export type RepoFlowEdge = Edge<RepoEdgeData, 'weighted'>;

/** 聚合边线宽:1 + 1.5·log2(weight),上限 8px(FRONTEND_DESIGN.md §8);原始边固定 1.25px */
export function edgeWidth(weight: number, aggregated: boolean): number {
  if (!aggregated) return 1.25;
  return Math.min(8, 1 + 1.5 * Math.log2(Math.max(1, weight)));
}

/**
 * GraphData(+ 布局结果)→ React Flow 节点/边。
 * 展开的 module/dir 渲染成容器(React Flow 子流程:子节点 parentId 指向容器,坐标相对容器);
 * 节点顺序保证父在子前(React Flow 的要求)。
 */
export function toFlow(
  visible: readonly GraphNode[],
  edges: readonly GraphEdge[],
  layout: LayoutResult,
  expanded: ReadonlySet<string>,
  childCounts: ReadonlyMap<string, number>,
  cycleKeys: ReadonlySet<string> = new Set(),
): { nodes: RepoFlowNode[]; edges: RepoFlowEdge[] } {
  const visibleIds = new Set(visible.map((n) => n.id));
  const placed = new Set<string>();
  const ordered: GraphNode[] = [];
  const byId = new Map(visible.map((n) => [n.id, n]));
  const place = (n: GraphNode) => {
    if (placed.has(n.id)) return;
    if (n.parentId && visibleIds.has(n.parentId)) place(byId.get(n.parentId)!);
    placed.add(n.id);
    ordered.push(n);
  };
  visible.forEach(place);

  const nodes = ordered.map<RepoFlowNode>((n) => {
    const size = layout.sizes.get(n.id);
    const isContainer = size !== undefined;
    const { width, height } = size ?? NODE_SIZE[n.type];
    const parent = n.parentId && visibleIds.has(n.parentId) ? n.parentId : undefined;
    return {
      id: n.id,
      type: n.type,
      position: layout.positions.get(n.id) ?? { x: 0, y: 0 },
      ...(parent ? { parentId: parent } : {}),
      width,
      height,
      draggable: false,
      connectable: false,
      zIndex: isContainer ? 0 : 1,
      data: {
        node: n,
        expanded: expanded.has(n.id),
        childCount: childCounts.get(n.id),
        isContainer,
      },
    };
  });
  const flowEdges = edges.map<RepoFlowEdge>((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'weighted',
    zIndex: 2,
    data: {
      weight: e.weight,
      aggregated: e.aggregated === true,
      kind: e.kind,
      cycle: cycleKeys.has(`${e.source}->${e.target}`),
    },
  }));
  return { nodes, edges: flowEdges };
}
