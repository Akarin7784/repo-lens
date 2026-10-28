import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphData } from '@repolens/shared';
import { buildGraph, type FileAnalysis, type FullGraph } from './graph/build.js';
import { detectModuleLayout, type ModuleLayout } from './graph/modules.js';
import { AnalyzerRegistry } from './registry.js';
import { isSourceFile } from './typescript/lang.js';
import { TypeScriptAnalyzer, type TypeScriptAnalyzerOptions } from './typescript/analyzer.js';
import type { ParsedFile, RepoSnapshot, ResolverMode } from './types.js';

export interface AnalyzeResult {
  graph: FullGraph;
  parsed: ParsedFile[];
  layout: ModuleLayout;
  resolverMode: ResolverMode;
  stats: {
    files: number;
    nodes: number;
    edges: number;
    externalPackages: number;
    unresolved: number;
    syntaxErrorFiles: number;
    resolver: TypeScriptAnalyzer['stats'];
    ms: { parse: number; resolve: number; build: number; total: number };
  };
}

export interface AnalyzeOptions extends TypeScriptAnalyzerOptions {
  tsconfigPath?: string;
}

/** 第 1 周只注册 TypeScript;非 TS 仓库 detect() 抛 UNSUPPORTED_LANGUAGE */
export function createRegistry(
  files: ReadonlySet<string>,
  opts: AnalyzeOptions = {},
): AnalyzerRegistry {
  return new AnalyzerRegistry().register(() => new TypeScriptAnalyzer(files, opts));
}

/**
 * 分析入口(Worker 的 parsing 阶段调用):detect → init → Tree-sitter 抽取 → 解析 import → 建三层图。
 * repo.files 由扫描阶段给出(已应用忽略规则与大小上限);这里只再过滤出源码文件。
 */
export async function analyzeRepo(
  repo: RepoSnapshot,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const t0 = performance.now();
  const files = repo.files.filter(isSourceFile).sort();
  const fileSet = new Set(files);
  const analyzer = await createRegistry(fileSet, opts).detect(repo);
  try {
    await analyzer.init({ repoRoot: repo.root, tsconfigPath: opts.tsconfigPath });
    const parsed: ParsedFile[] = [];
    for (const path of files)
      parsed.push(
        await analyzer.parseFile({ path, content: readFileSync(join(repo.root, path), 'utf8') }),
      );
    const t1 = performance.now();
    const analyses: FileAnalysis[] = parsed.map((p) => ({
      parsed: p,
      resolved: p.imports.map((i) => analyzer.resolveImport(p.path, i.spec)),
    }));
    const t2 = performance.now();
    const layout = detectModuleLayout(repo.root, files);
    const graph = buildGraph(analyses, layout);
    const t3 = performance.now();
    const ext = new Set(
      graph.nodes.flatMap((n) => (n.type === 'file' ? (n.externalDeps ?? []) : [])),
    );
    return {
      graph,
      parsed,
      layout,
      resolverMode: analyzer.resolverMode,
      stats: {
        files: files.length,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        externalPackages: ext.size,
        unresolved: graph.unresolved.length,
        syntaxErrorFiles: parsed.filter((p) => p.hasSyntaxError).length,
        resolver: (analyzer as TypeScriptAnalyzer).stats,
        ms: { parse: t1 - t0, resolve: t2 - t1, build: t3 - t2, total: t3 - t0 },
      },
    };
  } finally {
    analyzer.dispose();
  }
}

/** 全量图 → GraphData(仅用于 ≤300 节点的小仓库/测试;按 parentId 投影与边聚合在 T-003 API 层) */
export function toGraphData(g: FullGraph, meta: { repoId: number; commitSha: string }): GraphData {
  return {
    nodes: g.nodes,
    edges: g.edges,
    meta: {
      repoId: meta.repoId,
      commitSha: meta.commitSha,
      parentId: null,
      language: 'typescript',
      ...(g.cycles.length ? { cycles: g.cycles as never } : {}),
    },
  };
}
