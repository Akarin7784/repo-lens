/**
 * LanguageAnalyzer 扩展口(ARCHITECTURE.md §4.1,BACKEND_AI_DESIGN.md §1「解析器接口与初始化钩子」)。
 * 分析器只做语法级抽取,不做类型推断;图的组装(module → dir → file)在 graph/ 中与语言无关。
 */
import type { ImportKind } from '@repolens/shared';

/** 一次分析的仓库快照:根目录 + 相对根的 POSIX 路径列表(由扫描阶段给出) */
export interface RepoSnapshot {
  root: string;
  files: string[];
}

export interface SourceFile {
  /** 相对仓库根的 POSIX 路径 */
  path: string;
  content: string;
}

export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'var';

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  /** 1 基行号,闭区间 */
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface RawImport {
  /** 源码中的模块说明符,例如 './a'、'@core/x'、'react' */
  spec: string;
  kind: ImportKind;
  line: number;
}

/** 代码块:RAG 切块用(W2 使用),顶层声明粒度,没有声明时整文件一块 */
export interface CodeChunk {
  symbol: string | null;
  startLine: number;
  endLine: number;
}

export interface ParsedFile {
  path: string;
  loc: number;
  imports: RawImport[];
  symbols: ParsedSymbol[];
  /** 导出名(named / default / re-export 的别名;`export *` 记为 '*') */
  exports: string[];
  chunks: CodeChunk[];
  /** Tree-sitter 语法树里有 ERROR 节点(仍尽量抽取) */
  hasSyntaxError: boolean;
  /** 单文件解析超时(Tree-sitter setTimeoutMicros),此时 imports/symbols 为空,文件仍作为节点保留 */
  timedOut?: boolean;
}

export interface AnalyzerInitContext {
  repoRoot: string;
  /** 相对仓库根的 tsconfig 路径,缺省为 tsconfig.json */
  tsconfigPath?: string;
}

/** import 解析结果:内部文件 / 外部包 / 无法解析 */
/** asset:样式/图片/字体等资源说明符(如 './a.css'),只计数,不进图、不算 unresolved */
export type ResolvedImport =
  | { type: 'internal'; path: string }
  | { type: 'external'; pkg: string }
  | { type: 'asset' }
  | { type: 'unresolved' };

export type ResolverMode = 'ts-morph' | 'fallback';

export interface LanguageAnalyzer {
  readonly id: 'typescript' | 'javascript' | 'python' | 'go';
  supports(repo: RepoSnapshot): Promise<boolean>;
  /** 有状态初始化(如 ts-morph Project);失败时分析器自行切到降级模式,不抛错 */
  init(ctx: AnalyzerInitContext): Promise<void>;
  parseFile(file: SourceFile): Promise<ParsedFile>;
  /** 必须在 init 之后调用;from 为源文件相对路径 */
  resolveImport(fromFile: string, spec: string): ResolvedImport;
  /** 当前使用的解析模式(PR/日志可见) */
  readonly resolverMode: ResolverMode;
  dispose(): void;
}
