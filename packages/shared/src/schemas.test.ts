import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  ApiErrorSchema,
  ChatEventSchema,
  ChatRequestSchema,
  CreateRepoRequestSchema,
  CreateRepoResponseSchema,
  GraphDataSchema,
  GraphQuerySchema,
  JobEventSchema,
  NodeDetailSchema,
  RepoStatusSchema,
  PROGRESS_STAGES,
  NodeIdSchema,
  ROOT_MODULE_ID,
  dirId,
  fileId,
  moduleId,
} from './index.js';

const graph = {
  nodes: [
    { id: 'm:.', type: 'module', label: '(root)', path: '.', parentId: null },
    { id: 'm:src/core', type: 'module', label: 'core', path: 'src/core', parentId: null },
    {
      id: 'd:src/core/utils',
      type: 'dir',
      label: 'utils',
      path: 'src/core/utils',
      parentId: 'm:src/core',
    },
    {
      id: 'f:src/core/a.ts',
      type: 'file',
      label: 'a.ts',
      path: 'src/core/a.ts',
      parentId: 'm:src/core',
      loc: 72,
    },
    {
      id: 'f:src/core/utils/b.ts',
      type: 'file',
      label: 'b.ts',
      path: 'src/core/utils/b.ts',
      parentId: 'd:src/core/utils',
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'f:src/core/a.ts',
      target: 'f:src/core/utils/b.ts',
      type: 'imports',
      kind: 'static',
      srcFileId: 'f:src/core/a.ts',
      weight: 1,
    },
    {
      id: 'e2',
      source: 'm:.',
      target: 'd:src/core/utils',
      type: 'imports',
      kind: 're-export',
      srcFileId: 'f:index.ts',
      weight: 3,
    },
  ],
  meta: { repoId: 12, commitSha: 'a1b2c3d', parentId: null, language: 'typescript' },
};
const node = (i: number) => graph.nodes[i]!;
const edge = graph.edges[0]!;

describe('ids', () => {
  it('确定性生成 POSIX 相对路径 nodeId', () => {
    expect(fileId('./src/core/a.ts')).toBe('f:src/core/a.ts');
    expect(dirId('src\\core\\utils/')).toBe('d:src/core/utils');
    expect(moduleId('')).toBe(ROOT_MODULE_ID);
    expect(moduleId('./')).toBe('m:.');
  });
  it('拒绝非法前缀和非 POSIX 路径', () => {
    for (const bad of [
      'x:',
      'y:react',
      'src/a.ts',
      'f:/abs/a.ts',
      'f:src//a.ts',
      'd:src/',
      'f:src\\a.ts',
      'd:.',
      'f:src/../a.ts',
    ])
      expect(NodeIdSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe('GraphDataSchema', () => {
  it('接受合法三层图', () => expect(GraphDataSchema.safeParse(graph).success).toBe(true));
  it('meta.suggestedFocus:可选;仅根层,且只能是 module/dir', () => {
    const at = (meta: object) =>
      GraphDataSchema.safeParse({ ...graph, meta: { ...graph.meta, ...meta } });
    expect(at({}).success).toBe(true); // 不返回该字段合法
    expect(at({ parentId: null, suggestedFocus: 'd:src' }).success).toBe(true);
    expect(at({ parentId: null, suggestedFocus: 'm:packages/core' }).success).toBe(true);
    // 焦点节点不要求出现在 nodes 中(根层可能只返回 m:.)
    expect(at({ parentId: null, suggestedFocus: 'd:not/in/nodes' }).success).toBe(true);
    expect(at({ parentId: null, suggestedFocus: 'f:src/a.ts' }).success).toBe(false);
    expect(at({ parentId: null, suggestedFocus: 'x:react' }).success).toBe(false);
    expect(at({ parentId: null, suggestedFocus: 'bad' }).success).toBe(false);
    expect(at({ parentId: 'm:.', suggestedFocus: 'd:src' }).success).toBe(false);
  });
  it('meta.layout 不属于 schema,解析后被剥离', () => {
    const g = { ...graph, meta: { ...graph.meta, layout: {} } };
    expect(GraphDataSchema.parse(g).meta).not.toHaveProperty('layout');
  });
  it('module 的 parentId 必须为 null,dir/file 必须有 parentId', () => {
    const bad1 = { ...graph, nodes: [{ ...node(1), parentId: 'm:.' }], edges: [] };
    const bad2 = { ...graph, nodes: [{ ...node(2), parentId: null }], edges: [] };
    const bad3 = { ...graph, nodes: [{ ...node(3), parentId: 'f:src/x.ts' }], edges: [] };
    for (const b of [bad1, bad2, bad3]) expect(GraphDataSchema.safeParse(b).success).toBe(false);
  });
  it('类型与前缀不匹配、path 与 id 不一致都拒绝', () => {
    expect(
      GraphDataSchema.safeParse({ ...graph, nodes: [{ ...node(3), type: 'dir' }], edges: [] })
        .success,
    ).toBe(false);
    expect(
      GraphDataSchema.safeParse({
        ...graph,
        nodes: [{ ...node(3), path: 'src/other.ts' }],
        edges: [],
      }).success,
    ).toBe(false);
  });
  it('节点字段平铺,data 字段不被接受到结果里', () => {
    const r = GraphDataSchema.parse({
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n, data: { x: 1 } })),
    });
    expect(r.nodes[0]).not.toHaveProperty('data');
  });
  it('边须 type=imports、合法 kind 与 file 类型的 srcFileId', () => {
    for (const k of ['static', 'dynamic', 'type-only', 're-export', 'require'])
      expect(
        GraphDataSchema.safeParse({ ...graph, edges: [{ ...edge, kind: k }] }).success,
        k,
      ).toBe(true);
    const bad = [
      { ...edge, kind: 'aggregated' },
      { ...edge, type: 'calls' },
      { ...edge, srcFileId: 'm:src/core' },
      { ...edge, srcFileId: undefined },
      { ...edge, target: 'f:nope.ts' },
      { ...edge, weight: 0 },
    ];
    for (const e of bad)
      expect(GraphDataSchema.safeParse({ ...graph, edges: [e] }).success, JSON.stringify(e)).toBe(
        false,
      );
  });
  it('派生的 external 节点和 aggregated 边合法', () => {
    const g = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: 'x:@scope/pkg',
          type: 'external',
          label: '@scope/pkg',
          path: '@scope/pkg',
          parentId: null,
        },
      ],
      edges: [
        ...graph.edges,
        {
          id: 'e3',
          source: 'f:src/core/utils/b.ts',
          target: 'x:@scope/pkg',
          type: 'imports',
          kind: 'static',
          srcFileId: 'f:src/core/utils/b.ts',
          weight: 1,
        },
        { ...edge, id: 'e4', source: 'm:src/core', target: 'm:.', aggregated: true, weight: 5 },
      ],
    };
    expect(GraphDataSchema.safeParse(g).success).toBe(true);
  });
  it('GraphQuery 的 includeExternal 默认不开', () => {
    expect(GraphQuerySchema.parse({}).includeExternal).toBeUndefined();
    expect(GraphQuerySchema.parse({ includeExternal: 'true' }).includeExternal).toBe(true);
  });
  it('拒绝超过 300 个节点', () => {
    const nodes = Array.from({ length: 301 }, (_, i) => ({
      id: `f:${i}.ts`,
      type: 'file',
      label: `${i}`,
      path: `${i}.ts`,
      parentId: 'm:.',
    }));
    expect(GraphDataSchema.safeParse({ ...graph, nodes, edges: [] }).success).toBe(false);
  });
  it('拒绝非 typescript 语言和非法 commitSha', () => {
    expect(
      GraphDataSchema.safeParse({ ...graph, meta: { ...graph.meta, language: 'python' } }).success,
    ).toBe(false);
    expect(
      GraphDataSchema.safeParse({ ...graph, meta: { ...graph.meta, commitSha: 'main' } }).success,
    ).toBe(false);
  });
});

describe('ChatEventSchema', () => {
  it('接受 token/citation/done/error/tool', () => {
    const ok = [
      { event: 'token', data: { text: 'hi' } },
      {
        event: 'citation',
        data: {
          id: 1,
          path: 'src/compose.ts',
          startLine: 10,
          endLine: 42,
          nodeId: 'f:src/compose.ts',
          moduleId: 'm:src',
        },
      },
      {
        event: 'done',
        data: {
          messageId: 881,
          droppedCitations: 1,
          fallback: 'retrieval',
          usage: { in: 5321, out: 402 },
        },
      },
      { event: 'done', data: { messageId: 2, droppedCitations: 0, usage: { in: 1, out: 1 } } },
      {
        event: 'error',
        data: { code: 'BUDGET_EXCEEDED', message: '今日 LLM 预算已用完', retryable: false },
      },
      { event: 'tool', data: { name: 'read_file', args: { path: 'src/compose.ts' } } },
    ];
    for (const e of ok) expect(ChatEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
  });
  it('拒绝非法事件', () => {
    const bad = [
      { event: 'reset', data: { reason: 'citation_retry' } },
      {
        event: 'citation',
        data: {
          id: 1,
          path: 'a.ts',
          startLine: 10,
          endLine: 42,
          nodeId: 'f:a.ts',
          verified: false,
        },
      },
      {
        event: 'citation',
        data: { id: 1, path: 'a.ts', startLine: 50, endLine: 42, nodeId: 'f:a.ts' },
      },
      { event: 'citation', data: { id: 1, path: 'a', startLine: 1, endLine: 2, nodeId: 'm:a' } },
      { event: 'done', data: { messageId: 1, dropped: 1, usage: { in: 1, out: 1 } } },
      { event: 'done', data: { messageId: 1, droppedCitations: -1, usage: { in: 1, out: 1 } } },
      {
        event: 'done',
        data: { messageId: 1, droppedCitations: 0, fallback: 'model', usage: { in: 1, out: 1 } },
      },
      { event: 'error', data: { code: 'OOPS', message: 'x', retryable: true } },
    ];
    for (const e of bad)
      expect(ChatEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(false);
  });
});

describe('JobEventSchema', () => {
  it('阶段顺序固定', () => {
    expect(PROGRESS_STAGES).toEqual([
      'queued',
      'cloning',
      'scanning',
      'parsing',
      'graph_ready',
      'summarizing',
      'embedding',
      'done',
    ]);
  });
  it('接受合法事件,拒绝未知阶段', () => {
    expect(
      JobEventSchema.safeParse({
        event: 'progress',
        data: { jobId: '12:a', stage: 'cloning', progress: 10 },
      }).success,
    ).toBe(true);
    expect(
      JobEventSchema.safeParse({
        event: 'stage_error',
        data: { jobId: '12:a', stage: 'summarizing', message: 'LLM 不可用' },
      }).success,
    ).toBe(true);
    expect(
      JobEventSchema.safeParse({
        event: 'progress',
        data: { jobId: '12:a', stage: 'indexing', progress: 10 },
      }).success,
    ).toBe(false);
    expect(
      JobEventSchema.safeParse({
        event: 'progress',
        data: { jobId: '12:a', stage: 'parsing', progress: 120 },
      }).success,
    ).toBe(false);
  });
});

describe('API DTO', () => {
  it('CreateRepoRequest 只接受 GitHub 地址', () => {
    expect(
      CreateRepoRequestSchema.safeParse({ repoUrl: 'https://github.com/honojs/hono', ref: 'main' })
        .success,
    ).toBe(true);
    expect(CreateRepoRequestSchema.safeParse({ repoUrl: 'https://gitlab.com/a/b' }).success).toBe(
      false,
    );
  });
  it('ChatRequest 的 contextNodeIds 可选但须合法', () => {
    expect(ChatRequestSchema.safeParse({ message: 'q' }).success).toBe(true);
    expect(
      ChatRequestSchema.safeParse({ message: 'q', contextNodeIds: ['m:src/middleware'] }).success,
    ).toBe(true);
    expect(
      ChatRequestSchema.safeParse({ message: 'q', contextNodeIds: ['middleware'] }).success,
    ).toBe(false);
    expect(ChatRequestSchema.safeParse({ message: '' }).success).toBe(false);
  });
  it('NodeDetail 的 summary 可为 null', () => {
    const d = {
      id: 'f:src/compose.ts',
      kind: 'file',
      path: 'src/compose.ts',
      summary: null,
      exports: ['compose'],
      loc: 72,
      inDegree: 5,
      outDegree: 2,
      topDependents: ['f:src/hono-base.ts'],
    };
    expect(NodeDetailSchema.safeParse(d).success).toBe(true);
    expect(NodeDetailSchema.safeParse({ ...d, summary: undefined }).success).toBe(false);
  });
});

describe('API_ERROR_CODES', () => {
  it('包含 BAD_REQUEST,且 ApiErrorSchema 接受它', () => {
    expect(API_ERROR_CODES).toContain('BAD_REQUEST');
    expect(ApiErrorSchema.safeParse({ error: { code: 'BAD_REQUEST', message: 'x' } }).success).toBe(
      true,
    );
  });
});

describe('RepoStatusSchema', () => {
  const ok = {
    repoId: 1,
    jobId: `1:${'a'.repeat(40)}`,
    repo: 'honojs/hono',
    commitSha: 'a'.repeat(40),
    status: 'done',
    stage: 'done',
    progress: 100,
    stats: { files: 1 },
    error: null,
  };
  it('含 repo(owner/name)与 commitSha,与 CreateRepoResponse 同名', () => {
    expect(RepoStatusSchema.parse(ok)).toEqual(ok);
    expect(
      Object.keys(CreateRepoResponseSchema.shape).filter((k) => !(k in RepoStatusSchema.shape)),
    ).toEqual([]);
  });
  it('repo/commitSha 必填且格式校验', () => {
    const noRepo: Record<string, unknown> = { ...ok };
    delete noRepo.repo;
    const noSha: Record<string, unknown> = { ...ok };
    delete noSha.commitSha;
    expect(RepoStatusSchema.safeParse(noRepo).success).toBe(false);
    expect(RepoStatusSchema.safeParse(noSha).success).toBe(false);
    for (const repo of ['hono', 'a/b/c', 'a/', '/b', 'a b/c'])
      expect(RepoStatusSchema.safeParse({ ...ok, repo }).success).toBe(false);
    expect(RepoStatusSchema.safeParse({ ...ok, commitSha: 'abc' }).success).toBe(false);
  });
});
