import { describe, expect, it } from 'vitest';
import {
  ChatEventSchema,
  ChatRequestSchema,
  CreateRepoRequestSchema,
  GraphDataSchema,
  JobEventSchema,
  NodeDetailSchema,
  PROGRESS_STAGES,
  fileId,
  moduleId,
} from './index.js';

const graph = {
  nodes: [
    { id: 'm:src', type: 'module', label: 'src' },
    { id: 'f:src/compose.ts', type: 'file', label: 'compose.ts', parentId: 'm:src', loc: 72 },
    { id: 'f:src/hono.ts', type: 'file', label: 'hono.ts', parentId: 'm:src' },
  ],
  edges: [
    { id: 'e1', source: 'f:src/hono.ts', target: 'f:src/compose.ts', kind: 'import', weight: 1 },
  ],
  meta: { repoId: 12, commitSha: 'a1b2c3d', parentId: null, language: 'typescript' },
};

describe('ids', () => {
  it('确定性生成 nodeId', () => {
    expect(fileId('./src/a.ts')).toBe('f:src/a.ts');
    expect(moduleId('src\\core/')).toBe('m:src/core');
  });
});

describe('GraphDataSchema', () => {
  it('接受合法图', () => expect(GraphDataSchema.safeParse(graph).success).toBe(true));
  it('meta.layout 不属于 schema,解析后被剥离', () => {
    const bad = { ...graph, meta: { ...graph.meta, layout: {} } };
    expect(GraphDataSchema.parse(bad).meta).not.toHaveProperty('layout');
  });
  it('拒绝非法 nodeId', () => {
    const bad = { ...graph, nodes: [{ id: 'src/a.ts', type: 'file', label: 'a' }], edges: [] };
    expect(GraphDataSchema.safeParse(bad).success).toBe(false);
  });
  it('拒绝悬空边', () => {
    const bad = { ...graph, edges: [{ ...graph.edges[0], target: 'f:nope.ts' }] };
    expect(GraphDataSchema.safeParse(bad).success).toBe(false);
  });
  it('拒绝超过 300 个节点', () => {
    const nodes = Array.from({ length: 301 }, (_, i) => ({
      id: `f:${i}.ts`,
      type: 'file',
      label: `${i}`,
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
          moduleId: 'm:core',
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
