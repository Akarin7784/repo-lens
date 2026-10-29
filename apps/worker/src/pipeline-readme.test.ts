import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRICES, FakeLlm, LlmGateway, MemoryLlmKv } from '@repolens/agent';
import type { LlmCall } from '@repolens/agent';
import { MemoryStore, publicJobId } from '@repolens/db';
import { MAX_SEND_BYTES } from '@repolens/shared';
import { MemoryEventSink } from './events.js';
import { runPipeline } from './pipeline/run.js';
import { makeGitRepo, SAMPLE_REPO, testConfig } from './test-utils.js';

// 记录 worker 实际 readFile 过的路径(其余行为原样透传),用来断言 README 没被读取
const readPaths: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...orig,
    readFile: (async (p: Parameters<typeof orig.readFile>[0], ...rest: unknown[]) => {
      readPaths.push(String(p));
      return (orig.readFile as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof orig.readFile,
  };
});

const MARKER = 'README_MARKER_7f3a9c';

/** 跑一遍完整 worker 流程(克隆 → 解析 → 摘要),返回所有送给模型的提示词 */
async function run(url: string, sha: string) {
  const store = new MemoryStore();
  const repo = await store.upsertRepo({ url, owner: 'o', name: 'n' });
  const jobId = publicJobId(repo.id, sha);
  await store.createTask({ jobId, repoId: repo.id, commitSha: sha });
  const client = new FakeLlm();
  const prompts: string[] = [];
  const call = client.call.bind(client);
  client.call = async (req: LlmCall) => {
    prompts.push(req.messages.map((m) => m.content).join('\n'));
    return call(req);
  };
  const gateway = new LlmGateway({
    client,
    kv: new MemoryLlmKv(),
    usage: store,
    prices: DEFAULT_PRICES,
    dailyBudgetCents: 1_000_000,
    taskBudgetCents: 1_000_000,
  });
  const events = new MemoryEventSink();
  await runPipeline(
    { jobId, repoId: repo.id, repoUrl: url, commitSha: sha },
    { store, events, config: testConfig(), gateway, allowFileProtocol: true },
  );
  const rows = await store.listSummaries(repo.id);
  return { prompts, rows, events };
}

const readmeReads = () => readPaths.filter((p) => /README\.md$/.test(p));

describe('README 安全读取(worker 全流程)', () => {
  beforeEach(() => {
    readPaths.length = 0;
  });

  it('对照组:普通 README 会被读取并进入 repo 提示词', async () => {
    const { url, sha } = makeGitRepo({ ...SAMPLE_REPO, 'README.md': `# ${MARKER}\n` });
    const { prompts, rows } = await run(url, sha);
    expect(readmeReads().length).toBe(1);
    expect(prompts.some((p) => p.includes(MARKER))).toBe(true);
    expect(rows.some((r) => r.level === 'repo')).toBe(true);
  });

  it('README 是指向仓库外文件的符号链接:不读取、不进提示词与摘要', async () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'rl-outside-')), 'secret.txt');
    writeFileSync(outside, `${MARKER} outside content\n`);
    const files: Record<string, string> = { ...SAMPLE_REPO };
    delete files['README.md'];
    const { url } = makeGitRepo(files);
    const dir = url.replace('file://', '');
    symlinkSync(outside, join(dir, 'README.md'));
    const g = (...a: string[]) =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
        encoding: 'utf8',
      }).trim();
    g('add', '-A');
    g('commit', '-qm', 'symlink readme');
    const sha = g('rev-parse', 'HEAD');
    expect(g('ls-tree', 'HEAD', 'README.md')).toMatch(/^120000 /); // 确实以符号链接入库

    const { prompts, rows, events } = await run(url, sha);
    expect(events.events.some((e) => e.event === 'done')).toBe(true);
    expect(readmeReads()).toEqual([]);
    expect(readPaths.some((p) => p === outside)).toBe(false);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((p) => p.includes(MARKER))).toBe(false);
    expect(rows.some((r) => r.content?.includes(MARKER))).toBe(false);
  });

  it('README 超过 MAX_SEND_BYTES:不读取、不进提示词与摘要', async () => {
    const big = `# ${MARKER}\n` + 'a'.repeat(MAX_SEND_BYTES + 1024);
    const { url, sha } = makeGitRepo({ ...SAMPLE_REPO, 'README.md': big });
    const { prompts, rows, events } = await run(url, sha);
    expect(events.events.some((e) => e.event === 'done')).toBe(true);
    expect(readmeReads()).toEqual([]);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((p) => p.includes(MARKER))).toBe(false);
    expect(rows.some((r) => r.content?.includes(MARKER))).toBe(false);
  });
});
