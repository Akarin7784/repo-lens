import { exclusionRule } from '@repolens/shared';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GraphData } from '@repolens/shared';
import { buildGraph, type FileAnalysis, type FullGraph } from './graph/build.js';
import { detectModuleLayout, type ModuleLayout } from './graph/modules.js';
import { AnalyzerRegistry } from './registry.js';
import pLimit from 'p-limit';
import { isAssetSpec, isSourceFile } from './typescript/lang.js';
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
    /** 资源类 import(.css/.svg 等)条数:只计数,不进图 */
    assetImports: number;
    /** 解析超时的文件(节点保留,无 import/符号) */
    timedOutFiles: string[];
    resolver: TypeScriptAnalyzer['stats'];
    ms: { parse: number; resolve: number; build: number; total: number };
  };
}

export interface AnalyzeOptions extends TypeScriptAnalyzerOptions {
  tsconfigPath?: string;
  /** 文件读取 + 解析的并发上限(p-limit),默认 8 */
  concurrency?: number;
  /** 每完成一个文件回调一次(Worker 用来上报 parsing 进度) */
  onFileParsed?: (done: number, total: number) => void | Promise<void>;
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
    // 读文件是异步 I/O,用 p-limit 控并发;Tree-sitter 解析本身同步执行,单文件超时由 setTimeoutMicros 保证
    const limit = pLimit(Math.max(1, opts.concurrency ?? 8));
    let done = 0;
    const parsed: ParsedFile[] = await Promise.all(
      files.map((path) =>
        limit(async () => {
          const content = await readFile(join(repo.root, path), 'utf8');
          // 敏感判断用整份原始内容、在切块之前做:key 落在切块边界或不在任何切块里也能命中
          const rule = exclusionRule(path, content);
          const p = await analyzer.parseFile({ path, content });
          // 敏感文件:保留图结构(导入关系),但不产出切块,内容不会进 embedding 与检索
          if (rule) {
            p.chunks = [];
            p.sensitive = rule;
          }
          done++;
          await opts.onFileParsed?.(done, files.length);
          return p;
        }),
      ),
    );
    const t1 = performance.now();
    let assetImports = 0;
    const analyses: FileAnalysis[] = parsed.map((p) => ({
      parsed: p,
      resolved: p.imports.map((i) => {
        if (isAssetSpec(i.spec)) {
          assetImports++;
          return { type: 'asset' as const };
        }
        return analyzer.resolveImport(p.path, i.spec);
      }),
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
        assetImports,
        timedOutFiles: parsed.filter((p) => p.timedOut).map((p) => p.path),
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
