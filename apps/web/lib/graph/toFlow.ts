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

/**
 * 聚合边线宽:1 + 1.5·log2(weight),上限 AGG_WIDTH_MAX;原始边固定 1.25px(FRONTEND_DESIGN.md §8)。
 * T-220:聚合边线宽上限从 8 降到 5。hono 实测(d:src / middleware / jsx 三层 196 条聚合边)
 * 中位数 weight=1、p90=6、最大 29:上限 5 时 weight≥6 才封顶,1/2/4 仍有 1/2.5/4 的粗细差。
 */
export const AGG_WIDTH_MAX = 5;
export function edgeWidth(weight: number, aggregated: boolean): number {
  if (!aggregated) return 1.25;
  return Math.min(AGG_WIDTH_MAX, 1 + 1.5 * Math.log2(Math.max(1, weight)));
}

/** T-220:聚合边默认透明度(WEEK2_PLAN 默认约 0.3) */
export const AGG_EDGE_OPACITY_DEFAULT = 0.3;
/**
 * T-221:投影仪验收时可不改代码切换透明度:构建/启动时设 NEXT_PUBLIC_AGG_EDGE_OPACITY=0.4。
 * 只接受 (0,1] 的数,其它值回落到默认 0.3。
 */
export function parseAggOpacity(raw: string | undefined): number {
  const v = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : AGG_EDGE_OPACITY_DEFAULT;
}
export const AGG_EDGE_OPACITY = parseAggOpacity(process.env.NEXT_PUBLIC_AGG_EDGE_OPACITY);
/** T-220:zoom 低于此值时隐藏 ×N 标签(选中相关边、环边例外) */
export const WEIGHT_LABEL_MIN_ZOOM = 0.9;

/**
 * 边的透明度。优先级:dim(选中其它节点时)> 选中相关 / 环边(不调淡)> type-only > 聚合边调淡 > 普通边。
 */
export function edgeOpacity(d: {
  highlight?: 'on' | 'dim';
  cycle?: boolean;
  aggregated?: boolean;
  kind?: string;
}): number {
  if (d.highlight === 'dim') return 0.15;
  if (d.highlight === 'on' || d.cycle) return 0.9;
  if (d.kind === 'type-only') return 0.55;
  if (d.aggregated) return AGG_EDGE_OPACITY;
  return 0.9;
}

/** ×N 标签是否显示:只对 weight>1 的聚合边;dim 不显示;选中相关或环边始终显示;其余看 zoom 阈值 */
export function showWeightLabel(
  d: { highlight?: 'on' | 'dim'; cycle?: boolean; aggregated?: boolean; weight?: number },
  zoomedIn: boolean,
): boolean {
  if (!d.aggregated || (d.weight ?? 1) <= 1 || d.highlight === 'dim') return false;
  return d.highlight === 'on' || d.cycle === true || zoomedIn;
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
