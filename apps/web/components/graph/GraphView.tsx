'use client';
import { MAX_NODES_PER_RESPONSE, type GraphNode } from '@repolens/shared';
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
  activeLayerEdges,
  aggregateEdges,
  countChildren,
  inCycleEdgeKeys,
  deriveExternal,
  makeVisibility,
  SliceTooLargeError,
} from '../../lib/graph/hierarchy';
import { userMessageOf } from '../../lib/api/errors';
import { graphReducer, initialGraphState } from '../../lib/graph/state';
import type { GraphSource } from '../../lib/graph/source';
import { toFlow, type RepoFlowEdge, type RepoFlowNode } from '../../lib/graph/toFlow';
import { highlightSelection } from '../../lib/graph/selection';
import { nextFocusStep } from '../../lib/graph/focus';
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
import { HoverContext } from './HoverContext';
import { createHoverController, createHoverStore } from '../../lib/graph/hover';

export type GraphViewProps = {
  source: GraphSource;
  /** 根层加载完成(含耗时)后回调,用于页头显示 commit 等信息 */
  onRootLoaded?: (info: { commitSha: string; nodes: number; ms: number }) => void;
  owner: string;
  repo: string;
  /** 测试时注入同步布局引擎;默认走 web worker 里的 elkjs */
  engine?: LayoutEngine;
  /** 选中变化(含当前可见层级的一跳邻居),供右栏详情使用 */
  onSelectionChange?: (sel: { id: string; deps: string[]; dependents: string[] } | null) => void;
  /** 外部请求跳转到某节点(详情面板里点列表/面包屑、URL ?node=):必要时按路径逐层展开后选中。n 变化即触发 */
  jumpRequest?: { id: string; n: number } | null;
  /** 外部请求取消选中(窄屏抽屉的「关闭」):数值变化即触发,0 不触发 */
  clearRequest?: number;
};

/** 节点 id 的 POSIX 路径(m:/d:/f: 去前缀) */
const idPath = (id: string) => id.slice(2);
/** 跳转目标的展开焦点:所在目录(只展开到它可见为止,不展开目标本身) */
function revealFocus(id: string): string | null {
  if (!/^[mdf]:/.test(id)) return null;
  const p = idPath(id);
  const i = p.lastIndexOf('/');
  return `d:${i < 0 ? '.' : p.slice(0, i)}`;
}

/** 跳转目标解析:优先精确 id;面包屑给的 d: 可能对应顶层 module(m:),按路径匹配非文件节点 */
function resolveJumpTarget(nodes: readonly GraphNode[], want: string): string {
  const hit =
    nodes.find((n) => n.id === want) ??
    nodes.find((n) => n.type !== 'external' && idPath(n.id) === idPath(want) && n.id[0] !== 'f');
  return hit?.id ?? want;
}

const defaultEdgeOptions = {
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--edge)' },
};

function Inner({
  source,
  owner,
  repo,
  engine,
  onRootLoaded,
  onSelectionChange,
  jumpRequest,
  clearRequest = 0,
}: GraphViewProps) {
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

  // meta.suggestedFocus:首次加载时自动逐层展开;用户手动展开/折叠后置空,不再自动展开
  const autoFocus = useRef<string | null>(null);
  const autoBusy = useRef(false);
  const [autoTick, setAutoTick] = useState(0);
  // T-222:等待中的外部跳转目标(见下方跳转 effect)。根层加载回调里也要读,所以声明在这里
  const pendingJump = useRef<string | null>(null);
  // T-222e:逐层展开被中止时递增,用来结束等待中的跳转(见下方跳转 effect)
  const [jumpStopped, setJumpStopped] = useState(0);
  const onRootRef = useRef(onRootLoaded);
  onRootRef.current = onRootLoaded;

  useEffect(() => {
    let alive = true;
    const t0 = performance.now();
    source
      .loadChildren(null)
      .then(async (slice) => {
        const ms = Math.round(performance.now() - t0);
        const file = await loadLayoutFile(owner, repo, slice.meta.commitSha);
        if (!alive) return;
        layoutFile.current = file;
        // 挂载时就带着跳转请求(?node= 打开链接):根层返回后按跳转目标展开,不用 suggestedFocus 覆盖它
        const pending = pendingJump.current
          ? resolveJumpTarget(slice.nodes, pendingJump.current)
          : null;
        if (pending) pendingJump.current = pending;
        autoFocus.current =
          (pending ? revealFocus(pending) : null) ?? slice.meta.suggestedFocus ?? null;
        onRootRef.current?.({ commitSha: slice.meta.commitSha, nodes: slice.nodes.length, ms });
        dispatch({
          type: 'init',
          nodes: slice.nodes,
          // fixture 给全量原始边;真实接口用本层返回的边
          edges: source.rawEdges ? source.rawEdges() : slice.edges,
          layered: !source.rawEdges,
          truncated: slice.truncated,
        });
        if (slice.nodes.length === 0) setStatus('这个仓库没有可展示的模块');
      })
      .catch((e: unknown) => alive && setError(`加载依赖图失败:${userMessageOf(e)}`));
    return () => {
      alive = false;
    };
  }, [source, owner, repo]);

  const toggle = useCallback(
    async (id: string, autoFor?: string): Promise<boolean> => {
      setError(null);
      if (state.expanded.has(id)) {
        dispatch({ type: 'collapse', id });
        return true;
      }
      if (!state.loaded.has(id)) {
        try {
          const slice = await source.loadChildren(id);
          // 自动下探的请求返回时,用户可能已手动操作(autoFocus 被置空或换了目标):丢弃结果
          if (autoFor !== undefined && autoFocus.current !== autoFor) return false;
          dispatch({
            type: 'childrenLoaded',
            parentId: id,
            nodes: slice.nodes,
            ...(source.rawEdges ? {} : { edges: slice.edges }),
            truncated: slice.truncated,
          });
        } catch (e) {
          if (autoFor !== undefined && autoFocus.current !== autoFor) return false;
          setError(
            e instanceof SliceTooLargeError ? e.message : `加载 ${id} 失败:${userMessageOf(e)}`,
          );
          return false;
        }
      }
      dispatch({ type: 'expand', id });
      return true;
    },
    [state.expanded, state.loaded, source],
  );

  // 用户操作(▸、双击、全部收起)都会终止自动下探
  const userToggle = useCallback(
    (id: string) => {
      autoFocus.current = null;
      return toggle(id);
    },
    [toggle],
  );

  useEffect(() => {
    const focus = autoFocus.current;
    if (!focus || autoBusy.current || state.nodes.length === 0) return;
    const step = nextFocusStep(state.nodes, state.expanded, focus);
    if (!step) {
      autoFocus.current = null;
      return;
    }
    autoBusy.current = true;
    void toggle(step, focus).then((ok) => {
      autoBusy.current = false;
      // 请求失败(toggle 已显示错误)或结果被丢弃:停止下探;成功则触发下一步
      if (!ok || autoFocus.current !== focus) {
        autoFocus.current = null;
        // T-222e:下探中止(请求失败,或用户手动展开/折叠使结果被丢弃)时,若有跳转在等待,结束它
        if (pendingJump.current) setJumpStopped((t) => t + 1);
        return;
      }
      setAutoTick((t) => t + 1);
    });
  }, [state.nodes, state.expanded, toggle, autoTick]);

  const derived = useMemo(() => {
    const vis = makeVisibility(state.nodes, state.expanded, source.parentOf);
    const visible = state.nodes.filter((n) => vis.isVisible(n.id));
    const live = source.rawEdges
      ? state.edges
      : activeLayerEdges(state.edges, state.edgeLayer, state.expanded, vis.isVisible);
    let edges = aggregateEdges(live, vis.visibleAncestor);
    const cycleKeys = inCycleEdgeKeys(live, vis.visibleAncestor);
    // 截断提示:只看当前可见的层(根层 + 已展开且可见的容器)
    const truncatedLayers = [...state.truncated].filter(
      (p) => p === '' || (state.expanded.has(p) && vis.isVisible(p)),
    );
    let nodes = visible;
    if (state.includeExternal) {
      const files = state.nodes.filter((n) => n.type === 'file');
      const ext = deriveExternal(files, vis.visibleAncestor);
      nodes = [...visible, ...ext.nodes];
      edges = [...edges, ...ext.edges];
    }
    return { nodes, edges, cycleKeys, truncatedLayers };
  }, [
    state.nodes,
    state.edges,
    state.edgeLayer,
    state.truncated,
    state.expanded,
    state.includeExternal,
    source,
  ]);

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
          toFlow(
            derived.nodes,
            derived.edges,
            layout,
            state.expanded,
            countChildren(state.nodes),
            derived.cycleKeys,
          ),
        );
        const nCycle = derived.edges.filter((e) =>
          derived.cycleKeys.has(`${e.source}->${e.target}`),
        ).length;
        setStatus(
          `当前显示 ${derived.nodes.length} 节点 / ${derived.edges.length} 条边${nCycle ? ` · 环边 ${nCycle}` : ''} · 布局 ${Math.round(performance.now() - t0)} ms`,
        );
        requestAnimationFrame(() => fitView({ padding: 0.12, duration: 300 }));
      })
      .catch((e: unknown) => alive && setError(`布局失败:${String(e)}`));
    return () => {
      alive = false;
    };
  }, [derived, state.expanded, state.nodes, engine, fitView]);

  const view = useMemo(() => highlightSelection(flow, selectedId), [flow, selectedId]);

  // T-221 悬停预览:外部 store + 防抖,不进 React state,悬停时不整图重渲染
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverStore] = useState(createHoverStore);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const [hover] = useState(() =>
    createHoverController(hoverStore, () => selectedRef.current !== null),
  );
  useEffect(() => {
    const sync = () => {
      const el = wrapRef.current;
      if (!el) return;
      if (hoverStore.get() !== null) el.dataset.hovering = 'true';
      else delete el.dataset.hovering;
    };
    const off = hoverStore.subscribe(sync);
    return () => {
      off();
      hover.dispose();
    };
  }, [hoverStore, hover]);
  // 选中优先:一旦选中就清掉悬停;图数据变化(展开/收起)后悬停节点可能已不存在,也清掉
  useEffect(() => {
    if (selectedId !== null) hover.leave();
  }, [selectedId, hover]);
  useEffect(() => hover.leave(), [flow, hover]);
  const selectedNode = view.nodes.find((n) => n.id === selectedId);

  // T-222:把选中与一跳邻居告诉右栏(只在内容变化时回调)
  const onSelRef = useRef(onSelectionChange);
  onSelRef.current = onSelectionChange;
  const selKey = useMemo(() => {
    if (!selectedId || !flow.nodes.some((n) => n.id === selectedId))
      return selectedId ? `${selectedId}|` : '';
    const deps = flow.edges.filter((e) => e.source === selectedId).map((e) => e.target);
    const dependents = flow.edges.filter((e) => e.target === selectedId).map((e) => e.source);
    return JSON.stringify({ id: selectedId, deps, dependents });
  }, [flow, selectedId]);
  useEffect(() => {
    if (!selKey) {
      // 不能写成 return onSel(null):回调的返回值会被 React 当成 effect 清理函数
      onSelRef.current?.(null);
      return;
    }
    if (selKey.endsWith('|')) {
      // 跳转展开中:选中节点暂不在可见图里,保持上一状态
      if (pendingJump.current) return;
      // T-222d:选中节点因所在目录被折叠(或全部收起)而不在图中:清除选中、关闭详情,
      // 避免右栏继续显示一个画布上看不到的节点(旧内容)
      setSelectedId(null);
      return;
    }
    onSelRef.current?.(JSON.parse(selKey));
  }, [selKey]);

  // T-222:外部跳转。目标已可见直接选中;否则复用 suggestedFocus 的逐层展开,展开到位后选中
  useEffect(() => {
    if (!jumpRequest) return;
    // 面包屑给的是 d:,顶层目录可能是 module(m:):按路径匹配已加载节点
    const id = resolveJumpTarget(state.nodes, jumpRequest.id);
    if (flow.nodes.some((n) => n.id === id)) {
      pendingJump.current = null;
      setSelectedId(id);
      return;
    }
    pendingJump.current = id;
    // 根层还没回来时只记下目标,由根层加载回调设置展开焦点(否则会被 suggestedFocus 覆盖)
    const focus = state.nodes.length > 0 ? revealFocus(id) : null;
    if (focus) {
      autoFocus.current = focus;
      setAutoTick((t) => t + 1);
    }
    // 只由新的 jumpRequest 触发
  }, [jumpRequest]);
  useEffect(() => {
    if (!pendingJump.current) return;
    // 逐层展开后可能出现按路径对应的 m: 节点(面包屑给的是 d:):重新解析
    const id = resolveJumpTarget(state.nodes, pendingJump.current);
    pendingJump.current = id;
    if (flow.nodes.some((n) => n.id === id)) {
      pendingJump.current = null;
      setSelectedId(id);
    } else if (
      !state.nodes.some((n) => n.id === id) &&
      !autoFocus.current &&
      !autoBusy.current &&
      state.nodes.length > 0
    ) {
      // 展开结束仍找不到(不在这棵树上或被截断):停止,状态条提示
      pendingJump.current = null;
      setError(`图中找不到 ${idPath(id)}(可能被截断或不在当前图里)`);
    }
  }, [flow, state.nodes]);

  // T-222e:跳转的逐层展开被中止:跳转不会再完成,结束等待;此时选中节点若已不在图中
  // (例如跳转途中用户折叠了它所在目录),按 T-222d 规则清除选中,不留看不到的旧详情
  useEffect(() => {
    if (jumpStopped === 0 || !pendingJump.current) return;
    if (flow.nodes.some((n) => n.id === pendingJump.current)) return;
    pendingJump.current = null;
    if (selectedId && !flow.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
    // 依赖故意只写 jumpStopped:flow / selectedId 只在中止那一刻读一次。若把它们加进依赖,
    // 跳转进行中每次 flow 变化(逐层展开每层都会变)都会重跑本 effect,在正常展开途中
    // 就提前清掉 pendingJump,跳转无法完成。
    // 本仓库的 ESLint 未启用 eslint-plugin-react-hooks,写 eslint-disable-next-line
    // react-hooks/exhaustive-deps 会报「Definition for rule ... was not found」,所以只留这段说明;
    // 以后接入该插件时,在这里补上对 react-hooks/exhaustive-deps 的禁用。
  }, [jumpStopped]);

  // T-222d:图区尺寸变化(窄屏底部抽屉打开/关闭、窗口缩放)后重新适配视图,避免节点落在可视区外
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let t: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) return void (first = false); // 首次回调是挂载本身,布局 effect 已负责 fitView
      clearTimeout(t);
      t = setTimeout(() => void fitView({ padding: 0.12, duration: 200 }), 150);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [fitView]);

  useEffect(() => {
    if (clearRequest > 0) setSelectedId(null);
  }, [clearRequest]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelectedId(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ToggleContext.Provider value={userToggle}>
      <HoverContext.Provider value={hoverStore}>
        <div ref={wrapRef} data-testid="graph-wrap" className="relative h-full w-full bg-canvas">
          <div className="absolute right-3 top-3 z-10 flex gap-2">
            <button
              type="button"
              className="rounded-control border border-line bg-panel px-3 py-1.5 text-[13px] text-fg shadow-soft hover:border-accent-strong"
              onClick={() => {
                autoFocus.current = null;
                dispatch({ type: 'collapseAll' });
              }}
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
              (n.type === 'module' || n.type === 'dir') && void userToggle(n.id)
            }
            onPaneClick={() => setSelectedId(null)}
            onNodeMouseEnter={(_, n) => hover.enter(n.id)}
            onNodeMouseLeave={() => hover.leave()}
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
          <Legend />
          {derived.truncatedLayers.length > 0 && (
            <div
              role="note"
              data-testid="truncated-notice"
              className="absolute left-3 top-3 z-10 max-w-[420px] rounded-control border border-line bg-panel px-3 py-1.5 text-[12px] text-fg shadow-soft"
            >
              {derived.truncatedLayers
                .map((p) => (p === '' ? '顶层' : `「${p.replace(/^[a-z]:/, '')}」`))
                .join('、')}
              的子节点超过 {MAX_NODES_PER_RESPONSE} 个,只显示了前 {MAX_NODES_PER_RESPONSE} 个。
            </div>
          )}
          {/* T-222e:最大宽度给右下缩放按钮(Controls)留出 5rem,超长截断;窄屏没有键盘,不提示 Esc */}
          <div
            role="status"
            data-testid="graph-status"
            className="absolute bottom-3 left-3 z-10 max-w-[calc(100%-5rem)] truncate rounded-full border border-line bg-panel px-3 py-1 text-[12px] text-muted"
          >
            {error ??
              (selectedNode ? (
                <>
                  已选中 {selectedNode.data.node.path} · 依赖 {view.out} · 被依赖 {view.in}
                  <span data-testid="esc-hint" className="hidden md:inline">
                    {' '}
                    · Esc 取消
                  </span>
                </>
              ) : (
                status
              ))}
          </div>
        </div>
      </HoverContext.Provider>
    </ToggleContext.Provider>
  );
}

/** 图例:投屏时靠颜色 + 线型 + 标记三重区分。窄屏(<768px)隐藏,否则会盖住一半图区(T-222d) */
function Legend() {
  const row = 'flex items-center gap-2';
  return (
    <div
      aria-label="图例"
      className="absolute bottom-12 left-3 z-10 hidden flex-col gap-1 md:flex rounded-control border border-line bg-panel px-3 py-2 text-[12px] text-fg shadow-soft"
    >
      <div className={row}>
        <svg width="36" height="8" aria-hidden>
          <line x1="0" y1="4" x2="36" y2="4" stroke="var(--edge)" strokeWidth="2" />
        </svg>
        依赖
      </div>
      <div className={row}>
        <svg width="36" height="8" aria-hidden>
          <line
            x1="0"
            y1="4"
            x2="36"
            y2="4"
            stroke="var(--edge)"
            strokeWidth="2"
            strokeDasharray="1 5"
            strokeLinecap="round"
            strokeOpacity="0.55"
          />
        </svg>
        仅类型引用
      </div>
      <div className={row}>
        <svg width="36" height="8" aria-hidden>
          <line
            x1="0"
            y1="4"
            x2="36"
            y2="4"
            stroke="var(--accent-strong)"
            strokeWidth="2.5"
            strokeDasharray="8 4"
          />
        </svg>
        <span className="inline-flex items-center gap-1">
          循环依赖
          <span className="rounded-full bg-accent-strong px-1 text-[10px] leading-4 text-on-accent">
            ↻
          </span>
        </span>
      </div>
      <div className={row}>
        <svg width="36" height="8" aria-hidden>
          <line
            x1="0"
            y1="4"
            x2="36"
            y2="4"
            stroke="var(--edge)"
            strokeWidth="5"
            strokeOpacity="0.75"
          />
        </svg>
        <span className="inline-flex items-center gap-1">
          聚合边(越粗越多)
          <span className="rounded-full border border-line bg-panel px-1.5 text-[10px] text-muted">
            ×N
          </span>
          聚合次数
        </span>
      </div>
    </div>
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
