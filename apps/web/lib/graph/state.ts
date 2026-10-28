import type { GraphEdge, GraphNode } from '@repolens/shared';

/** 图页的折叠/展开状态。纯 reducer,便于单测;后续可平移到 FRONTEND_DESIGN.md §7.1 的 Zustand store 切片 */
export type GraphState = {
  /** 已加载的节点(按 parentId 逐层懒加载累积) */
  nodes: GraphNode[];
  /** 已加载的边:fixture 为全部原始边;真实接口为各层切片返回的边(按 id 去重累积) */
  edges: GraphEdge[];
  /** 各层切片 meta.cycles 的并集(强连通分量,成员为该层可见节点 id) */
  cycles: string[][];
  /** 真实接口:边 id → 返回它的层(根层 null)。fixture 为空 */
  edgeLayer: Map<string, string | null>;
  /** 子节点被截断的层(x-graph-truncated: true),根层记为 '' */
  truncated: Set<string>;
  /** 已经请求过子节点的 parentId */
  loaded: Set<string>;
  expanded: Set<string>;
  includeExternal: boolean;
};

export type GraphAction =
  | {
      type: 'init';
      nodes: GraphNode[];
      edges: GraphEdge[];
      cycles?: string[][];
      /** 真实接口:记录边所属层 */
      layered?: boolean;
      truncated?: boolean;
    }
  | {
      type: 'childrenLoaded';
      parentId: string;
      nodes: GraphNode[];
      edges?: GraphEdge[];
      cycles?: string[][];
      truncated?: boolean;
    }
  | { type: 'expand'; id: string }
  | { type: 'collapse'; id: string }
  | { type: 'collapseAll' }
  | { type: 'toggleExternal' };

export const initialGraphState: GraphState = {
  nodes: [],
  edges: [],
  cycles: [],
  edgeLayer: new Map(),
  truncated: new Set(),
  loaded: new Set(),
  expanded: new Set(),
  includeExternal: false,
};

export function graphReducer(state: GraphState, action: GraphAction): GraphState {
  switch (action.type) {
    case 'init':
      return {
        ...initialGraphState,
        nodes: action.nodes,
        edges: action.edges,
        cycles: mergeCycles([], action.cycles),
        edgeLayer: new Map(action.layered ? action.edges.map((e) => [e.id, null] as const) : []),
        truncated: action.truncated ? new Set(['']) : new Set(),
        loaded: new Set(),
        expanded: new Set(),
      };
    case 'childrenLoaded': {
      const known = new Set(state.nodes.map((n) => n.id));
      // 边界节点(聚合边外端,node.parentId !== 请求的 parentId,见 #12)只是已存在节点的占位:
      // 不作为本层子节点加入,也就不会被渲染进容器、不会在折叠时被当成子孙处理
      const add = action.nodes.filter((n) => n.parentId === action.parentId && !known.has(n.id));
      const knownEdges = new Set(state.edges.map((e) => e.id));
      const addEdges = (action.edges ?? []).filter((e) => !knownEdges.has(e.id));
      return {
        ...state,
        nodes: [...state.nodes, ...add],
        edges: addEdges.length ? [...state.edges, ...addEdges] : state.edges,
        cycles: mergeCycles(state.cycles, action.cycles),
        edgeLayer: addEdges.length
          ? new Map([...state.edgeLayer, ...addEdges.map((e) => [e.id, action.parentId] as const)])
          : state.edgeLayer,
        truncated: action.truncated
          ? new Set(state.truncated).add(action.parentId)
          : state.truncated,
        loaded: new Set(state.loaded).add(action.parentId),
      };
    }
    case 'expand':
      return state.expanded.has(action.id)
        ? state
        : { ...state, expanded: new Set(state.expanded).add(action.id) };
    case 'collapse': {
      // 收起时连同已展开的子孙一起收起,再次展开回到「只看直接子节点」的状态
      const byParent = new Map<string, string[]>();
      for (const n of state.nodes)
        if (n.parentId) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n.id]);
      const next = new Set(state.expanded);
      const stack = [action.id];
      while (stack.length) {
        const id = stack.pop()!;
        next.delete(id);
        stack.push(...(byParent.get(id) ?? []));
      }
      return { ...state, expanded: next };
    }
    case 'collapseAll':
      return { ...state, expanded: new Set() };
    case 'toggleExternal':
      return { ...state, includeExternal: !state.includeExternal };
  }
}

/** 合并环列表,按排序后的成员去重 */
export function mergeCycles(
  base: readonly string[][],
  add: readonly (readonly string[])[] | undefined,
): string[][] {
  if (!add?.length) return base as string[][];
  const key = (c: readonly string[]) => [...c].sort().join('|');
  const seen = new Set(base.map(key));
  const out = [...base];
  for (const c of add)
    if (!seen.has(key(c))) {
      seen.add(key(c));
      out.push([...c]);
    }
  return out;
}
