import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AnalyzerInitContext,
  LanguageAnalyzer,
  ParsedFile,
  RepoSnapshot,
  ResolvedImport,
  ResolverMode,
  SourceFile,
} from '../types.js';
import { isTsFile, isSourceFile, isRelative } from './lang.js';
import { FallbackResolver } from './resolve-fallback.js';
import { defaultProjectFactory, TsMorphResolver, type ProjectFactory } from './resolve-tsmorph.js';
import { parseWithTreeSitter } from './treesitter.js';
import { readPathsConfig } from './tsconfig-reader.js';

export interface TypeScriptAnalyzerOptions {
  /** 测试注入点:模拟 ts-morph 初始化失败 */
  projectFactory?: ProjectFactory;
  /** 单文件 Tree-sitter 解析超时(毫秒),默认 5000 */
  parseTimeoutMs?: number;
}

export interface ResolverStats {
  tsMorph: number;
  fallback: number;
  /** ts-morph 单次调用抛错后改走降级的次数 */
  tsMorphErrors: number;
  initError: string | null;
}

/**
 * 双层解析:
 * - Tree-sitter:所有文件的语法抽取(快、容错、与语言无关的 Query,将来接 Python 只换语法)。
 * - ts-morph(TypeScript 模块解析):把说明符解析成真实文件,覆盖 paths/baseUrl/extends/index/.js→.ts。
 * ts-morph 初始化失败(tsconfig 损坏、extends 的包没装等)→ 整体降级为 FallbackResolver;
 * 单次解析抛错或返回 null → 该条用 FallbackResolver 补一次。
 */
export class TypeScriptAnalyzer implements LanguageAnalyzer {
  readonly id = 'typescript' as const;
  private tsm: TsMorphResolver | null = null;
  private fallback: FallbackResolver | null = null;
  private mode: ResolverMode = 'fallback';
  readonly stats: ResolverStats = { tsMorph: 0, fallback: 0, tsMorphErrors: 0, initError: null };

  constructor(
    private readonly files: ReadonlySet<string>,
    private readonly opts: TypeScriptAnalyzerOptions = {},
  ) {}

  get resolverMode(): ResolverMode {
    return this.mode;
  }

  /** 识别规则(ARCHITECTURE §4.1):根目录有 tsconfig.json 且 TS 文件占源码 ≥ 50% */
  async supports(repo: RepoSnapshot): Promise<boolean> {
    if (!existsSync(join(repo.root, 'tsconfig.json'))) return false;
    const src = repo.files.filter(isSourceFile);
    if (src.length === 0) return false;
    return src.filter(isTsFile).length / src.length >= 0.5;
  }

  async init(ctx: AnalyzerInitContext): Promise<void> {
    const tsconfigPath =
      ctx.tsconfigPath ??
      (existsSync(join(ctx.repoRoot, 'tsconfig.json')) ? 'tsconfig.json' : null);
    let pathsCfg: ReturnType<typeof readPathsConfig> = { baseUrl: null, paths: [] };
    try {
      if (tsconfigPath) pathsCfg = readPathsConfig(ctx.repoRoot, tsconfigPath);
    } catch {
      // tsconfig 连 JSONC 都解析不了:降级解析器只做相对路径补全
    }
    this.fallback = new FallbackResolver(this.files, pathsCfg);
    try {
      const project = (this.opts.projectFactory ?? defaultProjectFactory)({
        repoRoot: ctx.repoRoot,
        tsconfigPath,
      });
      this.tsm = new TsMorphResolver(ctx.repoRoot, this.files, project);
      this.mode = 'ts-morph';
    } catch (err) {
      this.tsm = null;
      this.mode = 'fallback';
      this.stats.initError = err instanceof Error ? err.message : String(err);
    }
  }

  async parseFile(file: SourceFile): Promise<ParsedFile> {
    return parseWithTreeSitter(file, { timeoutMs: this.opts.parseTimeoutMs ?? 5000 });
  }

  resolveImport(fromFile: string, spec: string): ResolvedImport {
    if (!this.fallback) throw new Error('TypeScriptAnalyzer.init() 尚未调用');
    if (this.tsm) {
      try {
        const r = this.tsm.resolve(fromFile, spec);
        if (r && r.type !== 'unresolved') {
          this.stats.tsMorph++;
          return r;
        }
        // TS 解析不到:相对路径/别名再用降级规则试一次(例如 moduleResolution=classic 的老仓库)
        if (r === null || isRelative(spec) || this.fallback.matchesAlias(spec)) {
          const f = this.fallback.resolve(fromFile, spec);
          if (f.type === 'internal') this.stats.fallback++;
          return f;
        }
        return r;
      } catch {
        this.stats.tsMorphErrors++;
      }
    }
    this.stats.fallback++;
    return this.fallback.resolve(fromFile, spec);
  }

  dispose(): void {
    this.tsm = null;
  }
}
