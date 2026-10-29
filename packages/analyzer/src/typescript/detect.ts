import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXCLUDED_DIRS } from '../scan.js';
import { extOf, isSourceFile } from './lang.js';

/**
 * TS/JS 仓库识别规则(P0,替代旧的「根目录必须有 tsconfig.json 且 TS ≥ 50%」):
 *
 * 记 tsjs = TS/JS 源码文件数(repo.files 里 isSourceFile 的),other = 仓库里其他主流语言源码文件数
 * (见 OTHER_SOURCE_EXTS,按扫描同一套 EXCLUDED_DIRS / 隐藏目录规则遍历),share = tsjs / (tsjs + other)。
 * - tsjs = 0 → 不支持;
 * - 根目录或任一非排除目录(如 packages/*、apps/*)里有 tsconfig*.json(含 tsconfig.base.json)→ share ≥ 20% 即支持;
 * - 没有任何 tsconfig*.json → share ≥ 50% 才支持(纯 JS 仓库也走这条)。
 *
 * 20% 的下限用来挡误判:例如 Java/Go 仓库里只有一个前端/文档站子目录带 tsconfig,TS/JS 占比通常远低于 20%。
 * 遍历有深度与条目上限,超大仓库只看前一部分,结论偏保守(other 少算 → 偏向支持;下游还有 API 侧 GitHub 语言门槛)。
 */
export const MIN_SHARE_WITH_TSCONFIG = 0.2;
export const MIN_SHARE_WITHOUT_TSCONFIG = 0.5;
const MAX_DEPTH = 8;
const MAX_ENTRIES = 200_000;

export const TSCONFIG_RE = /^tsconfig(\.[\w-]+)*\.json$/;
export const OTHER_SOURCE_EXTS: ReadonlySet<string> = new Set([
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.groovy',
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.cs',
  '.fs',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cxx',
  '.m',
  '.mm',
  '.swift',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hs',
  '.clj',
  '.lua',
  '.r',
  '.jl',
  '.zig',
  // 注意:.vue/.svelte 不计入 —— 这类单文件组件通常就是 TS/JS 前端项目的一部分,算作「其他语言」会把 Vue/Svelte 应用误拒
]);

export interface RepoSurvey {
  /** 含 tsconfig*.json 的目录(相对根,根为 '') */
  tsconfigDirs: string[];
  otherSourceFiles: number;
}

export function surveyRepo(root: string): RepoSurvey {
  const res: RepoSurvey = { tsconfigDirs: [], otherSourceFiles: 0 };
  let seen = 0;
  const walk = (rel: string, depth: number) => {
    let ents;
    try {
      ents = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (++seen > MAX_ENTRIES) return;
      if (ent.isSymbolicLink()) continue;
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (depth < MAX_DEPTH && !EXCLUDED_DIRS.has(ent.name) && !ent.name.startsWith('.'))
          walk(p, depth + 1);
      } else if (ent.isFile()) {
        if (TSCONFIG_RE.test(ent.name)) {
          if (!res.tsconfigDirs.includes(rel)) res.tsconfigDirs.push(rel);
        } else if (OTHER_SOURCE_EXTS.has(extOf(ent.name).toLowerCase())) res.otherSourceFiles++;
      }
    }
  };
  walk('', 0);
  return res;
}

export function isTsJsRepo(root: string, files: readonly string[]): boolean {
  const tsjs = files.filter(isSourceFile).length;
  if (tsjs === 0) return false;
  const s = surveyRepo(root);
  const share = tsjs / (tsjs + s.otherSourceFiles);
  return (
    share >= (s.tsconfigDirs.length > 0 ? MIN_SHARE_WITH_TSCONFIG : MIN_SHARE_WITHOUT_TSCONFIG)
  );
}
