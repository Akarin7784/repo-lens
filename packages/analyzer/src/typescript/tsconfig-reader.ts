import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';

export interface PathsConfig {
  /** baseUrl 相对仓库根的 POSIX 路径;未配置为 null */
  baseUrl: string | null;
  /** paths 映射,目标已换算为相对仓库根的 POSIX 路径 */
  paths: Array<{ pattern: string; targets: string[] }>;
}

/** 去掉 JSONC 的注释和尾逗号(不依赖 TypeScript,降级路径必须独立于 ts-morph) */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface RawCompilerOptions {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

/**
 * 读取 tsconfig 的 baseUrl/paths,跟随相对路径的 extends(最多 5 层,包名形式的 extends 忽略)。
 * paths 的目标相对于定义它的配置文件的 baseUrl(无 baseUrl 时相对该配置文件目录,TS ≥4.1 行为)。
 */
export function readPathsConfig(repoRoot: string, tsconfigRel = 'tsconfig.json'): PathsConfig {
  const toRel = (abs: string) => relative(repoRoot, abs).split('\\').join('/') || '.';
  let baseUrlAbs: string | null = null;
  let pathsBaseAbs: string | null = null;
  let paths: Record<string, string[]> | null = null;
  let file: string | null = join(repoRoot, tsconfigRel);
  for (let depth = 0; file && depth < 5 && existsSync(file); depth++) {
    const cfg = parseJsonc(readFileSync(file, 'utf8')) as {
      extends?: string;
      compilerOptions?: RawCompilerOptions;
    };
    const dir = dirname(file);
    const co = cfg.compilerOptions ?? {};
    // 子配置优先:只在尚未设置时采用父配置的值
    if (co.baseUrl !== undefined && baseUrlAbs === null) baseUrlAbs = join(dir, co.baseUrl);
    if (co.paths && paths === null) {
      paths = co.paths;
      pathsBaseAbs = co.baseUrl !== undefined ? join(dir, co.baseUrl) : dir;
    }
    const ext = typeof cfg.extends === 'string' && cfg.extends.startsWith('.') ? cfg.extends : null;
    file = ext ? join(dir, ext.endsWith('.json') ? ext : `${ext}.json`) : null;
  }
  if (paths && baseUrlAbs !== null && pathsBaseAbs !== baseUrlAbs) pathsBaseAbs = baseUrlAbs;
  return {
    baseUrl: baseUrlAbs === null ? null : toRel(baseUrlAbs),
    paths: Object.entries(paths ?? {}).map(([pattern, targets]) => ({
      pattern,
      targets: targets.map((t) => posix.normalize(posix.join(toRel(pathsBaseAbs ?? repoRoot), t))),
    })),
  };
}
