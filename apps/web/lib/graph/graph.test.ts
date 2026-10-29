import { describe, expect, it } from 'vitest';
import {
  GraphDataSchema,
  MAX_NODES_PER_RESPONSE,
  type GraphData,
  type GraphEdge,
  type GraphNode,
} from '@repolens/shared';
import { SAMPLE_REPOS } from '../fixtures';
import {
  activeLayerEdges,
  aggregateEdges,
  inCycleEdgeKeys,
  assertSliceSize,
  makeVisibility,
  sliceGraph,
  SliceTooLargeError,
} from './hierarchy';
import { graphReducer, initialGraphState } from './state';
import { DIM_OPACITY, highlightSelection } from './selection';
import type { RepoFlowEdge, RepoFlowNode } from './toFlow';
import { edgeWidth, toFlow } from './toFlow';
import { readLayout, toElkGraph, createInlineEngine } from '../layout/elk';
import { parseLayoutFile } from '../layout/layoutFile';

const hono = GraphDataSchema.parse(SAMPLE_REPOS.hono.data);

describe('fixtures 通过 shared 的 zod schema', () => {
  for (const [id, s] of Object.entries(SAMPLE_REPOS)) {
    it(`${id}.sample.graph.json`, () => {
      const r = GraphDataSchema.safeParse(s.data);
      expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true);
    });
  }
  it('fixture 不含派生数据(x: 节点 / aggregated 边)', () => {
    for (const s of Object.values(SAMPLE_REPOS)) {
      const d = GraphDataSchema.parse(s.data);
      expect(d.nodes.some((n) => n.type === 'external')).toBe(false);
      expect(d.edges.some((e) => e.aggregated)).toBe(false);
    }
  });
});

describe('每次响应 ≤300 节点', () => {
  it('每一层切片都 ≤ MAX_NODES_PER_RESPONSE 且通过 schema', () => {
    const parents: (string | null)[] = [
      null,
      ...hono.nodes.filter((n) => n.type !== 'file').map((n) => n.id),
    ];
    for (const p of parents) {
      const slice = sliceGraph(hono, p);
      expect(slice.nodes.length).toBeLessThanOrEqual(MAX_NODES_PER_RESPONSE);
      expect(slice.meta.parentId).toBe(p);
    }
  });
  it('超过 300 个子节点时抛 SliceTooLargeError', () => {
    expect(() => assertSliceSize('m:big', new Array(301).fill(0))).toThrow(SliceTooLargeError);
    expect(() => assertSliceSize('m:ok', new Array(300).fill(0))).not.toThrow();
  });
  it('shared schema 本身也拒绝 301 个节点', () => {
    const nodes: GraphNode[] = Array.from(
      { length: 301 },
      (_, i) =>
        ({
          id: `m:p${i}`,
          type: 'module',
          parentId: null,
          label: `p${i}`,
          path: `p${i}`,
        }) as GraphNode,
    );
    expect(GraphDataSchema.safeParse({ ...hono, nodes, edges: [] }).success).toBe(false);
  });
  it('根切片只有 module,边被上卷成 aggregated', () => {
    const root = sliceGraph(hono, null);
    expect(root.nodes.every((n) => n.type === 'module')).toBe(true);
    expect(root.edges.length).toBeGreaterThan(0);
    expect(root.edges.every((e) => e.aggregated === true && e.type === 'imports')).toBe(true);
  });
});

describe('聚合', () => {
  const tiny: GraphData = GraphDataSchema.parse({
    meta: { repoId: 1, commitSha: '0'.repeat(40), parentId: null, language: 'typescript' },
    nodes: [
      { id: 'm:a', type: 'module', parentId: null, label: 'a', path: 'a' },
      { id: 'm:b', type: 'module', parentId: null, label: 'b', path: 'b' },
      { id: 'f:a/x.ts', type: 'file', parentId: 'm:a', label: 'x.ts', path: 'a/x.ts' },
      { id: 'f:a/y.ts', type: 'file', parentId: 'm:a', label: 'y.ts', path: 'a/y.ts' },
      { id: 'f:b/z.ts', type: 'file', parentId: 'm:b', label: 'z.ts', path: 'b/z.ts' },
    ],
    edges: [
      {
        id: 'e1',
        source: 'f:a/x.ts',
        target: 'f:b/z.ts',
        type: 'imports',
        kind: 'static',
        srcFileId: 'f:a/x.ts',
        weight: 1,
      },
      {
        id: 'e2',
        source: 'f:a/y.ts',
        target: 'f:b/z.ts',
        type: 'imports',
        kind: 'type-only',
        srcFileId: 'f:a/y.ts',
        weight: 2,
      },
      {
        id: 'e3',
        source: 'f:a/x.ts',
        target: 'f:a/y.ts',
        type: 'imports',
        kind: 'static',
        srcFileId: 'f:a/x.ts',
        weight: 1,
      },
    ],
  });
  it('收起时 weight 累加、kind 取多数、内部边丢弃', () => {
    const vis = makeVisibility(tiny.nodes, new Set());
    const out = aggregateEdges(tiny.edges, vis.visibleAncestor);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: 'm:a',
      target: 'm:b',
      weight: 3,
      aggregated: true,
      srcFileId: 'f:a/x.ts',
    });
  });
  it('展开 m:a 后变成 file→module 聚合边,内部边恢复为原始边', () => {
    const vis = makeVisibility(tiny.nodes, new Set(['m:a']));
    const out = aggregateEdges(tiny.edges, vis.visibleAncestor);
    expect(out.find((e) => e.id === 'e3')?.aggregated).toBeUndefined();
    expect(
      out
        .filter((e) => e.aggregated)
        .map((e) => `${e.source}->${e.target}`)
        .sort(),
    ).toEqual(['f:a/x.ts->m:b', 'f:a/y.ts->m:b']);
  });
  it('线宽按 weight 对数增长并封顶 8px', () => {
    expect(edgeWidth(1, false)).toBe(1.25);
    expect(edgeWidth(1, true)).toBe(1);
    expect(edgeWidth(4, true)).toBe(4);
    expect(edgeWidth(10_000, true)).toBe(8);
  });
});

describe('折叠/展开状态', () => {
  const root = sliceGraph(hono, null);
  const s0 = graphReducer(initialGraphState, {
    type: 'init',
    nodes: root.nodes,
    edges: hono.edges,
  });
  const utilsKids = sliceGraph(hono, 'm:src/utils').nodes;
  const s1 = graphReducer(
    graphReducer(s0, { type: 'childrenLoaded', parentId: 'm:src/utils', nodes: utilsKids }),
    { type: 'expand', id: 'm:src/utils' },
  );
  it('未传 parentOf 时指向未加载文件的边无法上卷;传入后可以', () => {
    const parents = new Map(hono.nodes.map((n) => [n.id, n.parentId]));
    expect(
      aggregateEdges(hono.edges, makeVisibility(s0.nodes, s0.expanded).visibleAncestor),
    ).toHaveLength(0);
    const out = aggregateEdges(
      hono.edges,
      makeVisibility(s0.nodes, s0.expanded, (id) => parents.get(id)).visibleAncestor,
    );
    expect(out).toEqual(sliceGraph(hono, null).edges);
  });
  it('展开后子节点可见', () => {
    const vis = makeVisibility(s1.nodes, s1.expanded);
    expect(utilsKids.every((n) => vis.isVisible(n.id))).toBe(true);
    expect(s1.loaded.has('m:src/utils')).toBe(true);
  });
  it('重复加载不产生重复节点', () => {
    const s = graphReducer(s1, {
      type: 'childrenLoaded',
      parentId: 'm:src/utils',
      nodes: utilsKids,
    });
    expect(s.nodes.length).toBe(s1.nodes.length);
  });
  it('收起父节点会连带收起已展开的子孙', () => {
    const dir = utilsKids.find((n) => n.type === 'dir');
    const base = dir ? graphReducer(s1, { type: 'expand', id: dir.id }) : s1;
    const s2 = graphReducer(base, { type: 'collapse', id: 'm:src/utils' });
    expect(s2.expanded.size).toBe(0);
    const vis = makeVisibility(s2.nodes, s2.expanded);
    expect(utilsKids.some((n) => vis.isVisible(n.id))).toBe(false);
  });
  it('collapseAll / toggleExternal', () => {
    expect(graphReducer(s1, { type: 'collapseAll' }).expanded.size).toBe(0);
    expect(graphReducer(s1, { type: 'toggleExternal' }).includeExternal).toBe(true);
  });
});

describe('graph → React Flow 转换', () => {
  it('容器在子节点之前、子节点 parentId 指向容器、边类型为 weighted', async () => {
    const expanded = new Set(['m:src/utils']);
    const nodes = [...sliceGraph(hono, null).nodes, ...sliceGraph(hono, 'm:src/utils').nodes];
    const parents = new Map(hono.nodes.map((n) => [n.id, n.parentId]));
    const vis = makeVisibility(nodes, expanded, (id) => parents.get(id));
    const edges = aggregateEdges(hono.edges, vis.visibleAncestor);
    const engine = await createInlineEngine();
    const layout = readLayout(await engine.layout(toElkGraph(nodes, edges, expanded)));
    const flow = toFlow(nodes, edges, layout, expanded, new Map());
    const idx = new Map(flow.nodes.map((n, i) => [n.id, i]));
    for (const n of flow.nodes)
      if (n.parentId) expect(idx.get(n.parentId)!).toBeLessThan(idx.get(n.id)!);
    const container = flow.nodes.find((n) => n.id === 'm:src/utils')!;
    expect(container.data.isContainer).toBe(true);
    expect(flow.nodes.filter((n) => n.parentId === 'm:src/utils').length).toBe(
      sliceGraph(hono, 'm:src/utils').nodes.length,
    );
    expect(
      flow.edges.every((e) => e.type === 'weighted' && idx.has(e.source) && idx.has(e.target)),
    ).toBe(true);
    expect(flow.edges.some((e) => e.data?.aggregated)).toBe(true);
  });
});

describe('布局文件', () => {
  it('commitSha 不符时返回 null(回退 elkjs)', () => {
    expect(
      parseLayoutFile({ commitSha: 'a'.repeat(40), positions: { 'm:.': [0, 0] } }, 'a'.repeat(40)),
    ).not.toBeNull();
    expect(
      parseLayoutFile({ commitSha: 'b'.repeat(40), positions: {} }, 'a'.repeat(40)),
    ).toBeNull();
  });
});

describe('highlightSelection', () => {
  const mk = (id: string, isContainer = false) =>
    ({ id, position: { x: 0, y: 0 }, data: { isContainer } }) as unknown as RepoFlowNode;
  const ed = (source: string, target: string) =>
    ({
      id: `${source}->${target}`,
      source,
      target,
      data: { weight: 1, aggregated: false, kind: 'static' },
    }) as RepoFlowEdge;
  const flow = {
    nodes: [mk('a'), mk('b'), mk('c'), mk('d'), mk('box', true)],
    edges: [ed('a', 'b'), ed('c', 'a'), ed('c', 'd')],
  };
  it('无选中时原样返回', () => {
    expect(highlightSelection(flow, null).nodes).toBe(flow.nodes);
  });
  it('选中节点与一跳邻居不透明,其余淡出,容器不淡出;相连边 on,其他 dim', () => {
    const v = highlightSelection(flow, 'a');
    const op = Object.fromEntries(v.nodes.map((n) => [n.id, n.style?.opacity]));
    expect(op).toEqual({ a: 1, b: 1, c: 1, d: DIM_OPACITY, box: 1 });
    expect(v.nodes.find((n) => n.id === 'a')!.selected).toBe(true);
    expect(v.edges.map((e) => e.data!.highlight)).toEqual(['on', 'on', 'dim']);
    expect([v.out, v.in]).toEqual([1, 1]);
  });
});

describe('inCycleEdgeKeys(环边只读 edge.inCycle)', () => {
  const hono = GraphDataSchema.parse(SAMPLE_REPOS.hono.data);
  const parents = new Map(hono.nodes.map((n) => [n.id, n.parentId]));
  const topModule = (id: string): string | null => {
    let cur: string | null | undefined = id;
    while (cur && parents.get(cur)) cur = parents.get(cur);
    return cur ?? null;
  };
  it('hono 示例 fixture 的两条环边带 inCycle: true', () => {
    expect(
      hono.edges
        .filter((e) => e.inCycle)
        .map((e) => e.id)
        .sort(),
    ).toEqual([
      'e:src/request.ts->src/utils/url.ts:static',
      'e:src/utils/url.ts->src/request.ts:type-only',
    ]);
  });
  it('文件层:只有 inCycle 为 true 的边被标记', () => {
    const keys = inCycleEdgeKeys(hono.edges, (id) => id);
    expect([...keys].sort()).toEqual([
      'f:src/request.ts->f:src/utils/url.ts',
      'f:src/utils/url.ts->f:src/request.ts',
    ]);
  });
  it('上卷到 module 层后变成 m:. ⇄ m:src/utils 两条聚合边', () => {
    const keys = inCycleEdgeKeys(hono.edges, topModule);
    expect([...keys].sort()).toEqual(['m:.->m:src/utils', 'm:src/utils->m:.']);
  });
  it('两端上卷到同一节点时不产生环边', () => {
    expect(inCycleEdgeKeys(hono.edges, () => 'm:.').size).toBe(0);
  });
  it('不再用 meta.cycles 推断:同一分量但没有 inCycle 的边不标记', () => {
    const plain = hono.edges.map((x) => ({ ...x, inCycle: undefined }));
    expect(inCycleEdgeKeys(plain, (id) => id).size).toBe(0);
  });
});

describe('真实接口模式(T-007)', () => {
  const SHA = 'a'.repeat(40);
  const mod = (id: string) =>
    ({ id, type: 'module', parentId: null, label: id.slice(2), path: id.slice(2) }) as GraphNode;
  const file = (path: string, parentId: string) =>
    ({ id: `f:${path}`, type: 'file', parentId, label: path.split('/').pop()!, path }) as GraphNode;
  const e = (s: string, t: string, extra: Partial<GraphEdge> = {}) =>
    ({
      id: `${s}->${t}`,
      source: s,
      target: t,
      type: 'imports',
      kind: 'static',
      srcFileId: s.startsWith('f:') ? s : 'f:x.ts',
      weight: 1,
      ...extra,
    }) as GraphEdge;

  it('childrenLoaded 累积切片边(按 id 去重)和 meta.cycles', () => {
    let s = graphReducer(initialGraphState, {
      type: 'init',
      nodes: [mod('m:a'), mod('m:b')],
      edges: [e('m:a', 'm:b', { aggregated: true, weight: 3 })],
    });
    s = graphReducer(s, {
      type: 'childrenLoaded',
      parentId: 'm:a',
      nodes: [file('a/x.ts', 'm:a'), file('a/y.ts', 'm:a')],
      edges: [e('f:a/x.ts', 'f:a/y.ts'), e('f:a/y.ts', 'f:a/x.ts')],
      cycles: [['f:a/x.ts', 'f:a/y.ts']],
    });
    s = graphReducer(s, {
      type: 'childrenLoaded',
      parentId: 'm:a',
      nodes: [],
      edges: [e('f:a/x.ts', 'f:a/y.ts')],
      cycles: [['f:a/y.ts', 'f:a/x.ts']],
    });
    expect(s.edges).toHaveLength(3);
    expect(s.cycles).toEqual([['f:a/x.ts', 'f:a/y.ts']]);
    void SHA;
  });

  it('边界节点(parentId !== 请求的 P)只作占位:不加入、不渲染进 P、折叠时不受影响', () => {
    let s = graphReducer(initialGraphState, {
      type: 'init',
      nodes: [mod('m:a'), mod('m:b')],
      edges: [],
    });
    s = graphReducer(s, {
      type: 'childrenLoaded',
      parentId: 'm:a',
      // m:b 是聚合边外端,f:b/z.ts 是尚未加载子树里的节点:两者都不是 m:a 的子节点
      nodes: [file('a/x.ts', 'm:a'), mod('m:b'), file('b/z.ts', 'm:b')],
      edges: [e('f:a/x.ts', 'm:b', { aggregated: true, weight: 2 })],
    });
    expect(s.nodes.map((n) => n.id)).toEqual(['m:a', 'm:b', 'f:a/x.ts']);
    s = graphReducer(s, { type: 'expand', id: 'm:a' });
    const vis = makeVisibility(s.nodes, s.expanded);
    expect(
      aggregateEdges(s.edges, vis.visibleAncestor).map((x) => `${x.source}->${x.target}`),
    ).toEqual(['f:a/x.ts->m:b']);
    s = graphReducer(s, { type: 'collapse', id: 'm:a' });
    expect(s.nodes.map((n) => n.id)).toContain('m:b');
    expect(makeVisibility(s.nodes, s.expanded).isVisible('m:b')).toBe(true);
  });

  it('聚合边同样只读 inCycle(hono:dom → base.ts 在环上,dom → constants.ts 不在)', () => {
    const edges = [
      { ...e('d:src/jsx/dom', 'f:src/jsx/base.ts'), aggregated: true, weight: 10, inCycle: true },
      { ...e('d:src/jsx/dom', 'f:src/jsx/constants.ts'), aggregated: true, weight: 3 },
    ];
    const keys = inCycleEdgeKeys(edges, (id) => id);
    expect([...keys]).toEqual(['d:src/jsx/dom->f:src/jsx/base.ts']);
  });
});

describe('activeLayerEdges(真实接口边的分层生效)', () => {
  const E = (id: string, s: string, t: string) => ({ id, source: s, target: t });
  const edges = [E('r', 'm:a', 'm:b'), E('ax', 'f:a/x', 'm:b'), E('by', 'm:a', 'f:b/y')];
  const layer = new Map<string, string | null>([
    ['r', null],
    ['ax', 'm:a'],
    ['by', 'm:b'],
  ]);
  const ids = (exp: string[]) =>
    activeLayerEdges(edges, layer, new Set(exp), () => true).map((e) => e.id);
  it('都收起:只有根层边', () => expect(ids([])).toEqual(['r']));
  it('展开 a:a 的子层边替代容器边', () => expect(ids(['m:a'])).toEqual(['ax']));
  it('a、b 都展开:保留容器 ↔ 容器边', () => expect(ids(['m:a', 'm:b'])).toEqual(['r']));
  it('所属层不可见时不生效', () =>
    expect(
      activeLayerEdges(edges, layer, new Set(['m:a']), (id) => id !== 'm:a').map((e) => e.id),
    ).toEqual([]));
});

describe('state:边所属层与截断标记', () => {
  it('记录 edgeLayer 与 truncated', () => {
    const m = (id: string) =>
      ({ id, type: 'module', parentId: null, label: id, path: id }) as GraphNode;
    let s = graphReducer(initialGraphState, {
      type: 'init',
      nodes: [m('m:a')],
      edges: [{ id: 'e0', source: 'm:a', target: 'm:a' } as GraphEdge],
      layered: true,
    });
    s = graphReducer(s, {
      type: 'childrenLoaded',
      parentId: 'm:a',
      nodes: [],
      edges: [{ id: 'e1', source: 'x', target: 'm:a' } as GraphEdge],
      truncated: true,
    });
    expect([...s.edgeLayer]).toEqual([
      ['e0', null],
      ['e1', 'm:a'],
    ]);
    expect([...s.truncated]).toEqual(['m:a']);
  });
});
