import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WorkerConfig } from './config.js';

/** 在临时目录建一个本地 git 仓库(测试克隆用),返回路径与 HEAD commit */
export function makeGitRepo(files: Record<string, string>): { url: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rl-src-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  const g = (...a: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      encoding: 'utf8',
    }).trim();
  g('init', '-q');
  g('add', '-A');
  g('commit', '-qm', 'init');
  // 允许按 SHA fetch(GitHub 默认允许)
  g('config', 'uploadpack.allowAnySHA1InWant', 'true');
  return { url: `file://${dir}`, sha: g('rev-parse', 'HEAD') };
}

export const SAMPLE_REPO = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/index.ts': "import { b } from './util/b';\nimport './style.css';\nexport const a = b + 1;\n",
  'src/util/b.ts': "import type { T } from '../types';\nexport const b: T = 1;\n",
  'src/types.ts': 'export type T = number;\n',
  'src/index.test.ts': "import { a } from './index';\n",
  'tests/e2e.ts': 'export {}\n',
  'docs/demo.ts': 'export {}\n',
  'README.md': '# x\n',
};

export function testConfig(over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    redisUrl: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379',
    databaseUrl: null,
    workdir: mkdtempSync(join(tmpdir(), 'rl-work-')),
    maxFiles: 5000,
    maxRepoBytes: 300 * 1024 * 1024,
    cloneTimeoutMs: 30_000,
    parseTimeoutMs: 5000,
    parseConcurrency: 4,
    concurrency: 1,
    ...over,
  };
}
