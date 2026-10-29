import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** T-225b:中文回退字体栈集中定义在 globals.css,顺序按架构师裁定。 */
const css = readFileSync(join(__dirname, '..', 'globals.css'), 'utf8');
const CJK = ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC'];

/** 读出 :root 里某个变量的值,并把 var(--font-cjk-fallback) 展开成实际的字体名列表。 */
function stack(name: string): string[] {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  expect(m, `缺少 --${name}`).not.toBeNull();
  const fb = css.match(/--font-cjk-fallback:\s*([^;]+);/)?.[1] ?? '';
  return m![1]!
    .replace(/var\(--font-cjk-fallback\)/g, fb)
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function expectOrder(list: string[], first: string, generic: string) {
  const idx = [first, ...CJK].map((n) => list.indexOf(n));
  expect(
    idx.every((i) => i >= 0),
    `缺少字体:${list.join(', ')}`,
  ).toBe(true);
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  expect(list[list.length - 1]).toBe(generic);
}

describe('中文回退字体栈(T-225b)', () => {
  it('回退栈只定义一次,内容和顺序固定', () => {
    expect(css.match(/--font-cjk-fallback:/g)?.length).toBe(1);
    expect(stack('font-cjk-fallback')).toEqual(CJK);
  });
  it('衬线栈:Source Serif 4 在前,随后三个中文无衬线,sans-serif 最后', () => {
    expectOrder(stack('font-serif'), 'Source Serif 4', 'sans-serif');
  });
  it('UI 无衬线栈:Inter 在前,明确写出三个中文无衬线,sans-serif 最后', () => {
    expectOrder(stack('font-sans'), 'Inter', 'sans-serif');
  });
  it('代码栈:JetBrains Mono 在前,中文注释回退三个无衬线,monospace 最后', () => {
    expectOrder(stack('font-mono'), 'JetBrains Mono', 'monospace');
  });
  it('LICENSES.md 的完整 sha256 和文件一致', () => {
    const lic = readFileSync(join(__dirname, 'LICENSES.md'), 'utf8');
    const rows = [...lic.matchAll(/`([\w-]+\.woff2)`.*`([0-9a-f]{64})`/g)];
    expect(rows.length).toBe(3);
    for (const [, f, h] of rows) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(__dirname, f!)))
          .digest('hex'),
      ).toBe(h);
    }
  });
});
