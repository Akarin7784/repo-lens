/** 规则摘要:不调 LLM,只用路径、导出名、语言、行数(预算熔断、fanIn 前 200 以外的文件、LLM 失败时使用) */
export interface RuleFileInfo {
  path: string;
  lang: string;
  loc: number;
  exports: string[];
}

const MAX_NAMES = 8;
const names = (xs: string[]) =>
  xs.length === 0
    ? '无'
    : xs.slice(0, MAX_NAMES).join(', ') + (xs.length > MAX_NAMES ? ` 等 ${xs.length} 个` : '');

export function ruleFileSummary(f: RuleFileInfo): string {
  return `${f.path}(${f.lang},${f.loc} 行),导出:${names(f.exports)}`;
}

export function ruleDirSummary(d: {
  path: string;
  kind: 'dir' | 'module';
  fileCount: number;
  loc: number;
  children: string[];
}): string {
  const k = d.kind === 'module' ? '模块' : '目录';
  return `${k} ${d.path}:${d.fileCount} 个文件,共 ${d.loc} 行;主要子项:${names(d.children)}`;
}

export function ruleRepoSummary(r: { name: string; fileCount: number; modules: string[] }): string {
  return `仓库 ${r.name}:${r.fileCount} 个源码文件,${r.modules.length} 个模块(${names(r.modules)})`;
}
