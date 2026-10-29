import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** T-225:构建与运行都不依赖外网字体。扫描 apps/web 源码,禁止 next/font/google 和外链字体 CSS。 */
const ROOT = join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', '.next', 'fixtures']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return [];
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(tsx?|mjs|cjs|js|css)$/.test(n) && !n.endsWith('.test.ts') ? [p] : [];
  });
}

describe('字体自托管(T-225)', () => {
  it('源码里没有 next/font/google 或 Google Fonts 外链', () => {
    const bad = sources(ROOT).filter((p) =>
      /next\/font\/google|fonts\.(googleapis|gstatic)\.com/.test(readFileSync(p, 'utf8')),
    );
    expect(bad.map((p) => relative(ROOT, p))).toEqual([]);
  });

  it('layout 引用的本地字体文件都存在且在 LICENSES.md 里登记', () => {
    const layout = readFileSync(join(ROOT, 'app', 'layout.tsx'), 'utf8');
    const files = [...layout.matchAll(/\.\/fonts\/([\w.-]+\.woff2)/g)].map((m) => m[1]!);
    expect(files.length).toBe(3);
    const lic = readFileSync(join(__dirname, 'LICENSES.md'), 'utf8');
    for (const f of files) {
      expect(statSync(join(__dirname, f)).size).toBeGreaterThan(10_000);
      expect(lic).toContain(f);
    }
    expect(lic.match(/SIL Open Font License/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
