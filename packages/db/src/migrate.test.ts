import { describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { expectedMigrations, runMigrations, waitForSchema, withRetry } from './migrate.js';
import { probeService } from '@repolens/shared';

const MYSQL_URL = process.env.TEST_MYSQL_URL ?? 'mysql://root:dev@127.0.0.1:3306/repolens_test';
// 探测只连服务器根(不带库名):另一测试文件可能正在 DROP/CREATE 默认库,带库名会撞上 Unknown database
const SERVER_URL = MYSQL_URL.replace(/\/[^/]*$/, '/');
const DB = 'repolens_mig_test';
const url = MYSQL_URL.replace(/\/[^/]*$/, `/${DB}`);

const hasMysql = await probeService(
  'MySQL',
  '[db] MySQL 不可达(repolens_mig_test),跳过迁移集成测试',
  async () => {
    const c = await mysql.createConnection({ uri: SERVER_URL, connectTimeout: 5000 });
    try {
      await c.query('DROP DATABASE IF EXISTS repolens_mig_test');
      await c.query('CREATE DATABASE repolens_mig_test');
    } finally {
      await c.end().catch(() => {});
    }
  },
);

describe('withRetry', () => {
  it('指数退避、有上限,成功后停止', async () => {
    const waits: number[] = [];
    const logs: string[] = [];
    let n = 0;
    const r = await withRetry(
      'x',
      async () => {
        if (++n < 5) throw Object.assign(new Error('no'), { code: 'ECONNREFUSED' });
        return 42;
      },
      {
        baseMs: 100,
        maxMs: 500,
        sleep: async (ms) => void waits.push(ms),
        log: (m) => void logs.push(m),
      },
    );
    expect(r).toBe(42);
    expect(waits).toEqual([100, 200, 400, 500]);
    expect(logs[0]).toContain('ECONNREFUSED');
    expect(logs.at(-1)).toContain('成功(第 5/10 次尝试)');
  });
  it('达到上限后抛出最后的错误', async () => {
    let n = 0;
    await expect(
      withRetry(
        'x',
        async () => {
          n++;
          throw new Error('down');
        },
        { attempts: 3, sleep: async () => {}, log: () => {} },
      ),
    ).rejects.toThrow('down');
    expect(n).toBe(3);
  });
  it('连接不上的端口:有限次后失败', async () => {
    await expect(
      runMigrations('mysql://root:x@127.0.0.1:1/none', { attempts: 2, baseMs: 10, log: () => {} }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

describe.skipIf(!hasMysql)('迁移互斥与 worker 等待 schema(真实 MySQL/MariaDB)', () => {
  it('并发 runMigrations 由 GET_LOCK 串行;waitForSchema 在迁移后通过', async () => {
    const logs: string[] = [];
    const waiting = waitForSchema(url, { baseMs: 50, maxMs: 200, log: (m) => void logs.push(m) });
    await new Promise((r) => setTimeout(r, 150));
    await Promise.all([runMigrations(url), runMigrations(url), runMigrations(url)]);
    await waiting;
    expect(logs.some((m) => m.includes('schema 未就绪') || m.includes('ER_NO_SUCH_TABLE'))).toBe(
      true,
    );
    const c = await mysql.createConnection({ uri: url });
    const [rows] = await c.query('SELECT COUNT(*) AS n FROM `__drizzle_migrations`');
    await c.end();
    expect(Number((rows as { n: number }[])[0]!.n)).toBe(expectedMigrations());
  });
});
