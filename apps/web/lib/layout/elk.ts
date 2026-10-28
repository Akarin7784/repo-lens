import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { GraphEdge, GraphNode } from '@repolens/shared';

/** 各层节点尺寸:三层靠形状和尺寸区分(DESIGN_STYLE.md 图节点约定) */
export const NODE_SIZE = {
  module: { width: 232, height: 76 },
  dir: { width: 196, height: 46 },
  file: { width: 172, height: 30 },
  external: { width: 150, height: 28 },
} as const;
export const CONTAINER_PADDING = '[top=48,left=16,bottom=16,right=16]';

export type LayoutResult = {
  /** 相对父容器的坐标(与 React Flow 的 parentId 子节点坐标系一致) */
  positions: Map<string, { x: number; y: number }>;
  /** 展开后的容器尺寸 */
  sizes: Map<string, { width: number; height: number }>;
};

export interface LayoutEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}

/** 确定性 layered 布局;展开的 module/dir 作为容器,子节点在容器内布局 */
export const ROOT_LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.edgeRouting': 'ORTHOGONAL',
};

export function toElkGraph(
  visible: readonly GraphNode[],
  edges: readonly GraphEdge[],
  expanded: ReadonlySet<string>,
): ElkNode {
  const elkById = new Map<string, ElkNode>();
  const root: ElkNode = { id: '__root__', layoutOptions: ROOT_LAYOUT_OPTIONS, children: [] };
  const visibleIds = new Set(visible.map((n) => n.id));
  for (const n of visible) {
    const isContainer = expanded.has(n.id) && visible.some((c) => c.parentId === n.id);
    const el: ElkNode = isContainer
      ? { id: n.id, children: [], layoutOptions: { 'elk.padding': CONTAINER_PADDING } }
      : { id: n.id, ...NODE_SIZE[n.type] };
    elkById.set(n.id, el);
  }
  // 输入顺序固定(按 visible 顺序),保证同样输入得到同样坐标
  for (const n of visible) {
    const el = elkById.get(n.id)!;
    const parent = n.parentId && visibleIds.has(n.parentId) ? elkById.get(n.parentId) : undefined;
    (parent?.children ?? root.children!).push(el);
  }
  root.edges = edges.map<ElkExtendedEdge>((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));
  return root;
}

export function readLayout(result: ElkNode): LayoutResult {
  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { width: number; height: number }>();
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      positions.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
      if (c.children && c.children.length)
        sizes.set(c.id, { width: c.width ?? 0, height: c.height ?? 0 });
      walk(c);
    }
  };
  walk(result);
  return { positions, sizes };
}

/** 浏览器里在 web worker 中跑 elkjs,不阻塞主线程;没有 Worker(SSR/测试)时退回同线程 bundled 版本 */
export async function createDefaultEngine(): Promise<LayoutEngine> {
  if (typeof Worker !== 'undefined') {
    const worker = new Worker(new URL('./elk.worker.ts', import.meta.url));
    let seq = 0;
    const pending = new Map<
      number,
      { resolve: (n: ElkNode) => void; reject: (e: Error) => void }
    >();
    worker.onmessage = (ev: MessageEvent<{ id: number; result?: ElkNode; error?: string }>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (ev.data.result) p.resolve(ev.data.result);
      else p.reject(new Error(ev.data.error ?? 'elk worker error'));
    };
    return {
      layout: (graph) =>
        new Promise<ElkNode>((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, graph });
        }),
    };
  }
  return createInlineEngine();
}

/** 同线程 elkjs(测试与无 Worker 环境) */
export async function createInlineEngine(): Promise<LayoutEngine> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { layout: (g) => elk.layout(g) };
}
