// LanguageAnalyzer、registry、TypeScriptAnalyzer(T-002)
export const PACKAGE_NAME = '@repolens/analyzer';
export * from './types.js';
export * from './errors.js';
export * from './registry.js';
export * from './analyze.js';
export { TypeScriptAnalyzer } from './typescript/analyzer.js';
export type { TypeScriptAnalyzerOptions, ResolverStats } from './typescript/analyzer.js';
export { FallbackResolver } from './typescript/resolve-fallback.js';
export { readPathsConfig, type PathsConfig } from './typescript/tsconfig-reader.js';
export { buildGraph, findCycles, type FullGraph, type FileAnalysis } from './graph/build.js';
export { detectModuleLayout, moduleRootOf, type ModuleLayout } from './graph/modules.js';
export {
  scanRepo,
  scanSourceFiles,
  EXCLUDED_DIRS,
  EXCLUDED_FILE_RE,
  MAX_FILE_BYTES,
  type ScanResult,
  type ScanOptions,
} from './scan.js';
export { isAssetSpec, ASSET_EXTS, isSourceFile } from './typescript/lang.js';
