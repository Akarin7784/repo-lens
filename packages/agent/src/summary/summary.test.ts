import { describe, expect, it } from 'vitest';
import { GraphIndex, MemoryStore, type StoredGraph, type SummaryRow } from '@repolens/db';
import { FakeLlm } from '../llm/fake.js';
import { LlmGateway, type LlmKv } from '../llm/gateway.js';
import type { LlmCall, LlmCallResult, LlmClient } from '../llm/types.js';
import { DEFAULT_PRICES } from '../llm/pricing.js';
import {
  CHILDREN_MAX_CHARS,
  capChildren,
  dirPrompt,
  parseSummary,
  truncateCode,
} from './prompts.js';
import { ruleDirSummary, ruleFileSummary, ruleRepoSummary } from './rules.js';
import {
  DEFAULT_FILE_TIMEOUT_MS,
  RULE_MODEL,
  summarizeRepo,
  summaryKey,
  type SummaryFileInput,
} from './summarize.js';

class MemKv implements LlmKv {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
    return 'OK';
  }
  async incrby(k: string, n: number) {
    const v = Number(this.m.get(k) ?? 0) + n;
    this.m.set(k, String(v));
    return v;
  }
  async expire() {
    return 1;
  }
}

const graph: StoredGraph = {
  files: [
    {
      id: 1,
      path: 'src/index.ts',
      lang: 'ts',
      loc: 10,
      moduleId: 'm:src',
      dirPath: 'src',
      externalDeps: [],
    },
    {
      id: 2,
      path: 'src/middleware/a.ts',
      lang: 'ts',
      loc: 20,
      moduleId: 'm:src/middleware',
      dirPath: 'src/middleware',
      externalDeps: [],
    },
    {
      id: 3,
      path: 'src/middleware/b.ts',
      lang: 'ts',
      loc: 30,
      moduleId: 'm:src/middleware',
      dirPath: 'src/middleware',
      externalDeps: ['react'],
    },
  ],
  edges: [
    {
      srcId: 'f:src/index.ts',
      dstId: 'f:src/middleware/a.ts',
      kind: 'static',
      srcFileId: 1,
      weight: 1,
    },
    {
      srcId: 'f:src/middleware/b.ts',
      dstId: 'f:src/middleware/a.ts',
      kind: 'static',
      srcFileId: 3,
      weight: 1,
    },
  ] as StoredGraph['edges'],
};

function setup(
  o: {
    client?: LlmClient;
    prices?: typeof DEFAULT_PRICES;
    taskCents?: number;
    dailyCents?: number;
    maxLlmFiles?: number;
    fileTimeoutMs?: number;
  } = {},
) {
  const tree = new GraphIndex(graph);
  const files = new Map<string, SummaryFileInput>();
  for (const f of graph.files)
    files.set(`f:${f.path}`, {
      path: f.path,
      lang: 'ts',
      loc: f.loc,
      exports: ['x'],
      imports: f.externalDeps,
      contentHash: `h${f.id}`,
      code: `export const x = ${f.id};`,
    });
  const usage = new MemoryStore();
  const client = o.client ?? new FakeLlm();
  const kv = new MemKv();
  const gateway = new LlmGateway({
    client,
    kv,
    usage,
    prices: o.prices ?? DEFAULT_PRICES,
    dailyBudgetCents: o.dailyCents ?? 500,
    taskBudgetCents: o.taskCents ?? 30,
  });
  const db = new Map<string, SummaryRow>();
  const run = () =>
    summarizeRepo(
      {
        repoName: 'demo',
        tree,
        files,
        readme: '# demo',
        packageJson: '{"name":"demo"}',
        existing: new Map(db),
      },
      {
        gateway,
        summaryModel: 'fake',
        repoModel: 'fake',
        repoId: 1,
        taskId: 7,
        maxLlmFiles: o.maxLlmFiles,
        fileTimeoutMs: o.fileTimeoutMs,
        concurrency: 2,
        save: async (r) => void db.set(summaryKey(r.level, r.targetId), r),
      },
    );
  return { run, db, usage, client, kv, tree };
}
const usageCount = async (u: MemoryStore) => (await u.llmUsageByTask(7)).length;

describe('规则摘要', () => {
  it('文件/目录/仓库规则摘要包含路径、导出名、语言、行数', () => {
    const s = ruleFileSummary({ path: 'src/a.ts', lang: 'ts', loc: 12, exports: ['foo', 'bar'] });
    expect(s).toContain('src/a.ts');
    expect(s).toContain('ts');
    expect(s).toContain('12');
    expect(s).toContain('foo');
    expect(
      ruleDirSummary({ path: 'src', kind: 'dir', fileCount: 2, loc: 30, children: ['a.ts'] }),
    ).toContain('src');
    expect(ruleRepoSummary({ name: 'demo', fileCount: 3, modules: ['src'] })).toContain('demo');
  });
  it('parseSummary 解析 JSON,坏输出返回 null;truncateCode 截断', () => {
    expect(parseSummary('{"summary":"hi"}')).toBe('hi');
    expect(parseSummary('not json')).toBeNull();
    expect(parseSummary('{"summary":""}')).toBeNull();
    expect(truncateCode('a\n'.repeat(500)).split('\n').length).toBeLessThanOrEqual(151);
  });
});

describe('summarizeRepo', () => {
  it('FakeLlm 下 file/dir/module/repo 都有非空摘要,m:src/middleware 存在', async () => {
    const { run, db, tree } = setup();
    const r = await run();
    expect(r.budget).toBeNull();
    expect(r.total).toBe(db.size);
    for (const row of db.values()) expect(row.content.length).toBeGreaterThan(0);
    expect(db.get(summaryKey('dir', 'm:src/middleware'))?.content).toMatch(/fake summary/);
    expect(db.get(summaryKey('repo', 'repo'))).toBeDefined();
    expect(db.size).toBe(
      tree.nodes.size - [...tree.nodes.values()].filter((n) => n.type === 'external').length + 1,
    );
  });

  it('同 commit 重跑:全部复用,不调网关、不新增 llm_usage', async () => {
    const { run, client, kv, usage } = setup();
    await run();
    const rows = await usageCount(usage);
    expect(rows).toBeGreaterThan(0);
    const calls = (client as FakeLlm).calls;
    const keys = kv.m.size;
    const r2 = await run();
    expect(r2.reused).toBe(r2.total);
    expect(r2.llm + r2.rule).toBe(0);
    expect((client as FakeLlm).calls).toBe(calls);
    expect(kv.m.size).toBe(keys);
    expect(await usageCount(usage)).toBe(rows);
  });

  it('fanIn 排名外的文件只用规则摘要', async () => {
    const { run, db } = setup({ maxLlmFiles: 1 });
    await run();
    expect(db.get(summaryKey('file', 'f:src/middleware/a.ts'))?.model).toBe('fake'); // fanIn 2
    expect(db.get(summaryKey('file', 'f:src/index.ts'))?.model).toBe(RULE_MODEL);
    expect(db.get(summaryKey('file', 'f:src/middleware/b.ts'))?.model).toBe(RULE_MODEL);
  });

  it('预算熔断:剩余节点改用规则摘要,任务仍完成', async () => {
    const { run, db } = setup({
      prices: { fake: { inputPerMTok: 1_000_000, outputPerMTok: 0 } },
      taskCents: 30,
      dailyCents: 1_000_000,
    });
    const r = await run();
    expect(r.budget?.scope).toBe('task');
    expect(r.budget!.degraded).toBeGreaterThan(0);
    expect(db.size).toBe(r.total);
    expect([...db.values()].some((x) => x.model === RULE_MODEL)).toBe(true);
  });

  it('解析失败重试 1 次后成功', async () => {
    let n = 0;
    const client: LlmClient = {
      provider: 'fake',
      async call(req: LlmCall): Promise<LlmCallResult> {
        n++;
        const retry = req.messages.length > 2;
        return {
          text: retry ? '{"summary":"ok"}' : 'garbage',
          usage: { tokensIn: 1, tokensOut: 1 },
        };
      },
    } as LlmClient;
    const { run, db } = setup({ client });
    const r = await run();
    expect(r.failed).toBe(0);
    expect(n).toBe(r.total * 2);
    for (const row of db.values()) expect(row.content).toBe('ok');
  });

  it('LLM 一直不可用:每节点重试一次后降级为规则摘要', async () => {
    const client = new FakeLlm({ fail: () => true });
    const { run, db } = setup({ client });
    const r = await run();
    expect(r.failed).toBe(r.total);
    expect(client.calls).toBe(r.total * 2);
    for (const row of db.values()) expect(row.model).toBe(RULE_MODEL);
    // 规则摘要也按 hash 复用;LLM 恢复后再跑会升级为 LLM 摘要
  });

  it('单文件摘要调用超时:按失败重试 1 次,仍超时降级为规则摘要,其它节点不受影响', async () => {
    expect(DEFAULT_FILE_TIMEOUT_MS).toBe(30_000);
    let hung = 0;
    const client: LlmClient = {
      provider: 'fake',
      async call(req: LlmCall): Promise<LlmCallResult> {
        const text = req.messages.map((m) => m.content).join('\n');
        if (text.includes('路径:src/middleware/b.ts')) {
          hung++;
          return new Promise(() => {}); // 永不返回
        }
        return { text: '{"summary":"ok"}', usage: { tokensIn: 1, tokensOut: 1 } };
      },
    } as LlmClient;
    const { run, db } = setup({ client, fileTimeoutMs: 30 });
    const t0 = Date.now();
    const r = await run();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(hung).toBe(2);
    expect(r.timedOut).toBe(2);
    expect(r.failed).toBe(1);
    expect(db.get(summaryKey('file', 'f:src/middleware/b.ts'))?.model).toBe(RULE_MODEL);
    expect(db.get(summaryKey('file', 'f:src/middleware/a.ts'))?.content).toBe('ok');
    expect(db.get(summaryKey('dir', 'm:src/middleware'))?.content).toBe('ok');
  });
});

describe('dir/module 子项总长度上限', () => {
  const kid = (i: number) => ({ id: `f:src/d/f${i}.ts`, summary: '摘'.repeat(600) });
  it('超过上限的子项不进提示词,只注明省略个数;总长度不超过上限', () => {
    const all = Array.from({ length: 40 }, (_, i) => kid(i));
    const { kept, omitted } = capChildren(all);
    expect(kept.length + omitted).toBe(40);
    expect(omitted).toBeGreaterThan(0);
    expect(kept.reduce((n, c) => n + c.id.length + c.summary.length, 0)).toBeLessThanOrEqual(
      CHILDREN_MAX_CHARS,
    );
    expect(kept).toEqual(all.slice(0, kept.length)); // 保持原顺序
    const msg = dirPrompt({ path: 'src/d', kind: 'dir', children: kept, omitted })[1]!.content;
    expect(msg).toContain(`另有 ${omitted} 个子项因长度上限省略`);
    expect(msg).not.toContain(all[kept.length]!.id);
  });
  it('未超上限时原样保留、不加省略说明;单个超长子项至少保留 1 个', () => {
    const few = [kid(1), kid(2)];
    expect(capChildren(few)).toEqual({ kept: few, omitted: 0 });
    expect(dirPrompt({ path: 'src/d', kind: 'dir', children: few })[1]!.content).not.toContain(
      '省略',
    );
    const big = [{ id: 'd:x', summary: 'x'.repeat(20_000) }, kid(3)];
    expect(capChildren(big)).toEqual({ kept: [big[0]], omitted: 1 });
  });
});
