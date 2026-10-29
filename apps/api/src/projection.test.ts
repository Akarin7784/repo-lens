import { describe, expect, it } from 'vitest';
import { GraphDataSchema, type ImportKind } from '@repolens/shared';
import type { StoredGraph } from '@repolens/db';
import { GraphIndex, projectGraph, projectGraphWithInfo } from './projection.js';

// monorepo 形态:m:packages/core、m:packages/utils、m:packages/app
const paths = [
  'packages/core/src/index.ts',
  'packages/core/src/deep/x.ts',
  'packages/core/src/deep/y.ts',
  'packages/utils/src/a.ts',
  'packages/utils/src/b.ts',
  'packages/app/main.ts',
];
const mod = (p: string) => `m:${p.split('/').slice(0, 2).join('/')}`;
const dir = (p: string) => p.slice(0, p.lastIndexOf('/'));
const id = new Map(paths.map((p, i) => [p, i + 1]));

function graph(edges: [string, string, ImportKind][]): GraphIndex {
  const g: StoredGraph = {
    files: paths.map((p) => ({
      id: id.get(p)!,
      path: p,
      lang: 'ts',
      loc: 1,
      moduleId: mod(p),
      dirPath: dir(p),
      externalDeps: [],
    })),
    edges: edges.map(([s, t, kind]) => ({
      srcId: `f:${s}`,
      dstId: `f:${t}`,
      kind,
      srcFileId: id.get(s)!,
      weight: 1,
    })),
  };
  return new GraphIndex(g);
}
const project = (ix: GraphIndex, parentId: string | null) => {
  const g = projectGraph(ix, {
    repoId: 1,
    commitSha: 'a'.repeat(40),
    parentId,
    includeExternal: false,
  })!;
  return GraphDataSchema.parse(g);
};
const C = 'packages/core/src/';
const U = 'packages/utils/src/';

describe('跨子树聚合边', () => {
  const ix = graph([
    [`${C}index.ts`, `${U}a.ts`, 'static'],
    [`${C}deep/x.ts`, `${U}a.ts`, 'type-only'],
    [`${C}deep/x.ts`, `${U}b.ts`, 'type-only'],
    [`${C}deep/y.ts`, `${U}b.ts`, 'static'],
    [`${U}b.ts`, `${C}index.ts`, 'static'],
    ['packages/app/main.ts', `${C}index.ts`, 'dynamic'],
    [`${C}deep/x.ts`, `${C}deep/y.ts`, 'static'], // 子树内,展开 core/src 时同在 d:…/deep 内 → 自环
    [`${U}a.ts`, `${U}b.ts`, 'static'], // 两端都在子树外
    [`${C}deep/y.ts`, `${C}index.ts`, 'static'], // 展开 deep 时 index.ts 在子树外,LCA=d:…/src
  ]);

  it('外端写成 LCA(P,Y) 的直接子节点,并放进 nodes', () => {
    // P = d:packages/core/src,Y 在 m:packages/utils → LCA 为根,外端 = m:packages/utils
    const g = project(ix, 'd:packages/core/src');
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(
      [
        'd:packages/core/src/deep',
        'f:packages/core/src/index.ts',
        'm:packages/app',
        'm:packages/utils',
      ].sort(),
    );
    expect(g.edges.every((e) => e.type === 'imports' && e.aggregated)).toBe(true);
  });

  it('按方向分开合并,weight=import 次数,kind 取最多者;无自环;子树外内部边不返回', () => {
    const g = project(ix, 'd:packages/core/src');
    const m = Object.fromEntries(
      g.edges.map((e) => [`${e.source}->${e.target}`, [e.weight, e.kind]]),
    );
    expect(m).toEqual({
      'f:packages/core/src/index.ts->m:packages/utils': [1, 'static'],
      'd:packages/core/src/deep->m:packages/utils': [3, 'type-only'], // type-only 2 次 > static 1 次
      'm:packages/utils->f:packages/core/src/index.ts': [1, 'static'], // 反方向单独一条
      'm:packages/app->f:packages/core/src/index.ts': [1, 'dynamic'],
      'd:packages/core/src/deep->f:packages/core/src/index.ts': [1, 'static'],
    });
    expect(g.edges.some((e) => e.source === e.target)).toBe(false);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
  });

  it('LCA 更深时外端取到同模块内的兄弟层:展开 d:…/deep,Y=index.ts → 外端 f:…/index.ts', () => {
    const g = project(ix, 'd:packages/core/src/deep');
    const m = Object.fromEntries(g.edges.map((e) => [`${e.source}->${e.target}`, e.weight]));
    expect(m).toEqual({
      'f:packages/core/src/deep/x.ts->f:packages/core/src/deep/y.ts': 1,
      'f:packages/core/src/deep/x.ts->m:packages/utils': 2,
      'f:packages/core/src/deep/y.ts->m:packages/utils': 1,
      'f:packages/core/src/deep/y.ts->f:packages/core/src/index.ts': 1, // 外端是 LCA 的直接子节点(文件本身)
    });
    // 原始文件边(两端都可见)不带 aggregated
    expect(
      g.edges.find((e) => e.target === 'f:packages/core/src/deep/y.ts')!.aggregated,
    ).toBeUndefined();
    expect(g.nodes.map((n) => n.id)).toContain('f:packages/core/src/index.ts');
  });

  it('module 层:与 #10 一致,边都在可见 module 之间', () => {
    const g = project(ix, null);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([
      'm:packages/app',
      'm:packages/core',
      'm:packages/utils',
    ]);
    const m = Object.fromEntries(g.edges.map((e) => [`${e.source}->${e.target}`, e.weight]));
    expect(m).toEqual({
      'm:packages/core->m:packages/utils': 4,
      'm:packages/utils->m:packages/core': 1,
      'm:packages/app->m:packages/core': 1,
    });
  });

  it('300 名额不够时边界节点按 weight 截断,对应边一起丢弃', () => {
    const g = projectGraph(ix, {
      repoId: 1,
      commitSha: 'a'.repeat(40),
      parentId: 'd:packages/core/src',
      includeExternal: false,
      maxNodes: 3,
    })!;
    expect(() => GraphDataSchema.parse(g)).not.toThrow();
    expect(g.nodes.length).toBe(3);
  });

  it('300 名额顺序:先保留 P 的子节点,再按 weight 裁剪边界节点;子节点超限照旧截断并标记', () => {
    const opt = (maxNodes: number) => ({
      repoId: 1,
      commitSha: 'a'.repeat(40),
      parentId: 'd:packages/core/src',
      includeExternal: false,
      maxNodes,
    });
    // 子节点 2 个(deep、index.ts),边界节点 2 个:m:packages/utils(2 个文件)> m:packages/app(1)
    const full = projectGraphWithInfo(ix, opt(300))!;
    expect([full.truncated, full.droppedBoundary]).toEqual([false, 0]);
    const three = projectGraphWithInfo(ix, opt(3))!;
    expect(three.graph.nodes.map((n) => n.id)).toEqual([
      'f:packages/core/src/index.ts', // 子节点按 weight:index.ts 入度 4 > deep 2 个文件
      'd:packages/core/src/deep',
      'm:packages/utils',
    ]);
    expect([three.truncated, three.droppedBoundary]).toEqual([false, 1]);
    expect(three.graph.edges.some((e) => e.source === 'm:packages/app')).toBe(false);
    const one = projectGraphWithInfo(ix, opt(1))!;
    expect(one.graph.nodes.map((n) => n.id)).toEqual(['f:packages/core/src/index.ts']);
    expect([one.truncated, one.droppedBoundary]).toEqual([true, 2]);
    expect(() => GraphDataSchema.parse(one.graph)).not.toThrow();
  });

  it('meta.cycles:按 SCC 成员集合投影(含边界节点),去重排序,落进同一节点的不返回', () => {
    const scc = [
      // 跨子树 SCC(成员按 id 排序,不是路径)
      [`f:${C}deep/x.ts`, `f:${C}index.ts`, `f:${U}a.ts`],
      // 同一子树内的 SCC
      [`f:${C}deep/x.ts`, `f:${C}deep/y.ts`],
    ];
    const at = (parentId: string | null) =>
      projectGraph(ix, {
        repoId: 1,
        commitSha: 'a'.repeat(40),
        parentId,
        includeExternal: false,
        cycles: scc,
      })!.meta.cycles;
    // 展开 deep:x.ts 可见,index.ts 与 utils 映射为边界节点;旧实现只看可见节点会丢掉第一项
    expect(at('d:packages/core/src/deep')).toEqual([
      ['f:packages/core/src/deep/x.ts', 'f:packages/core/src/index.ts', 'm:packages/utils'],
      ['f:packages/core/src/deep/x.ts', 'f:packages/core/src/deep/y.ts'],
    ]);
    // 展开 core/src:x、y 都落进 d:deep → 第二项是 deep 内部的环,不返回
    expect(at('d:packages/core/src')).toEqual([
      ['d:packages/core/src/deep', 'f:packages/core/src/index.ts', 'm:packages/utils'],
    ]);
    // 根层:两项分别映射成 {core, utils} 与 {core},只保留前者
    expect(at(null)).toEqual([['m:packages/core', 'm:packages/utils']]);
    // 成员全在子树外(只落在边界节点上)的环不返回
    expect(at('m:packages/utils')).toEqual([['d:packages/utils/src', 'm:packages/core']]);
    // 映射后集合相同的 SCC 只返回一次,且与成员顺序无关
    const dup = projectGraph(ix, {
      repoId: 1,
      commitSha: 'a'.repeat(40),
      parentId: null,
      includeExternal: false,
      cycles: [
        [`f:${C}index.ts`, `f:${U}a.ts`],
        [`f:${U}b.ts`, `f:${C}deep/y.ts`],
      ],
    })!;
    expect(dup.meta.cycles).toEqual([['m:packages/core', 'm:packages/utils']]);
  });
});

describe('边的 inCycle(T-003h)', () => {
  // SCC1 = {deep/x, deep/y};SCC2 = {core/index, utils/a};index→x、b→index、main→index 不在环里
  const ix = graph([
    [`${C}deep/x.ts`, `${C}deep/y.ts`, 'static'],
    [`${C}deep/y.ts`, `${C}deep/x.ts`, 'static'],
    [`${C}index.ts`, `${U}a.ts`, 'static'],
    [`${U}a.ts`, `${C}index.ts`, 'static'],
    [`${C}index.ts`, `${C}deep/x.ts`, 'static'],
    [`${U}b.ts`, `${C}index.ts`, 'static'],
    ['packages/app/main.ts', `${C}index.ts`, 'static'],
  ]);
  const scc = [
    [`f:${C}deep/x.ts`, `f:${C}deep/y.ts`],
    [`f:${C}index.ts`, `f:${U}a.ts`],
  ];
  const at = (parentId: string | null, cycles: string[][] | undefined = scc) => {
    const g = GraphDataSchema.parse(
      projectGraph(ix, {
        repoId: 1,
        commitSha: 'a'.repeat(40),
        parentId,
        includeExternal: false,
        cycles,
      }),
    );
    return Object.fromEntries(
      g.edges.map((e) => [`${e.source}->${e.target}`, e.inCycle ?? false]),
    ) as Record<string, boolean>;
  };

  it('file 级边:两端在同一 SCC 为 true;两端分属不同 SCC 为 false', () => {
    expect(at('d:packages/core/src/deep')).toEqual({
      [`f:${C}deep/x.ts->f:${C}deep/y.ts`]: true,
      [`f:${C}deep/y.ts->f:${C}deep/x.ts`]: true,
      // index 与 x 各自在环里,但不在同一个 SCC
      [`f:${C}index.ts->f:${C}deep/x.ts`]: false,
    });
  });

  it('聚合边:任一底层 file 边在环里即为 true', () => {
    expect(at(null)).toEqual({
      'm:packages/core->m:packages/utils': true, // index→a
      'm:packages/utils->m:packages/core': true, // a→index(true)+ b→index(false)
      'm:packages/app->m:packages/core': false,
    });
    // d:deep 内部的环在本层是自环、不返回;f:index → d:deep 只聚合了 index→x,不在环里
    expect(at('d:packages/core/src')).toEqual({
      [`f:${C}index.ts->d:${C}deep`]: false,
      [`f:${C}index.ts->m:packages/utils`]: true,
      [`m:packages/utils->f:${C}index.ts`]: true,
      [`m:packages/app->f:${C}index.ts`]: false,
    });
  });

  it('只在为 true 时输出字段;cycles 为空时一律不输出', () => {
    const g = projectGraph(ix, {
      repoId: 1,
      commitSha: 'a'.repeat(40),
      parentId: null,
      includeExternal: false,
      cycles: scc,
    })!;
    expect(g.edges.every((e) => e.inCycle === true || !('inCycle' in e))).toBe(true);
    expect(Object.values(at(null, [])).some(Boolean)).toBe(false);
  });
});
