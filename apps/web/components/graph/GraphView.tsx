'use client';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import {
  aggregateEdges,
  countChildren,
  deriveExternal,
  makeVisibility,
  SliceTooLargeError,
} from '../../lib/graph/hierarchy';
import { graphReducer, initialGraphState } from '../../lib/graph/state';
import type { GraphSource } from '../../lib/graph/source';
import { toFlow, type RepoFlowEdge, type RepoFlowNode } from '../../lib/graph/toFlow';
import { highlightSelection } from '../../lib/graph/selection';
import {
  createDefaultEngine,
  readLayout,
  toElkGraph,
  type LayoutEngine,
} from '../../lib/layout/elk';
import { loadLayoutFile, type LayoutFile } from '../../lib/layout/layoutFile';
import { edgeTypes } from './WeightedEdge';
import { nodeTypes } from './nodes';
import { ToggleContext } from './ToggleContext';

export type GraphViewProps = {
  source: GraphSource;
  owner: string;
  repo: string;
  /** 测试时注入同步布局引擎;默认走 web worker 里的 elkjs */
  engine?: LayoutEngine;
};

const defaultEdgeOptions = {
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--edge)' },
};

function Inner({ source, owner, repo, engine }: GraphViewProps) {
  const [state, dispatch] = useReducer(graphReducer, initialGraphState);
  const [flow, setFlow] = useState<{ nodes: RepoFlowNode[]; edges: RepoFlowEdge[] }>({
    nodes: [],
    edges: [],
  });
  const [status, setStatus] = useState<string>('加载中…');
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const engineRef = useRef<Promise<LayoutEngine> | null>(null);
  const layoutFile = useRef<LayoutFile | null>(null);
  const { fitView } = useReactFlow();

  useEffect(() => {
    let alive = true;
    Promise.all([source.loadChildren(null), loadLayoutFile(owner, repo, source.commitSha)]).then(
      ([slice, file]) => {
        if (!alive) return;
        layoutFile.current = file;
        dispatch({ type: 'init', nodes: slice.nodes, edges: source.rawEdges() });
      },
    );
    return () => {
      alive = false;
    };
  }, [source, owner, repo]);

  const toggle = useCallback(
    async (id: string) => {
      setError(null);
      if (state.expanded.has(id)) return dispatch({ type: 'collapse', id });
      if (!state.loaded.has(id)) {
        try {
          const slice = await source.loadChildren(id);
          dispatch({ type: 'childrenLoaded', parentId: id, nodes: slice.nodes });
        } catch (e) {
          setError(e instanceof SliceTooLargeError ? e.message : `加载 ${id} 失败`);
          return;
        }
      }
      dispatch({ type: 'expand', id });
    },
    [state.expanded, state.loaded, source],
  );

  const derived = useMemo(() => {
    const vis = makeVisibility(state.nodes, state.expanded, source.parentOf);
    const visible = state.nodes.filter((n) => vis.isVisible(n.id));
    let edges = aggregateEdges(state.edges, vis.visibleAncestor);
    let nodes = visible;
    if (state.includeExternal) {
      const files = state.nodes.filter((n) => n.type === 'file');
      const ext = deriveExternal(files, vis.visibleAncestor);
      nodes = [...visible, ...ext.nodes];
      edges = [...edges, ...ext.edges];
    }
    return { nodes, edges };
  }, [state.nodes, state.edges, state.expanded, state.includeExternal, source]);

  useEffect(() => {
    if (derived.nodes.length === 0) return;
    let alive = true;
    const t0 = performance.now();
    engineRef.current ??= engine ? Promise.resolve(engine) : createDefaultEngine();
    engineRef.current
      .then((eng) => eng.layout(toElkGraph(derived.nodes, derived.edges, state.expanded)))
      .then((res) => {
        if (!alive) return;
        const layout = readLayout(res);
        // 预计算布局文件只覆盖初始(全部收起)视图;展开后交给 elkjs
        const file = layoutFile.current;
        if (file && state.expanded.size === 0)
          for (const [id, [x, y]] of Object.entries(file.positions))
            if (layout.positions.has(id)) layout.positions.set(id, { x, y });
        setFlow(
          toFlow(derived.nodes, derived.edges, layout, state.expanded, countChildren(state.nodes)),
        );
        setStatus(
          `${derived.nodes.length} 个节点 · ${derived.edges.length} 条边 · 布局 ${Math.round(performance.now() - t0)} ms`,
        );
        requestAnimationFrame(() => fitView({ padding: 0.12, duration: 300 }));
      })
      .catch((e: unknown) => alive && setError(`布局失败:${String(e)}`));
    return () => {
      alive = false;
    };
  }, [derived, state.expanded, state.nodes, engine, fitView]);

  const view = useMemo(() => highlightSelection(flow, selectedId), [flow, selectedId]);
  const selectedNode = view.nodes.find((n) => n.id === selectedId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelectedId(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ToggleContext.Provider value={toggle}>
      <div className="relative h-full w-full bg-canvas">
        <div className="absolute right-3 top-3 z-10 flex gap-2">
          <button
            type="button"
            className="rounded-control border border-line bg-panel px-3 py-1.5 text-[13px] text-fg shadow-soft hover:border-accent-strong"
            onClick={() => dispatch({ type: 'collapseAll' })}
          >
            全部收起
          </button>
          <label className="flex items-center gap-1.5 rounded-control border border-line bg-panel px-3 py-1.5 text-[13px] text-fg shadow-soft">
            <input
              type="checkbox"
              className="accent-[var(--accent)]"
              checked={state.includeExternal}
              onChange={() => dispatch({ type: 'toggleExternal' })}
            />
            外部依赖
          </label>
        </div>
        <ReactFlow
          nodes={view.nodes}
          edges={view.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          // 单击 = 选中并高亮一跳邻居;展开只走卡片上的 ▸,双击 module/dir 作为附加快捷方式
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onNodeDoubleClick={(_, n) =>
            (n.type === 'module' || n.type === 'dir') && void toggle(n.id)
          }
          onPaneClick={() => setSelectedId(null)}
          zoomOnDoubleClick={false}
          elementsSelectable={false}
          nodesDraggable={false}
          nodesConnectable={false}
          onlyRenderVisibleElements
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
        <div
          role="status"
          className="absolute bottom-3 left-3 z-10 rounded-full border border-line bg-panel px-3 py-1 text-[12px] text-muted"
        >
          {error ??
            (selectedNode
              ? `已选中 ${selectedNode.data.node.path} · 依赖 ${view.out} · 被依赖 ${view.in} · Esc 取消`
              : status)}
        </div>
      </div>
    </ToggleContext.Provider>
  );
}

/** 依赖图主视图:单击选中高亮邻居,▸(或双击)逐层展开 module→dir→file */
export function GraphView(props: GraphViewProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
