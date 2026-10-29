import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLlmConfig, type LlmConfig } from '@repolens/agent';

export interface WorkerConfig {
  redisUrl: string;
  databaseUrl: string | null;
  /** 仓库快照根目录(只读挂载给 API) */
  workdir: string;
  maxFiles: number;
  maxRepoBytes: number;
  cloneTimeoutMs: number;
  parseTimeoutMs: number;
  parseConcurrency: number;
  concurrency: number;
  /** LLM 配置(T-210);非法时 loadConfig 直接抛错,worker 启动失败 */
  llm: LlmConfig;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(env = process.env): WorkerConfig {
  return {
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    databaseUrl: env.DATABASE_URL ?? null,
    workdir: env.REPOS_DIR ?? join(tmpdir(), 'repolens-repos'),
    maxFiles: num(env.MAX_FILES, 5000),
    maxRepoBytes: num(env.MAX_REPO_MB, 300) * 1024 * 1024,
    cloneTimeoutMs: num(env.CLONE_TIMEOUT_MS, 120_000),
    parseTimeoutMs: num(env.PARSE_TIMEOUT_MS, 5000),
    parseConcurrency: num(env.PARSE_CONCURRENCY, 8),
    concurrency: num(env.WORKER_CONCURRENCY, 2),
    llm: readLlmConfig(env),
  };
}
