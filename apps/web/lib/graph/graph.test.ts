import { describe, expect, it } from 'vitest';
import {
  GraphDataSchema,
  MAX_NODES_PER_RESPONSE,
  type GraphData,
  type GraphNode,
} from '@repolens/shared';
import { SAMPLE_REPOS } from '../fixtures';
import {
  aggregateEdges,
  assertSliceSize,
  makeVisibility,
  sliceGraph,
  SliceTooLargeError,
} from './hierarchy';
import { graphReducer, initialGraphState } from './state';
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
