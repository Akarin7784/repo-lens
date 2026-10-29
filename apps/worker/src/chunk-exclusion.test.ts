import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@repolens/db';
import { prepareChunks, type AnalyzeJobData, type PipelineDeps } from './pipeline/run.js';
import { testConfig } from './test-utils.js';
import { MemoryEventSink } from './events.js';

// 独立于 analyzer 的 chunk 层排除:analysis.json 故意把敏感文件当普通文件给出(有切块、无 sensitive 标记),
// 断言 chunk 层自己拒绝。上游(analyzer)排除失效时这一层仍要兜住。
const AWS = 'AKIAFAKEFAKEFAKE2222';
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIFAKEFAKECHUNKLAYER\n-----END PRIVATE KEY-----\n';

describe('prepareChunks:chunk 层敏感排除(T-214)', () => {
  it('上游漏标的敏感文件不产出切块、不进 code_chunk', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rl-chunk-'));
    const root = join(base, 'repo');
    mkdirSync(join(root, 'src'), { recursive: true });
    const files: Record<string, string> = {
      'src/ok.ts': 'export const ok = 1;\n',
      'src/aws.ts': `export const id = '${AWS}';\n`,
      'src/tls.ts': `export const k = \`${PEM}\`;\n`,
      '.env': 'TOKEN=1\n',
    };
    for (const [p, c] of Object.entries(files)) writeFileSync(join(root, p), c);
    const parsed = Object.keys(files).map((path) => ({
      path,
      chunks: [{ symbol: null, startLine: 1, endLine: 1 }],
    }));
    writeFileSync(`${root}.analysis.json`, JSON.stringify({ parsed }));
    const store = new MemoryStore();
    const deps = { store, events: new MemoryEventSink(), config: testConfig() } as PipelineDeps;
    const data = { jobId: 'j', repoId: 1, commitSha: 'c'.repeat(40) } as AnalyzeJobData;
    const r = await prepareChunks(data, deps, root);
    expect(r.chunks.map((c) => c.path)).toEqual(['src/ok.ts']);
    expect(r.excluded.map((x) => x.path).sort()).toEqual(['.env', 'src/aws.ts', 'src/tls.ts']);
    for (const c of r.chunks) {
      expect(c.text).not.toContain(AWS);
      expect(c.text).not.toContain('PRIVATE KEY');
    }
  });
});
