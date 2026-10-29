import { describe, expect, it } from 'vitest';
import type { GraphNode } from '@repolens/shared';
import { matchScore, searchNodes } from './search';

const n = (id: string, type: GraphNode['type']): GraphNode =>
  ({ id, type, parentId: null, label: id.slice(2), path: id.slice(2) }) as GraphNode;

describe('matchScore(路径模糊匹配,T-224)', () => {
  it('末段档位:精确 > 前缀 > 包含 > 整路径包含 > 末段子序列 > 整路径子序列', () => {
    const s = (q: string, p: string) => matchScore(q, p);
    expect(s('compose.ts', 'src/compose.ts')).toBeGreaterThan(s('compose', 'src/compose.ts'));
    expect(s('compose', 'src/compose.ts')).toBeGreaterThan(s('pose', 'src/compose.ts'));
    expect(s('pose', 'src/compose.ts')).toBeGreaterThan(s('src/comp', 'src/compose.ts'));
    expect(s('src/comp', 'src/compose.ts')).toBeGreaterThan(s('cmps', 'src/compose.ts'));
    expect(s('cmps', 'src/compose.ts')).toBeGreaterThan(s('scmp', 'src/compose.ts'));
    expect(s('scmp', 'src/compose.ts')).toBeGreaterThan(0);
  });
  it('大小写不敏感;空白查询与不匹配返回 0', () => {
    expect(matchScore('COMPOSE', 'src/compose.ts')).toBeGreaterThan(0);
    expect(matchScore('  ', 'src/compose.ts')).toBe(0);
    expect(matchScore('zzz', 'src/compose.ts')).toBe(0);
    expect(matchScore('ts.c', 'src/compose.ts')).toBe(0);
  });
});

describe('searchNodes', () => {
  const nodes = [
    n('d:src/helper/compose-util', 'dir'),
    n('f:src/helper/compose-util/x.ts', 'file'),
    n('f:src/compose.ts', 'file'),
    n('f:src/jsx/compose.ts', 'file'),
    n('x:compose', 'external'),
    n('f:src/context.ts', 'file'),
  ];
  it('末段命中排在路径中段命中前;同分按路径短者优先;外部依赖不参与', () => {
    expect(searchNodes(nodes, 'compose').map((h) => h.id)).toEqual([
      'f:src/compose.ts',
      'f:src/jsx/compose.ts',
      'd:src/helper/compose-util',
      'f:src/helper/compose-util/x.ts',
    ]);
  });
  it('limit 截断前 N 条;重复 id 只出现一次', () => {
    expect(searchNodes([...nodes, nodes[2]!], 'compose', 2).map((h) => h.id)).toEqual([
      'f:src/compose.ts',
      'f:src/jsx/compose.ts',
    ]);
  });
  it('无匹配返回空数组', () => {
    expect(searchNodes(nodes, 'nothing-here')).toEqual([]);
  });
});
