import { cpSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GraphDataSchema, GraphEdgeSchema, GraphNodeSchema } from '@repolens/shared';
import {
  AnalyzerError,
  analyzeRepo,
  createRegistry,
  detectModuleLayout,
  scanSourceFiles,
  toGraphData,
  type AnalyzeResult,
} from './index.js';

const FIXTURE = fileURLToPath(new URL('../test/fixtures/ts-basic', import.meta.url));
const SHA = 'c31061f';

async function run(opts: Parameters<typeof analyzeRepo>[1] = {}): Promise<AnalyzeResult> {
  return analyzeRepo({ root: FIXTURE, files: scanSourceFiles(FIXTURE) }, opts);
}
const edgeIds = (r: AnalyzeResult) => r.graph.edges.map((e) => e.id).sort();
const e = (s: string, t: string, k: string) => `e:f:src/${s}->f:src/${t}:${k}`;

describe.each([
  ['ts-morph', {}],
  [
    'fallback(ts-morph 初始化失败)',
    {
      projectFactory: () => {
        throw new Error('simulated ts-morph failure');
      },
    },
  ],
] as const)('fixtures/ts-basic — %s', (mode, opts) => {
  it('解析器模式符合预期', async () => {
    const r = await run(opts);
    expect(r.resolverMode).toBe(mode === 'ts-morph' ? 'ts-morph' : 'fallback');
    expect(r.graph.unresolved).toEqual([]);
  });

  it('① tsconfig paths 别名:@utils、@core/* 解析到真实文件', async () => {
    const ids = edgeIds(await run(opts));
    expect(ids).toContain(e('index.ts', 'utils/index.ts', 'static'));
    expect(ids).toContain(e('index.ts', 'core/types.ts', 'type-only'));
  });

  it('② barrel 与 re-export:export * / export {x} from / export * as ns', async () => {
    const ids = edgeIds(await run(opts));
    expect(ids).toContain(e('index.ts', 'features/index.ts', 're-export'));
    expect(ids).toContain(e('features/index.ts', 'features/a/index.ts', 're-export'));
    expect(ids).toContain(e('features/index.ts', 'features/b/index.ts', 're-export'));
    expect(ids).toContain(e('utils/index.ts', 'utils/date.ts', 're-export'));
    expect(ids).toContain(e('utils/index.ts', 'utils/string.ts', 're-export'));
  });

  it('③ 动态 import() 与 require()', async () => {
    const ids = edgeIds(await run(opts));
    expect(ids).toContain(e('index.ts', 'features/b/heavy.ts', 'dynamic'));
    expect(ids).toContain(e('features/b/heavy.ts', 'features/a/index.ts', 'require'));
  });

  it('④ import type 标为 type-only,且不参与环检测', async () => {
    const r = await run(opts);
    const typeEdges = r.graph.edges.filter((x) => x.kind === 'type-only');
    expect(typeEdges.map((x) => x.id)).toEqual([e('index.ts', 'core/types.ts', 'type-only')]);
  });

  it('⑤ 循环依赖:core/app ↔ core/helper', async () => {
    const r = await run(opts);
    expect(r.graph.cycles).toEqual([['f:src/core/app.ts', 'f:src/core/helper.ts']]);
  });

  it('⑥ 外部依赖只记在 file.externalDeps,不产生节点/边', async () => {
    const r = await run(opts);
    const app = r.graph.nodes.find((n) => n.id === 'f:src/core/app.ts');
    expect(app?.type === 'file' && app.externalDeps).toEqual(['lodash']);
    expect(r.graph.nodes.some((n) => n.type === 'external')).toBe(false);
    expect(r.graph.edges.every((x) => x.target.startsWith('f:'))).toBe(true);
  });

  it('完整边集合(快照)', async () => {
    expect(edgeIds(await run(opts))).toEqual([
      'e:f:src/core/app.ts->f:src/core/helper.ts:static',
      'e:f:src/core/helper.ts->f:src/core/app.ts:static',
      'e:f:src/features/a/index.ts->f:src/utils/string.ts:static',
      'e:f:src/features/b/heavy.ts->f:src/features/a/index.ts:require',
      'e:f:src/features/index.ts->f:src/features/a/index.ts:re-export',
      'e:f:src/features/index.ts->f:src/features/b/index.ts:re-export',
      'e:f:src/index.ts->f:src/core/app.ts:static',
      'e:f:src/index.ts->f:src/core/types.ts:type-only',
      'e:f:src/index.ts->f:src/features/b/heavy.ts:dynamic',
      'e:f:src/index.ts->f:src/features/index.ts:re-export',
      'e:f:src/index.ts->f:src/utils/index.ts:static',
      'e:f:src/ui.tsx->f:src/features/index.ts:static',
      'e:f:src/utils/index.ts->f:src/utils/date.ts:re-export',
      'e:f:src/utils/index.ts->f:src/utils/string.ts:re-export',
    ]);
  });
});

describe('三层图结构', () => {
  it('module 规则:无 workspace → src/ 下一级目录为 module,其余归 m:.', async () => {
    const r = await run();
    expect(r.layout).toEqual({
      rule: 'src-subdir',
      roots: ['src/core', 'src/features', 'src/utils'],
    });
    const byId = new Map(r.graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('f:src/index.ts')?.parentId).toBe('d:src');
    expect(byId.get('d:src')?.parentId).toBe('m:.');
    expect(byId.get('f:src/features/b/heavy.ts')?.parentId).toBe('d:src/features/b');
    expect(byId.get('d:src/features/b')?.parentId).toBe('m:src/features');
    expect(byId.get('f:src/core/app.ts')?.parentId).toBe('m:src/core');
    // 每个非 module 节点的 parent 都存在
    for (const n of r.graph.nodes) if (n.parentId) expect(byId.has(n.parentId)).toBe(true);
  });

  it('通过 packages/shared 的 zod GraphDataSchema 校验', async () => {
    const r = await run();
    const data = toGraphData(r.graph, { repoId: 1, commitSha: SHA });
    const parsed = GraphDataSchema.safeParse(data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    for (const n of r.graph.nodes) GraphNodeSchema.parse(n);
    for (const x of r.graph.edges) GraphEdgeSchema.parse(x);
  });

  it('确定性:两次运行输出完全一致', async () => {
    const a = await run();
    const b = await run();
    expect(JSON.stringify(a.graph)).toBe(JSON.stringify(b.graph));
  });

  it('Tree-sitter 抽取符号与 chunk', async () => {
    const r = await run();
    const helper = r.parsed.find((p) => p.path === 'src/core/helper.ts');
    expect(helper?.symbols.length).toBeGreaterThan(0);
    expect(helper?.chunks.length).toBeGreaterThan(0);
    expect(r.parsed.every((p) => !p.hasSyntaxError)).toBe(true);
  });
});

describe('workspace 与语言识别', () => {
  it('workspace 仓库:每个包根目录一个 module', () => {
    const root = mkdtempSync(join(tmpdir(), 'rl-ws-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - apps/web\n");
    for (const p of ['packages/a', 'packages/b', 'apps/web']) {
      mkdirSync(join(root, p, 'src'), { recursive: true });
      writeFileSync(join(root, p, 'package.json'), '{}');
    }
    const layout = detectModuleLayout(root, [
      'packages/a/src/x.ts',
      'apps/web/src/y.ts',
      'scripts/z.ts',
    ]);
    expect(layout).toEqual({ rule: 'workspace', roots: ['apps/web', 'packages/a', 'packages/b'] });
  });

  it('非 TS 仓库 → UNSUPPORTED_LANGUAGE', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rl-py-'));
    writeFileSync(join(root, 'main.py'), 'print(1)\n');
    const err = await createRegistry(new Set())
      .detect({ root, files: ['main.py'] })
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(AnalyzerError);
    expect((err as AnalyzerError).code).toBe('UNSUPPORTED_LANGUAGE');
  });

  it('语法错误文件不中断分析,标记 hasSyntaxError', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rl-bad-'));
    cpSync(FIXTURE, root, { recursive: true });
    writeFileSync(
      join(root, 'src/broken.ts'),
      "import { a } from './core/app';\nexport const = ;\n",
    );
    const r = await analyzeRepo({ root, files: scanSourceFiles(root) });
    expect(r.parsed.find((p) => p.path === 'src/broken.ts')?.hasSyntaxError).toBe(true);
    expect(r.graph.edges.map((x) => x.id)).toContain('e:f:src/broken.ts->f:src/core/app.ts:static');
  });
});
