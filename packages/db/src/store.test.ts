import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { MemoryStore } from './memory-store.js';
import { MysqlStore } from './mysql-store.js';
import { runMigrations } from './migrate.js';
import {
  GRAPH_PROJECTION_VERSION,
  parseJobId,
  publicJobId,
  queueJobId,
  redisKeys,
} from './redis-keys.js';
import type { GraphInput, Store } from './store.js';

const MYSQL_URL = process.env.TEST_MYSQL_URL ?? 'mysql://root:dev@127.0.0.1:3306/repolens_test';
const C = 'a'.repeat(40);

async function mysqlReachable(): Promise<boolean> {
  try {
    const c = await mysql.createConnection({ uri: MYSQL_URL, connectTimeout: 1500 });
    await c.query('DROP DATABASE IF EXISTS repolens_test');
    await c.query('CREATE DATABASE repolens_test');
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const hasMysql = await mysqlReachable();
if (!hasMysql) console.warn(`[db] MySQL 不可达(${MYSQL_URL}),跳过 MysqlStore 集成测试`);

const graph: GraphInput = {
  files: [
    {
      path: 'src/a.ts',
      lang: 'ts',
      loc: 3,
      contentHash: 'h'.repeat(64),
      moduleId: 'm:src',
      dirPath: 'src',
      externalDeps: ['react'],
    },
    {
      path: 'src/b.ts',
      lang: 'ts',
      loc: 1,
      contentHash: 'i'.repeat(64),
      moduleId: 'm:src',
      dirPath: 'src',
      externalDeps: [],
    },
  ],
  symbols: [
    { path: 'src/b.ts', name: 'b', kind: 'var', startLine: 1, endLine: 1, exported: true },
    { path: 'src/b.ts', name: 'priv', kind: 'function', startLine: 2, endLine: 3, exported: false },
  ],
  edges: [{ srcId: 'f:src/a.ts', dstId: 'f:src/b.ts', kind: 'static', srcPath: 'src/a.ts' }],
};

function suite(name: string, make: () => Promise<Store>, enabled = true) {
  describe.skipIf(!enabled)(name, () => {
    let s: Store;
    beforeAll(async () => {
      s = await make();
    });
    afterAll(async () => s?.close());

    it('repo upsert 幂等、task 按 jobId 幂等', async () => {
      const r1 = await s.upsertRepo({ url: 'https://github.com/o/n', owner: 'o', name: 'n' });
      const r2 = await s.upsertRepo({ url: 'https://github.com/o/n', owner: 'o', name: 'n' });
      expect(r2.id).toBe(r1.id);
      const jobId = publicJobId(r1.id, C);
      const t1 = await s.createTask({ jobId, repoId: r1.id, commitSha: C });
      const t2 = await s.createTask({ jobId, repoId: r1.id, commitSha: C });
      expect(t1.created).toBe(true);
      expect(t2.created).toBe(false);
      expect(t2.task.stage).toBe('queued');
      await s.updateTask(jobId, { stage: 'graph_ready', progress: 50, stats: { files: 2 } });
      const t = await s.latestGraphTask(r1.id);
      expect(t?.stats).toEqual({ files: 2 });
      expect(t?.progress).toBe(50);
    });

    it('saveGraph 删除后重插(同事务),srcFileId 映射为 file.id', async () => {
      expect(await s.hasGraph(1, C)).toBe(false);
      const ids1 = await s.saveGraph(1, C, graph);
      const ids2 = await s.saveGraph(1, C, graph); // 重试:不重复
      expect(ids2.size).toBe(2);
      expect(ids2.get('src/a.ts')).not.toBe(ids1.get('src/a.ts'));
      const g = await s.loadGraph(1, C);
      expect(g.files).toHaveLength(2);
      expect(g.edges).toEqual([
        {
          srcId: 'f:src/a.ts',
          dstId: 'f:src/b.ts',
          kind: 'static',
          srcFileId: ids2.get('src/a.ts'),
          weight: 1,
        },
      ]);
      expect(g.files.find((f) => f.path === 'src/a.ts')?.externalDeps).toEqual(['react']);
      expect(await s.exportsOf(ids2.get('src/b.ts')!)).toEqual(['b']);
      expect(await s.hasGraph(1, C)).toBe(true);
    });
  });
}

suite('MemoryStore', async () => new MemoryStore());
suite(
  'MysqlStore(真实 MySQL/MariaDB)',
  async () => {
    await runMigrations(MYSQL_URL);
    await runMigrations(MYSQL_URL); // 幂等
    return MysqlStore.create(MYSQL_URL);
  },
  hasMysql,
);

describe('redis keys', () => {
  it('与文档一致', () => {
    expect(redisKeys.jobEvents('1:abc')).toBe('job:1:abc:events');
    expect(GRAPH_PROJECTION_VERSION).toBe(2);
    expect(redisKeys.graph(1, C, null)).toBe(`graph:v2:1:${C}:root`);
    expect(redisKeys.graph(1, C, 'm:src', true)).toBe(`graph:v2:1:${C}:m:src:ext`);
    expect(redisKeys.graph(1, C, null, false, 3)).toBe(`graph:v3:1:${C}:root`);
    expect(redisKeys.graphPattern(1, C)).toBe(`graph:v2:1:${C}:*`);
    expect(redisKeys.rateLimitIp('1.2.3.4', new Date('2026-10-29T03:05:00Z'))).toBe(
      'rl:ip:1.2.3.4:2026102903',
    );
    expect(queueJobId(publicJobId(12, C))).toBe(`12-${C}`);
    expect(parseJobId(`12:${C}`)).toEqual({ repoId: 12, commitSha: C });
    expect(parseJobId('12:zz')).toBeNull();
  });
});
