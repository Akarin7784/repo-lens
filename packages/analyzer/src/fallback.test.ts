import { describe, expect, it } from 'vitest';
import { FallbackResolver, findCycles } from './index.js';

describe('FallbackResolver(paths 前缀替换)', () => {
  const files = new Set(['src/a.ts', 'src/lib/index.tsx', 'src/deep/x/y.ts', 'src/deep/z.ts']);
  const r = new FallbackResolver(files, {
    baseUrl: '.',
    paths: [
      { pattern: '@/*', targets: ['src/*'] },
      { pattern: '@/deep/*', targets: ['src/deep/x/*'] },
    ],
  });
  it('相对路径 + 扩展名/index 补全 + .js→.ts', () => {
    expect(r.resolve('src/deep/z.ts', '../a.js')).toEqual({ type: 'internal', path: 'src/a.ts' });
    expect(r.resolve('src/a.ts', './lib')).toEqual({ type: 'internal', path: 'src/lib/index.tsx' });
  });
  it('最长前缀优先', () => {
    expect(r.resolve('src/a.ts', '@/deep/y')).toEqual({
      type: 'internal',
      path: 'src/deep/x/y.ts',
    });
    expect(r.resolve('src/a.ts', '@/a')).toEqual({ type: 'internal', path: 'src/a.ts' });
  });
  it('baseUrl 非相对 / 外部包 / 内置模块', () => {
    expect(r.resolve('src/a.ts', 'src/deep/z')).toEqual({
      type: 'internal',
      path: 'src/deep/z.ts',
    });
    expect(r.resolve('src/a.ts', '@scope/pkg/sub')).toEqual({
      type: 'external',
      pkg: '@scope/pkg',
    });
    expect(r.resolve('src/a.ts', 'node:fs')).toEqual({ type: 'unresolved' });
    expect(r.resolve('src/a.ts', '@/missing')).toEqual({ type: 'unresolved' });
  });
});

describe('findCycles', () => {
  it('找出多个 SCC 与自环', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
      ['d', new Set(['d'])],
      ['e', new Set(['a'])],
    ]);
    expect(findCycles(['a', 'b', 'c', 'd', 'e'], adj)).toEqual([['a', 'b', 'c'], ['d']]);
  });
});
