import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';

/** 包内 migrations 目录(drizzle-kit generate 产出,随包发布) */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface RetryOptions {
  /** 最多尝试次数(含第一次),默认 10 */
  attempts?: number;
  /** 首次退避毫秒,默认 500,之后每次 ×2 */
  baseMs?: number;
  /** 单次退避上限毫秒,默认 10000 */
  maxMs?: number;
  /** 日志标签,如 "api" / "worker" */
  label?: string;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 有限次数指数退避重试;最后一次仍失败则抛出最后的错误 */
export async function withRetry<T>(
  what: string,
  fn: () => Promise<T>,
  o: RetryOptions = {},
): Promise<T> {
  const attempts = o.attempts ?? 10;
  const base = o.baseMs ?? 500;
  const max = o.maxMs ?? 10_000;
  const log = o.log ?? ((m: string) => console.log(m));
  const sleep = o.sleep ?? sleepMs;
  const tag = `[${o.label ?? 'db'}]`;
  for (let i = 1; ; i++) {
    try {
      const r = await fn();
      if (i > 1) log(`${tag} ${what} 成功(第 ${i}/${attempts} 次尝试)`);
      return r;
    } catch (err) {
      const msg = (err as { code?: string; message?: string }).code ?? (err as Error).message;
      if (i >= attempts) {
        log(`${tag} ${what} 失败,已达上限 ${attempts} 次,放弃:${msg}`);
        throw err;
      }
      const wait = Math.min(max, base * 2 ** (i - 1));
      log(`${tag} ${what} 失败(第 ${i}/${attempts} 次):${msg},${wait}ms 后重试`);
      await sleep(wait);
    }
  }
}

const MIGRATION_LOCK = 'repolens_migrate';

/**
 * 执行未应用的迁移(仅 API 启动时调用,幂等)。
 * 连接带有限次重试;迁移用 MySQL GET_LOCK 互斥,多个 API 副本同时启动也只有一个在迁移。
 */
export async function runMigrations(url: string, o: RetryOptions = {}): Promise<void> {
  const conn = await withRetry(
    '连接 MySQL',
    () => mysql.createConnection({ uri: url, multipleStatements: true }),
    o,
  );
  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, 60) AS ok', [MIGRATION_LOCK]);
    if ((rows as { ok: number | null }[])[0]?.ok !== 1) throw new Error('获取迁移锁超时(60s)');
    try {
      await migrate(drizzle(conn), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK]);
    }
  } finally {
    await conn.end();
  }
}

/** 迁移目录里的迁移条数(_journal.json) */
export function expectedMigrations(): number {
  const j = JSON.parse(readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, 'utf8')) as {
    entries: unknown[];
  };
  return j.entries.length;
}

/**
 * Worker 启动时调用:不跑迁移,等待 API 把 schema 迁到当前版本(有限次重试)。
 * 判定:__drizzle_migrations 的行数 ≥ 本包 journal 中的迁移条数。
 */
export async function waitForSchema(url: string, o: RetryOptions = {}): Promise<void> {
  const need = expectedMigrations();
  await withRetry(
    `等待 schema 就绪(需要 ${need} 条迁移)`,
    async () => {
      const conn = await mysql.createConnection({ uri: url });
      try {
        const [rows] = await conn.query('SELECT COUNT(*) AS n FROM `__drizzle_migrations`');
        const n = Number((rows as { n: number }[])[0]?.n ?? 0);
        if (n < need) throw new Error(`schema 未就绪:已应用 ${n}/${need}`);
      } finally {
        await conn.end();
      }
    },
    { attempts: 30, maxMs: 5000, ...o },
  );
}
