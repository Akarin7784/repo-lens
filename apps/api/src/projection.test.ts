import { describe, expect, it } from 'vitest';
import { GraphDataSchema, type ImportKind } from '@repolens/shared';
import type { StoredGraph } from '@repolens/db';
import { GraphIndex, layerEdgeCount, projectGraph, projectGraphWithInfo } from './projection.js';

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
    language: 'typescript',
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
      language: 'typescript',
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
      language: 'typescript' as const,
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
        language: 'typescript',
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
      language: 'typescript',
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
        language: 'typescript',
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
      language: 'typescript',
      parentId: null,
      includeExternal: false,
      cycles: scc,
    })!;
    expect(g.edges.every((e) => e.inCycle === true || !('inCycle' in e))).toBe(true);
    expect(Object.values(at(null, [])).some(Boolean)).toBe(false);
  });
});

describe('meta.suggestedFocus(根层建议焦点)', () => {
  /** files: [path, loc];moduleOf 给出 module 根路径 */
  function mk(
    files: [string, number][],
    edges: [string, string][],
    moduleOf: (p: string) => string = () => '.',
  ): GraphIndex {
    const fid = new Map(files.map(([p], i) => [p, i + 1]));
    return new GraphIndex({
      files: files.map(([p, loc]) => ({
        id: fid.get(p)!,
        path: p,
        lang: 'ts',
        loc,
        moduleId: `m:${moduleOf(p)}`,
        dirPath: p.includes('/') ? dir(p) : '.',
        externalDeps: [],
      })),
      edges: edges.map(([a, b]) => ({
        srcId: `f:${a}`,
        dstId: `f:${b}`,
        kind: 'static' as const,
        srcFileId: fid.get(a)!,
        weight: 1,
      })),
    });
  }
  const opts = {
    repoId: 1,
    commitSha: 'a'.repeat(40),
    language: 'typescript' as const,
    includeExternal: false,
  };
  const focusOf = (ix: GraphIndex, parentId: string | null = null) =>
    GraphDataSchema.parse(projectGraph(ix, { ...opts, parentId })).meta.suggestedFocus;

  it('根层边 ≥3:不返回该字段', () => {
    // 复用上面 monorepo:core→utils、utils→core、app→core 共 3 条模块边
    const ix = graph([
      [`${C}index.ts`, `${U}a.ts`, 'static'],
      [`${U}b.ts`, `${C}index.ts`, 'static'],
      ['packages/app/main.ts', `${C}index.ts`, 'static'],
    ]);
    expect(layerEdgeCount(ix, { ...opts, parentId: null }, null)).toBe(3);
    expect(focusOf(ix)).toBeUndefined();
  });

  it('单根 m:. → d:src,在边数 ≥3 的那层停下', () => {
    const ix = mk(
      [
        ['src/a/x.ts', 50],
        ['src/b/y.ts', 40],
        ['src/c/z.ts', 30],
        ['scripts/s.ts', 500],
        ['README.ts', 1],
      ],
      [
        ['src/a/x.ts', 'src/b/y.ts'],
        ['src/b/y.ts', 'src/c/z.ts'],
        ['src/c/z.ts', 'src/a/x.ts'],
      ],
    );
    // 根层只有 m:.(0 条边)→ m:.;m:. 层 {d:src, d:scripts, f:README.ts} 之间 0 条边,
    // 下探子树 loc 最大的可展开节点 d:scripts(500)…
    expect(focusOf(ix)).toBe('d:scripts');
  });

  it('按子树 loc 选择下探节点,边够用即停', () => {
    const ix = mk(
      [
        ['src/a/x.ts', 50],
        ['src/b/y.ts', 40],
        ['src/c/z.ts', 30],
        ['scripts/s.ts', 10],
      ],
      [
        ['src/a/x.ts', 'src/b/y.ts'],
        ['src/b/y.ts', 'src/c/z.ts'],
        ['src/c/z.ts', 'src/a/x.ts'],
      ],
    );
    // m:. 层:d:src(120) vs d:scripts(10),0 条边 → d:src;d:src 层 a/b/c 之间 3 条边 → 停在 d:src
    expect(layerEdgeCount(ix, { ...opts, parentId: null }, 'd:src')).toBe(3);
    expect(focusOf(ix)).toBe('d:src');
  });

  it('最多下探 3 层', () => {
    const ix = mk(
      [
        ['src/core/deep/a.ts', 10],
        ['src/core/deep/b.ts', 10],
        ['src/core/c.ts', 5],
        ['src/u.ts', 1],
      ],
      [['src/core/deep/a.ts', 'src/core/deep/b.ts']],
    );
    // 根(0)→ m:.(0)→ d:src(0)→ d:src/core:已下探 3 层,即使边仍 <3 也停
    expect(focusOf(ix)).toBe('d:src/core');
  });

  it('没有可下探节点时停在当前层;loc 相同取 id 小的', () => {
    const flat = mk(
      [
        ['a.ts', 1],
        ['b.ts', 1],
      ],
      [],
    );
    expect(focusOf(flat)).toBe('m:.');
    const tie = mk(
      [
        ['zz/a.ts', 5],
        ['aa/b.ts', 5],
      ],
      [],
    );
    expect(focusOf(tie)).toBe('d:aa');
  });

  it('非根层请求不返回该字段', () => {
    const ix = mk([['src/a/x.ts', 1]], []);
    expect(focusOf(ix, 'm:.')).toBeUndefined();
    expect(focusOf(ix, 'd:src')).toBeUndefined();
  });
});

describe('meta.language', () => {
  it('来自 ProjectOptions.language(上游 repos.lang_main),不在投影里写死', () => {
    const ix = new GraphIndex({
      files: [
        {
          id: 1,
          path: 'src/a.ts',
          lang: 'ts',
          loc: 1,
          moduleId: 'm:src',
          dirPath: 'src',
          externalDeps: [],
        },
      ],
      edges: [],
    } as never);
    const g = projectGraph(ix, {
      repoId: 1,
      commitSha: 'a'.repeat(40),
      language: 'sentinel' as never,
      parentId: null,
      includeExternal: false,
    });
    expect(g?.meta.language).toBe('sentinel');
  });
});
