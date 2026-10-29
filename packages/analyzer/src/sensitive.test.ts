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

  it('超限 / 二进制内容(绕过扫描直接传入):只留节点,不切块', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rl-big-'));
    const files: Record<string, string> = {
      'tsconfig.json': '{}',
      'src/ok.ts': 'export function ok() {\n  return 1;\n}\n',
      'src/big.ts': 'export function big() {\n  return 1;\n}\n' + '// pad\n'.repeat(80_000),
      'src/bin.ts': 'export function bin() {\n  return 1;\n}\n\u0000\u0001',
    };
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), c);
    }
    const r = await analyzeRepo({ root, files: ['src/ok.ts', 'src/big.ts', 'src/bin.ts'] });
    const by = new Map(r.parsed.map((p) => [p.path, p]));
    expect(by.get('src/big.ts')).toMatchObject({ sensitive: 'too-large', chunks: [] });
    expect(by.get('src/bin.ts')).toMatchObject({ sensitive: 'binary', chunks: [] });
    expect(by.get('src/ok.ts')?.chunks.length).toBeGreaterThan(0);
    // 正常扫描阶段本来就会跳过它们(第一道闸)
    const scanned = scanSourceFiles(root);
    expect(scanned).toContain('src/ok.ts');
    expect(scanned).not.toContain('src/big.ts');
    expect(scanned).not.toContain('src/bin.ts');
  });

  it('假 key 正好落在切块边界(跨两个切块 / 夹在切块之间)也按整份原始内容排除', async () => {
    // PEM 头在函数 a 的最后一行、正文和尾在函数 b;AKIA 在两个函数之间的注释行,不属于任何切块
    const src = (pemHead: string, aws: string) =>
      [
        'export function a() {',
        `  return \`x\n${pemHead}\`;`,
        '}',
        `// deploy id: ${aws}`,
        'export function b() {',
        '  return `MIIFAKEFAKEFAKE\n-----END PRIVATE KEY-----`;',
        '}',
        '',
      ].join('\n');
    const head = '-----BEGIN PRIVATE KEY-----';
    const root = mkdtempSync(join(tmpdir(), 'rl-sens-edge-'));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/pem.ts'), src(head, 'none'));
    writeFileSync(join(root, 'src/aws.ts'), src('none', FAKE_AWS));
    // 同样行布局、去掉 key 的对照文件:确认切块边界确实把 key 切开或漏掉
    writeFileSync(join(root, 'src/twin.ts'), src('x'.repeat(head.length), 'x'.repeat(20)));
    const r = await analyzeRepo({ root, files: scanSourceFiles(root) });
    const by = new Map(r.parsed.map((p) => [p.path, p]));
    const twin = by.get('src/twin.ts')!;
    expect(twin.sensitive).toBeUndefined();
    const inChunk = (line: number) =>
      twin.chunks.filter((c) => c.startLine <= line && line <= c.endLine);
    // 第 3 行(PEM 头)和第 8 行(PEM 尾)分属不同切块;第 5 行(AKIA)不在任何切块里
    expect(inChunk(3)).toHaveLength(1);
    expect(inChunk(8)).toHaveLength(1);
    expect(inChunk(3)[0]).not.toEqual(inChunk(8)[0]);
    expect(inChunk(5)).toHaveLength(0);
    expect(by.get('src/pem.ts')).toMatchObject({ sensitive: 'private-key-block', chunks: [] });
    expect(by.get('src/aws.ts')).toMatchObject({ sensitive: 'aws-access-key-id', chunks: [] });
  });
});
