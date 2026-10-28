import type { GraphEdge, GraphNode } from '@repolens/shared';

/** 图页的折叠/展开状态。纯 reducer,便于单测;后续可平移到 FRONTEND_DESIGN.md §7.1 的 Zustand store 切片 */
export type GraphState = {
  /** 已加载的节点(按 parentId 逐层懒加载累积) */
  nodes: GraphNode[];
  /** 已加载的原始边 */
  edges: GraphEdge[];
  /** 已经请求过子节点的 parentId */
  loaded: Set<string>;
  expanded: Set<string>;
  includeExternal: boolean;
};

export type GraphAction =
  | { type: 'init'; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'childrenLoaded'; parentId: string; nodes: GraphNode[] }
  | { type: 'expand'; id: string }
  | { type: 'collapse'; id: string }
  | { type: 'collapseAll' }
  | { type: 'toggleExternal' };

export const initialGraphState: GraphState = {
  nodes: [],
  edges: [],
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
        loaded: new Set(),
        expanded: new Set(),
      };
    case 'childrenLoaded': {
      const known = new Set(state.nodes.map((n) => n.id));
      const add = action.nodes.filter((n) => !known.has(n.id));
      return {
        ...state,
        nodes: [...state.nodes, ...add],
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
