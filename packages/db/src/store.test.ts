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
import { onServiceUnavailable } from '@repolens/shared';

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
if (!hasMysql)
  onServiceUnavailable('MySQL', `[db] MySQL 不可达(${MYSQL_URL}),跳过 MysqlStore 集成测试`);

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

    it('summary 按 (repo, level, targetId, commitSha) upsert 与读回,commit 间隔离(T-211c)', async () => {
      const r = await s.upsertRepo({ url: 'https://github.com/o/sum', owner: 'o', name: 'sum' });
      const A = 'a'.repeat(40);
      const B = 'b'.repeat(40);
      const row = {
        level: 'dir' as const,
        targetId: 'm:src',
        inputHash: 'a'.repeat(64),
        model: 'fake',
        source: 'llm' as const,
        content: '第一版',
        tokensIn: 3,
        tokensOut: 2,
      };
      await s.upsertSummary(r.id, A, row);
      await s.upsertSummary(r.id, A, { ...row, inputHash: 'b'.repeat(64), content: '第二版' });
      await s.upsertSummary(r.id, A, {
        ...row,
        level: 'file',
        targetId: 'f:src/a.ts',
        content: 'f',
      });
      await s.upsertSummary(r.id, B, { ...row, model: 'rule', source: 'rule', content: 'B 版' });
      expect(await s.getSummary(r.id, A, 'dir', 'm:src')).toEqual({
        content: '第二版',
        source: 'llm',
      });
      expect(await s.getSummary(r.id, B, 'dir', 'm:src')).toEqual({
        content: 'B 版',
        source: 'rule',
      });
      expect(await s.getSummary(r.id, B, 'file', 'f:src/a.ts')).toBeNull();
      expect(await s.getSummary(r.id, A, 'dir', 'm:none')).toBeNull();
      const all = await s.listSummaries(r.id);
      expect(all).toHaveLength(3);
      expect(all.find((x) => x.targetId === 'm:src' && x.commitSha === A)).toMatchObject({
        inputHash: 'b'.repeat(64),
        model: 'fake',
        source: 'llm',
      });
      // findSummaryByInput:按 (level, targetId, inputHash) 命中,优先 preferCommit
      const hashB = 'b'.repeat(64);
      expect(await s.findSummaryByInput(r.id, 'dir', 'm:src', hashB, A)).toMatchObject({
        commitSha: A,
        content: '第二版',
      });
      // B 那行的 inputHash 是 row.inputHash('a…')
      expect(await s.findSummaryByInput(r.id, 'dir', 'm:src', row.inputHash, B)).toMatchObject({
        commitSha: B,
        content: 'B 版',
        source: 'rule',
      });
      // 偏好 B 但 B 没有 hashB 的行:退回 A 的
      expect(await s.findSummaryByInput(r.id, 'dir', 'm:src', hashB, B)).toMatchObject({
        commitSha: A,
        content: '第二版',
      });
      // preferCommit 没有这行时退回其他 commit 的同哈希行
      expect(
        await s.findSummaryByInput(r.id, 'file', 'f:src/a.ts', row.inputHash, B),
      ).toMatchObject({ commitSha: A, content: 'f' });
      expect(await s.findSummaryByInput(r.id, 'dir', 'm:src', 'c'.repeat(64), A)).toBeNull();
      expect(await s.findSummaryByInput(r.id, 'dir', 'm:other', hashB, A)).toBeNull();
    });

    it('llm_usage 写入与按任务读回(T-210)', async () => {
      const r = await s.upsertRepo({ url: 'https://github.com/o/llm', owner: 'o', name: 'llm' });
      const { task } = await s.createTask({
        jobId: `${r.id}:${'c'.repeat(40)}`,
        repoId: r.id,
        commitSha: 'c'.repeat(40),
      });
      const base = { repoId: r.id, taskId: task.id, purpose: 'summary' as const, model: 'm' };
      await s.insertLlmUsage({
        ...base,
        tokensIn: 10,
        tokensOut: 5,
        costMicroUsd: 12,
        cacheHit: false,
        ok: true,
      });
      await s.insertLlmUsage({
        ...base,
        tokensIn: 0,
        tokensOut: 0,
        costMicroUsd: 0,
        cacheHit: true,
        ok: true,
      });
      await s.insertLlmUsage({
        ...base,
        tokensIn: 0,
        tokensOut: 0,
        costMicroUsd: 0,
        cacheHit: false,
        ok: false,
      });
      const rows = await s.llmUsageByTask(task.id);
      expect(rows.map((u) => [u.costMicroUsd, u.cacheHit, u.ok])).toEqual([
        [12, false, true],
        [0, true, true],
        [0, false, false],
      ]);
      expect(rows[0]).toMatchObject({
        repoId: r.id,
        taskId: task.id,
        purpose: 'summary',
        tokensIn: 10,
        tokensOut: 5,
      });
    });

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

    it('code_chunk 按 (repo, commit) 整体替换,按写入顺序读回,commit 间隔离(T-214)', async () => {
      const r = await s.upsertRepo({ url: 'https://github.com/o/cc', owner: 'o', name: 'cc' });
      const A = 'c'.repeat(40);
      const B = 'd'.repeat(40);
      const row = (i: number, tag = 'v1') => ({
        path: `src/f${i}.ts`,
        symbol: i % 2 ? null : `fn${i}`,
        startLine: i + 1,
        endLine: i + 3,
        content: `${tag} 第${i}块 export function fn${i}() {}`,
        contentHash: String(i).padStart(64, '0'),
        qdrantPointId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      });
      // 450 行 > 一批 200,覆盖分批插入
      const v1 = Array.from({ length: 450 }, (_, i) => row(i));
      await s.replaceCodeChunks(r.id, A, v1);
      await s.replaceCodeChunks(r.id, B, [row(0, 'other')]);
      expect(await s.listCodeChunks(r.id, A)).toEqual(v1);
      // 再次替换:旧行全部删除,不残留
      const v2 = [row(7, 'v2'), row(3, 'v2')];
      await s.replaceCodeChunks(r.id, A, v2);
      expect(await s.listCodeChunks(r.id, A)).toEqual(v2);
      expect(await s.listCodeChunks(r.id, B)).toEqual([row(0, 'other')]);
      await s.replaceCodeChunks(r.id, A, []);
      expect(await s.listCodeChunks(r.id, A)).toEqual([]);
      expect(await s.listCodeChunks(r.id + 999, B)).toEqual([]);
    });

    it('chat_session / chat_message:创建、按 id 读回、写入消息、按 session 列出(P4-c)', async () => {
      const r = await s.upsertRepo({ url: 'https://github.com/o/chat', owner: 'o', name: 'chat' });
      const other = await s.upsertRepo({
        url: 'https://github.com/o/chat2',
        owner: 'o',
        name: 'chat2',
      });
      const long = '题'.repeat(300);
      const sess = await s.createChatSession({
        repoId: r.id,
        userKey: 'abc'.padEnd(32, '0'),
        title: long,
      });
      expect(sess.id).toBeGreaterThan(0);
      expect(sess.repoId).toBe(r.id);
      expect(sess.userKey).toBe('abc'.padEnd(32, '0'));
      expect(sess.title).toHaveLength(255);
      expect(sess.createdAt).toBeInstanceOf(Date);
      expect(await s.getChatSession(sess.id)).toMatchObject({
        id: sess.id,
        repoId: r.id,
        userKey: sess.userKey,
        title: sess.title,
      });
      expect(await s.getChatSession(sess.id + 99999)).toBeNull();

      const nullKey = await s.createChatSession({
        repoId: other.id,
        userKey: null,
        title: null,
      });
      expect(nullKey.userKey).toBeNull();
      expect(nullKey.title).toBeNull();
      // 别的仓库的 session 也能按 id 读到(归属校验在路由层)
      expect((await s.getChatSession(nullKey.id))?.repoId).toBe(other.id);

      const user = await s.insertChatMessage({
        sessionId: sess.id,
        role: 'user',
        content: 'createPool 在哪?',
      });
      expect(user.id).toBeGreaterThan(0);
      expect(user).toMatchObject({
        sessionId: sess.id,
        role: 'user',
        content: 'createPool 在哪?',
        droppedCitations: 0,
        latencyMs: null,
      });
      const cites = [{ id: 1, path: 'src/a.ts', startLine: 1, endLine: 2, nodeId: 'f:src/a.ts' }];
      const asst = await s.insertChatMessage({
        sessionId: sess.id,
        role: 'assistant',
        content: '在 src/a.ts',
        citations: cites,
        droppedCitations: 2,
        retrievalIds: [11, 22, 33],
        latencyMs: 1234,
      });
      expect(asst).toMatchObject({
        role: 'assistant',
        content: '在 src/a.ts',
        droppedCitations: 2,
        latencyMs: 1234,
      });
      expect(asst.citations).toEqual(cites);
      expect(asst.retrievalIds).toEqual([11, 22, 33]);

      const listed = await s.listChatMessages(sess.id);
      expect(listed.map((m) => m.id)).toEqual([user.id, asst.id]);
      expect(listed.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(await s.listChatMessages(nullKey.id)).toEqual([]);
      expect(await s.listChatMessages(sess.id + 99999)).toEqual([]);
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
    expect(redisKeys.llmCache('ab')).toBe('llm:ab');
    expect(redisKeys.llmSpendDay(new Date('2026-10-29T23:59:00Z'))).toBe('llm:spend:day:20261029');
    expect(redisKeys.llmSpendTask(7)).toBe('llm:spend:task:7');
    expect(redisKeys.jobEvents('1:abc')).toBe('job:1:abc:events');
    expect(GRAPH_PROJECTION_VERSION).toBe(6);
    expect(redisKeys.graph(1, C, null)).toBe(`graph:v6:1:${C}:root`);
    expect(redisKeys.graph(1, C, 'm:src', true)).toBe(`graph:v6:1:${C}:m:src:ext`);
    expect(redisKeys.graph(1, C, null, false, 2)).toBe(`graph:v2:1:${C}:root`);
    expect(redisKeys.graphPattern(1, C)).toBe(`graph:v6:1:${C}:*`);
    expect(redisKeys.rateLimitIp('1.2.3.4', new Date('2026-10-29T03:05:00Z'))).toBe(
      'rl:ip:1.2.3.4:2026102903',
    );
    expect(redisKeys.submitLimitIp('1.2.3.4', new Date('2026-10-29T03:05:00Z'))).toBe(
      'rl:sub:1.2.3.4:2026102903',
    );
    expect(
      redisKeys.chatLimitIp('2001:0db8:0000:0000::/64', new Date('2026-10-29T03:05:00Z')),
    ).toBe('rl:chat:2001:0db8:0000:0000::/64:2026102903');
    expect(queueJobId(publicJobId(12, C))).toBe(`12-${C}`);
    expect(parseJobId(`12:${C}`)).toEqual({ repoId: 12, commitSha: C });
    expect(parseJobId('12:zz')).toBeNull();
  });
});
