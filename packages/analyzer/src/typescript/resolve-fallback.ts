import { posix } from 'node:path';
import type { ResolvedImport } from '../types.js';
import { isRelative, packageName } from './lang.js';
import type { PathsConfig } from './tsconfig-reader.js';

const CANDIDATE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** 匹配 paths 模式(最多一个 '*'),返回 '*' 捕获内容;不匹配返回 null */
function matchPattern(pattern: string, spec: string): string | null {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === spec ? '' : null;
  const pre = pattern.slice(0, star);
  const post = pattern.slice(star + 1);
  if (spec.length < pre.length + post.length || !spec.startsWith(pre) || !spec.endsWith(post))
    return null;
  return spec.slice(pre.length, spec.length - post.length);
}

/**
 * 降级解析器:不依赖 TypeScript 编译器,只做
 * 1) tsconfig paths 前缀替换(最长前缀优先,与 tsc 一致) 2) baseUrl 非相对解析 3) 扩展名/index 补全。
 * 文件存在性只看本次分析的文件集合,所以结果确定、可测。
 */
export class FallbackResolver {
  private readonly patterns: PathsConfig['paths'];

  constructor(
    private readonly files: ReadonlySet<string>,
    private readonly cfg: PathsConfig,
  ) {
    // tsc 规则:前缀(星号前部分)最长的模式优先
    this.patterns = [...cfg.paths].sort((a, b) => b.pattern.indexOf('*') - a.pattern.indexOf('*'));
  }

  /** 在文件集合里按 TS 的补全顺序找目标 */
  probe(base: string): string | null {
    const b = posix.normalize(base).replace(/^\.\//, '');
    if (b.startsWith('../')) return null;
    if (this.files.has(b)) return b;
    const ext = posix.extname(b);
    for (const alt of JS_TO_TS[ext] ?? []) {
      const p = b.slice(0, -ext.length) + alt;
      if (this.files.has(p)) return p;
    }
    for (const e of CANDIDATE_EXTS) if (this.files.has(b + e)) return b + e;
    for (const e of CANDIDATE_EXTS) if (this.files.has(`${b}/index${e}`)) return `${b}/index${e}`;
    return null;
  }

  /** 说明符是否命中某个 paths 别名(用于区分“别名但解析失败”和“外部包”) */
  matchesAlias(spec: string): boolean {
    return this.patterns.some((p) => matchPattern(p.pattern, spec) !== null);
  }

  resolve(fromFile: string, spec: string): ResolvedImport {
    if (isRelative(spec)) {
      const hit = this.probe(posix.join(posix.dirname(fromFile), spec));
      return hit ? { type: 'internal', path: hit } : { type: 'unresolved' };
    }
    for (const p of this.patterns) {
      const cap = matchPattern(p.pattern, spec);
      if (cap === null) continue;
      for (const t of p.targets) {
        const hit = this.probe(t.replace('*', cap));
        if (hit) return { type: 'internal', path: hit };
      }
      return { type: 'unresolved' };
    }
    if (this.cfg.baseUrl !== null) {
      const hit = this.probe(posix.join(this.cfg.baseUrl, spec));
      if (hit) return { type: 'internal', path: hit };
    }
    const pkg = packageName(spec);
    return pkg ? { type: 'external', pkg } : { type: 'unresolved' };
  }
}
