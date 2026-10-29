import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICES,
  FakeLlm,
  LlmGateway,
  MemoryLlmKv,
  type LlmCall,
  type LlmClient,
} from '@repolens/agent';
import { analyzeRepo, scanSourceFiles } from '@repolens/analyzer';
import { MemoryStore, publicJobId } from '@repolens/db';
import { FakeEmbedder, MemoryVectorStore } from '@repolens/rag';
import { MemoryEventSink } from './events.js';
import { runPipeline } from './pipeline/run.js';
import { makeGitRepo, SAMPLE_REPO, testConfig } from './test-utils.js';

// 明显的假 key:只为验证排除规则,任何一个出现在模型请求或切块里都算失败
const FAKE = {
  aws: 'AKIAFAKEFAKEFAKE0000',
  aws2: 'AKIAFAKEFAKEFAKE1111',
  gh: 'ghp_FAKEFAKEFAKEFAKEFAKEFAKE0000',
  sk: 'sk-FAKEFAKEFAKEFAKEFAKE0000',
  pemBody: 'MIIFAKEFAKEFAKEFAKEPRIVATEKEYBODY',
};
const PEM = `-----BEGIN PRIVATE KEY-----\n${FAKE.pemBody}\n-----END PRIVATE KEY-----\n`;
const FIXTURE = {
  ...SAMPLE_REPO,
  '.env': `AWS_ACCESS_KEY_ID=${FAKE.aws}\nOPENAI_API_KEY=${FAKE.sk}\n`,
  '.npmrc': `//registry.npmjs.org/:_authToken=${FAKE.gh}\n`,
  'certs/dev.pem': PEM,
  'src/aws.ts': `export const awsKeyId = '${FAKE.aws2}';\nexport function client() {\n  return awsKeyId;\n}\n`,
  'src/tls.ts': `export const devKey = \`${PEM}\`;\n`,
  'src/index.ts':
    "import { b } from './util/b';\nimport { client } from './aws';\nimport './style.css';\nexport const a = b + 1 + client().length;\n",
};
const secrets = Object.values(FAKE);

/** 记录发给模型的完整请求体(序列化后),再交给 FakeLlm */
class RecordingLlm implements LlmClient {
  readonly provider = 'fake';
  bodies: string[] = [];
  private inner = new FakeLlm();
  async call(req: LlmCall) {
    this.bodies.push(JSON.stringify(req));
    return this.inner.call(req);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('端到端:含假 key 的仓库跑完整流水线', () => {
  it('所有发给模型的请求体、切块、持久化的摘要里都不含假 key', async () => {
    const { url, sha } = makeGitRepo(FIXTURE);
    const store = new MemoryStore();
    const repo = await store.upsertRepo({ url, owner: 'o', name: 'n' });
    const jobId = publicJobId(repo.id, sha);
    await store.createTask({ jobId, repoId: repo.id, commitSha: sha });
    const client = new RecordingLlm();
    const gateway = new LlmGateway({
      client,
      kv: new MemoryLlmKv(),
      usage: store,
      prices: DEFAULT_PRICES,
      dailyBudgetCents: 1_000_000,
      taskBudgetCents: 1_000,
    });
    const config = testConfig();
    const embedder = new FakeEmbedder();
    const embedded: string[] = [];
    const orig = embedder.embedDocuments.bind(embedder);
    embedder.embedDocuments = async (t) => (embedded.push(...t), orig(t));
    const vectorStore = new MemoryVectorStore();
    await runPipeline(
      { jobId, repoId: repo.id, repoUrl: url, commitSha: sha },
      {
        store,
        events: new MemoryEventSink(),
        config,
        gateway,
        embedder,
        vectorStore,
        allowFileProtocol: true,
      },
    );
    expect((await store.getTask(jobId))?.stage).toBe('done');

    // 1) 提示词:确实调用了模型,且没有任何请求含假 key
    expect(client.bodies.length).toBeGreaterThan(0);
    for (const b of client.bodies) for (const s of secrets) expect(b).not.toContain(s);
    // 普通文件的源码仍会送模型(排除不是全关)
    expect(client.bodies.some((b) => b.includes('export const b'))).toBe(true);

    // 2) 摘要:敏感文件只有规则摘要,任何摘要都不含假 key
    const rows = await store.listSummaries(repo.id);
    const aws = rows.find((r) => r.targetId === 'f:src/aws.ts');
    expect(aws?.model).toBe('rule');
    for (const r of rows) for (const s of secrets) expect(r.content).not.toContain(s);

    // 2b) /nodes 的 exports 来源(loadGraph → exportsOf):敏感文件没有持久化 symbols,.env 不是图节点
    const g = await store.loadGraph(repo.id, sha);
    const exportsOf = async (path: string) => {
      const row = g.files.find((f) => f.path === path);
      return row ? store.exportsOf(row.id) : null;
    };
    expect(await exportsOf('src/aws.ts')).toEqual([]);
    expect(await exportsOf('src/tls.ts')).toEqual([]);
    expect(await exportsOf('.env')).toBeNull();
    expect(await exportsOf('src/index.ts')).toEqual(['a']);

    // 3) 切块(embedding / RAG 来源):敏感文件没有切块,所有切块对应的文本都不含假 key
    const root = mkRoot(config.workdir);
    const parsed = (await analyzeRepo({ root, files: scanSourceFiles(root) })).parsed;
    const by = new Map(parsed.map((p) => [p.path, p]));
    expect(by.get('src/aws.ts')?.chunks).toEqual([]);
    expect(by.get('src/tls.ts')?.chunks).toEqual([]);
    for (const p of parsed) {
      const lines = readFileSync(join(root, p.path), 'utf8').split('\n');
      for (const c of p.chunks) {
        const text = lines.slice(c.startLine - 1, c.endLine).join('\n');
        for (const s of secrets) expect(text).not.toContain(s);
      }
    }

    // 4) 向量化(T-214):敏感文件不进 chunk、不送 embedding、不进向量库
    expect(embedded.length).toBeGreaterThan(0);
    for (const t of embedded) for (const s of secrets) expect(t).not.toContain(s);
    const indexed = new Set([...vectorStore.points.values()].map((p) => p.payload.path));
    expect(indexed.has('src/index.ts')).toBe(true);
    for (const p of ['src/aws.ts', 'src/tls.ts', '.env', '.npmrc', 'certs/dev.pem'])
      expect(indexed.has(p)).toBe(false);
  });
});

/** 找到 worker 克隆出来的工作副本(含 tsconfig.json 与 src/aws.ts 的目录) */
function mkRoot(workdir: string): string {
  const hit = walk(workdir).find((p) => p.endsWith('/src/aws.ts') && !p.includes('/.git/'));
  if (!hit) throw new Error('找不到克隆目录');
  return hit.slice(0, -'/src/aws.ts'.length);
}
