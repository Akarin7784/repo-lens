import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { parseJsonc } from '../typescript/tsconfig-reader.js';

/**
 * module 判定(BACKEND_AI_DESIGN.md §1,与 packages/shared graph.ts 注释一致):
 * 1. 有 workspace(pnpm-workspace.yaml 或 package.json#workspaces)→ 每个 workspace 包根目录是一个 module;
 * 2. 否则有 src/ → src/ 下一级目录;没有 src/ → 仓库根下一级目录;
 * 3. 其余文件归根模块 m:.;嵌套 workspace 包不再拆 module。
 */
export interface ModuleLayout {
  rule: 'workspace' | 'src-subdir' | 'root-subdir';
  /** module 根目录(相对仓库根),不含根模块 '.' */
  roots: string[];
}

function workspaceGlobs(repoRoot: string): string[] | null {
  const pnpm = join(repoRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    // 只取 packages: 下的列表项,足够覆盖常见写法,避免为此引入 YAML 依赖
    const globs: string[] = [];
    let inPackages = false;
    for (const line of readFileSync(pnpm, 'utf8').split('\n')) {
      if (/^packages\s*:/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
        if (m?.[1]) globs.push(m[1].trim());
      }
    }
    if (globs.length) return globs;
  }
  const pkgFile = join(repoRoot, 'package.json');
  if (existsSync(pkgFile)) {
    try {
      const pkg = parseJsonc(readFileSync(pkgFile, 'utf8')) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (ws?.length) return ws;
    } catch {
      /* 忽略损坏的 package.json */
    }
  }
  return null;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** 支持 `dir`、`dir/*`、`dir/**`;`!` 排除项 */
function expandGlobs(repoRoot: string, globs: string[]): string[] {
  const include = new Set<string>();
  const exclude = globs
    .filter((g) => g.startsWith('!'))
    .map((g) => posix.normalize(g.slice(1).replace(/\/$/, '')));
  for (const raw of globs.filter((g) => !g.startsWith('!'))) {
    const g = posix.normalize(raw.replace(/^\.\//, '').replace(/\/$/, ''));
    const m = /^(.*?)\/\*\*?$/.exec(g);
    const candidates = m
      ? isDir(join(repoRoot, m[1]!))
        ? readdirSync(join(repoRoot, m[1]!)).map((c) => posix.join(m[1]!, c))
        : []
      : [g];
    for (const c of candidates)
      if (!c.includes('*') && existsSync(join(repoRoot, c, 'package.json'))) include.add(c);
  }
  return [...include].filter((p) => !exclude.includes(p)).sort();
}

export function detectModuleLayout(repoRoot: string, files: readonly string[]): ModuleLayout {
  const globs = workspaceGlobs(repoRoot);
  if (globs) {
    const roots = expandGlobs(repoRoot, globs);
    // 嵌套包:只保留最外层
    const outer = roots.filter((r) => !roots.some((o) => o !== r && r.startsWith(`${o}/`)));
    if (outer.length) return { rule: 'workspace', roots: outer };
  }
  const hasSrc = files.some((f) => f.startsWith('src/'));
  const base = hasSrc ? 'src/' : '';
  const roots = new Set<string>();
  for (const f of files) {
    if (!f.startsWith(base)) continue;
    const rest = f.slice(base.length).split('/');
    if (rest.length >= 2) roots.add(base + rest[0]);
  }
  return { rule: hasSrc ? 'src-subdir' : 'root-subdir', roots: [...roots].sort() };
}

/** 文件所属 module 根目录;'.' 表示根模块 */
export function moduleRootOf(layout: ModuleLayout, file: string): string {
  let best = '.';
  for (const r of layout.roots) if (file.startsWith(`${r}/`) && r.length > best.length) best = r;
  return best === '.' || layout.roots.includes(best) ? best : '.';
}
