import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FILE_MAX_LINES, FileContentSchema, SENSITIVE_PLACEHOLDER } from '@repolens/shared';
import { readRepoFile } from './files.js';
import { HttpError } from './errors.js';

const SHA = 'a'.repeat(40);
const reposDir = mkdtempSync(join(tmpdir(), 'rl-files-'));
const root = join(reposDir, '7', SHA);
const read = (path: string, start?: number, end?: number) =>
  readRepoFile({ reposDir, repoId: 7, commitSha: SHA, path, start, end });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError)
      return `${e.status} ${e.code}${e.details?.reason ? ' ' + e.details.reason : ''}`;
    throw e;
  }
  return 'ok';
};

beforeAll(() => {
  mkdirSync(join(root, 'src/sub'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'l1\nl2\r\nl3\n');
  writeFileSync(join(root, 'src/empty.ts'), '');
  writeFileSync(
    join(root, 'src/long.ts'),
    Array.from({ length: 2500 }, (_, i) => `x${i + 1}`).join('\n'),
  );
  writeFileSync(join(root, '.env'), 'X=1\n');
  writeFileSync(join(root, 'src/aws.ts'), `export const k = '${'AKIA' + 'ABCDEFGHIJKLMNOP'}';\n`);
  writeFileSync(join(root, 'src/bin.ts'), 'a\0b');
  writeFileSync(join(root, 'src/big.ts'), 'x'.repeat(600 * 1024));
  writeFileSync(join(root, '.git/config'), '[core]\n');
  writeFileSync(join(reposDir, 'outside.ts'), 'secret\n');
  symlinkSync(join(reposDir, 'outside.ts'), join(root, 'src/link.ts'));
  symlinkSync(join(root, 'src'), join(root, 'srclink'));
});

describe('readRepoFile(T-213)', () => {
  it('默认从第 1 行读;区间闭合;CRLF 归一为 \\n;末尾换行不算新行', async () => {
    const r = FileContentSchema.parse(await read('src/a.ts'));
    expect(r).toEqual({
      path: 'src/a.ts',
      commitSha: SHA,
      totalLines: 3,
      start: 1,
      end: 3,
      hasMore: false,
      content: 'l1\nl2\nl3',
      excluded: null,
    });
    expect((await read('src/a.ts', 2, 2)).content).toBe('l2');
    expect(await read('src/a.ts', 2, 99)).toMatchObject({ start: 2, end: 3, content: 'l2\nl3' });
  });
  it(`单次最多 ${FILE_MAX_LINES} 行:不给 end 时截断并 hasMore;显式超限 400`, async () => {
    const r = await read('src/long.ts');
    expect([r.start, r.end, r.totalLines, r.hasMore]).toEqual([1, 2000, 2500, true]);
    expect((await read('src/long.ts', 2001)).hasMore).toBe(false);
    expect(await code(read('src/long.ts', 1, 2001))).toBe('400 BAD_REQUEST');
    expect(await code(read('src/a.ts', 3, 2))).toBe('400 BAD_REQUEST');
    expect(await code(read('src/a.ts', 4))).toBe('400 BAD_REQUEST');
  });
  it('空文件', async () => {
    expect(await read('src/empty.ts')).toMatchObject({ totalLines: 0, content: '', start: null });
  });
  it.each([
    '../outside.ts',
    'src/../../outside.ts',
    'src/./a.ts',
    '/etc/passwd',
    'src\\a.ts',
    'C:/x',
    'src//a.ts',
    '.git/config',
    'src/link.ts',
    'srclink/a.ts',
    'src',
  ])('拒绝 %s → 400', async (p) => {
    expect(await code(read(p))).toBe('400 BAD_REQUEST');
  });
  it('不存在的文件 404;快照不存在 409', async () => {
    expect(await code(read('src/nope.ts'))).toBe('404 FILE_NOT_FOUND');
    expect(await code(read('src/a.ts/x'))).toBe('404 FILE_NOT_FOUND');
    expect(
      await code(readRepoFile({ reposDir, repoId: 8, commitSha: SHA, path: 'src/a.ts' })),
    ).toBe('409 REPO_NOT_READY SNAPSHOT_MISSING');
  });
  it('共享排除规则:敏感(路径/内容)、过大、二进制只给提示,不给内容', async () => {
    const env = await read('.env');
    expect(env).toMatchObject({ content: null, totalLines: null });
    expect(env.excluded).toEqual({ reason: 'sensitive', notice: SENSITIVE_PLACEHOLDER });
    const aws = await read('src/aws.ts');
    expect(aws.content).toBeNull();
    expect(aws.excluded).toEqual({ reason: 'sensitive', notice: SENSITIVE_PLACEHOLDER });
    expect(JSON.stringify(aws)).not.toContain('AKIA');
    expect((await read('src/big.ts')).excluded?.reason).toBe('too-large');
    expect((await read('src/bin.ts')).excluded).toMatchObject({ reason: 'binary' });
    for (const p of ['.env', 'src/aws.ts', 'src/big.ts', 'src/bin.ts'])
      expect(FileContentSchema.parse(await read(p)).content).toBeNull();
  });
});
