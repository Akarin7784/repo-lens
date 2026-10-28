import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isSourceFile } from './typescript/lang.js';

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'vendor',
  '.git',
  '.turbo',
]);
const MAX_FILE_BYTES = 500 * 1024;

/**
 * 简易源码扫描(测试与本地基准用)。正式流水线的 scanning 阶段(T-003)负责 .gitignore、二进制、
 * @generated、文件数上限等完整规则,并把结果作为 RepoSnapshot.files 传进来。
 */
export function scanSourceFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (!IGNORED_DIRS.has(ent.name)) out.push(...scanSourceFiles(root, p));
    } else if (
      ent.isFile() &&
      isSourceFile(p) &&
      !/\.min\.js$/.test(p) &&
      statSync(join(root, p)).size <= MAX_FILE_BYTES
    ) {
      out.push(p);
    }
  }
  return out.sort();
}
