import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRepo } from './analyze.js';
import { scanSourceFiles } from './scan.js';

// 明显的假值,只用于测试排除规则
const FAKE_AWS = 'AKIAFAKEFAKEFAKE0000';
const FAKE_PEM = '-----BEGIN PRIVATE KEY-----\nMIIFAKEFAKEFAKE\n-----END PRIVATE KEY-----';

describe('敏感文件 → 不产出 embedding 切块', () => {
  it('内容含 key 特征的源码:保留图节点,chunks 为空并标记规则;普通文件照常切块', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rl-sens-'));
    const files: Record<string, string> = {
      'tsconfig.json': '{}',
      'src/index.ts':
        "import { awsKeyId } from './aws';\nexport function main() {\n  return awsKeyId;\n}\n",
      'src/aws.ts': `export const awsKeyId = '${FAKE_AWS}';\nexport function f() {\n  return 1;\n}\n`,
      'src/tls.ts': `export const pem = \`${FAKE_PEM}\`;\n`,
      '.env': `AWS=${FAKE_AWS}\n`,
    };
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), c);
    }
    const r = await analyzeRepo({ root, files: scanSourceFiles(root) });
    const by = new Map(r.parsed.map((p) => [p.path, p]));
    expect(by.has('.env')).toBe(false);
    expect(by.get('src/aws.ts')).toMatchObject({ sensitive: 'aws-access-key-id', chunks: [] });
    expect(by.get('src/tls.ts')).toMatchObject({ sensitive: 'private-key-block', chunks: [] });
    expect(by.get('src/index.ts')?.sensitive).toBeUndefined();
    expect(by.get('src/index.ts')?.chunks.length).toBeGreaterThan(0);
    expect(r.graph.nodes.some((n) => n.id === 'f:src/aws.ts')).toBe(true);
  });
});
