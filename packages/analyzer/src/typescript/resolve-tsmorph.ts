import { join, relative } from 'node:path';
import { Project, ts } from 'ts-morph';
import type { ResolvedImport } from '../types.js';
import { packageName } from './lang.js';

export type ProjectFactory = (opts: { repoRoot: string; tsconfigPath: string | null }) => Project;

/**
 * 只用 ts-morph 读取 tsconfig(含 extends 链、paths、moduleResolution),不把所有源文件加载进 Project:
 * 解析 import 只需要 TS 的模块解析算法(ts.resolveModuleName),加载 AST 会让大仓库内存和耗时翻倍,
 * 而 AST 已由 Tree-sitter 提供。
 */
export const defaultProjectFactory: ProjectFactory = ({ repoRoot, tsconfigPath }) =>
  tsconfigPath
    ? new Project({
        tsConfigFilePath: join(repoRoot, tsconfigPath),
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true,
      })
    : new Project({
        compilerOptions: {
          allowJs: true,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
        skipFileDependencyResolution: true,
      });

export class TsMorphResolver {
  private readonly options: ts.CompilerOptions;
  private readonly host: ts.ModuleResolutionHost;
  private readonly cache: ts.ModuleResolutionCache;

  constructor(
    private readonly repoRoot: string,
    private readonly files: ReadonlySet<string>,
    project: Project,
  ) {
    this.options = { ...project.getCompilerOptions(), allowJs: true };
    this.host = project.getModuleResolutionHost();
    this.cache = ts.createModuleResolutionCache(repoRoot, (s) => s, this.options);
  }

  /** 返回 null 表示 TS 未能解析(由调用方决定是否再走降级) */
  resolve(fromFile: string, spec: string): ResolvedImport | null {
    const res = ts.resolveModuleName(
      spec,
      join(this.repoRoot, fromFile),
      this.options,
      this.host,
      this.cache,
    ).resolvedModule;
    if (!res) return null;
    const rel = relative(this.repoRoot, res.resolvedFileName).split('\\').join('/');
    // 解析进 node_modules 或仓库外 → 外部包
    if (
      res.isExternalLibraryImport ||
      rel.startsWith('../') ||
      rel.includes('/node_modules/') ||
      rel.startsWith('node_modules/')
    ) {
      const pkg = packageName(spec);
      return pkg ? { type: 'external', pkg } : { type: 'unresolved' };
    }
    if (this.files.has(rel)) return { type: 'internal', path: rel };
    // 解析到了 .d.ts 或被扫描规则排除的文件:不是图中节点
    return { type: 'unresolved' };
  }
}
