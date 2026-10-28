import { lstatSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSourceFile } from './typescript/lang.js';

/**
 * 扫描规则(T-003 定稿,PR 与 BACKEND_AI_DESIGN §1 同步):
 * - 目录:构建产物与依赖(node_modules、dist、build、out、coverage、vendor、.next、.turbo 等),
 *   测试(test、tests、__tests__、__mocks__、__fixtures__、fixtures、e2e),
 *   文档/示例/基准(docs、doc、examples、example、bench、benchmark、benchmarks),
 *   以及所有以 `.` 开头的隐藏目录(.git、.github、.claude 等)。
 * - 文件:测试与基准文件(*.test.*、*.spec.*、*.bench.*、*.test-d.ts)、*.min.js、*.d.ts(由 isSourceFile 排除)、
 *   超过 500KB、前 8KB 含 NUL(二进制)、前 1KB 含 `@generated` 的生成文件。
 * - 符号链接一律跳过(不跟随),防止逃出仓库根。
 */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'jspm_packages',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  '__fixtures__',
  'fixtures',
  'e2e',
  'docs',
  'doc',
  'examples',
  'example',
  'bench',
  'benchmark',
  'benchmarks',
]);
export const EXCLUDED_FILE_RE = /\.(test|spec|bench)\.[cm]?[jt]sx?$|\.test-d\.tsx?$|\.min\.js$/;
export const MAX_FILE_BYTES = 500 * 1024;

export interface ScanResult {
  /** 进入分析的源码文件(相对根的 POSIX 路径,已排序) */
  files: string[];
  /** 仓库工作区总字节数(不含 .git,含被排除的文件,用于 300MB 上限) */
  totalBytes: number;
  /** 被规则跳过的计数 */
  skipped: {
    excludedDirs: number;
    excludedFiles: number;
    tooLarge: number;
    binary: number;
    generated: number;
    symlinks: number;
  };
}

function head(abs: string, n: number): Buffer {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(n);
    const len = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, len);
  } finally {
    closeSync(fd);
  }
}

export interface ScanOptions {
  /** 超过该文件数立即停止遍历(Worker 用来尽早判定 REPO_TOO_LARGE) */
  maxFiles?: number;
}

/** 扫描仓库源码文件,应用上面的排除规则。只读文件元数据和文件头,不执行任何仓库代码。 */
export function scanRepo(root: string, opts: ScanOptions = {}): ScanResult {
  const res: ScanResult = {
    files: [],
    totalBytes: 0,
    skipped: {
      excludedDirs: 0,
      excludedFiles: 0,
      tooLarge: 0,
      binary: 0,
      generated: 0,
      symlinks: 0,
    },
  };
  const walk = (rel: string, excluded: boolean) => {
    for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (rel === '' && ent.name === '.git') continue;
      const p = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) {
        res.skipped.symlinks++;
        continue;
      }
      if (ent.isDirectory()) {
        const ex = excluded || EXCLUDED_DIRS.has(ent.name) || ent.name.startsWith('.');
        if (ex && !excluded) res.skipped.excludedDirs++;
        walk(p, ex);
        continue;
      }
      if (!ent.isFile()) continue;
      const abs = join(root, p);
      const size = lstatSync(abs).size;
      res.totalBytes += size;
      if (excluded || !isSourceFile(p)) continue;
      if (opts.maxFiles !== undefined && res.files.length > opts.maxFiles) continue;
      if (EXCLUDED_FILE_RE.test(p)) {
        res.skipped.excludedFiles++;
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        res.skipped.tooLarge++;
        continue;
      }
      const h = head(abs, 8192);
      if (h.includes(0)) {
        res.skipped.binary++;
        continue;
      }
      if (h.subarray(0, 1024).toString('utf8').includes('@generated')) {
        res.skipped.generated++;
        continue;
      }
      res.files.push(p);
    }
  };
  walk('', false);
  res.files.sort();
  return res;
}

/** 只要文件列表的简写(基准脚本与测试用),规则与 scanRepo 一致 */
export function scanSourceFiles(root: string): string[] {
  return scanRepo(root).files;
}
