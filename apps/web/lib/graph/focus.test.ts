import { describe, expect, it } from 'vitest';
import type { GraphNode } from '@repolens/shared';
import { nextFocusStep } from './focus';

const n = (id: string, type: GraphNode['type'], parentId: string | null): GraphNode =>
  ({ id, type, parentId, label: id.slice(2), path: id.slice(2) }) as GraphNode;

describe('nextFocusStep(suggestedFocus 逐层下探)', () => {
  const root = [n('m:.', 'module', null), n('m:packages/core', 'module', null)];
  it('focus 不在已加载节点里:先展开覆盖它的最深容器(m:. 覆盖一切)', () => {
    expect(nextFocusStep(root, new Set(), 'd:src')).toBe('m:.');
    expect(nextFocusStep(root, new Set(), 'd:packages/core/src')).toBe('m:packages/core');
  });
  it('focus 已加载:未展开返回它本身,已展开返回 null(完成)', () => {
    const l2 = [...root, n('d:src', 'dir', 'm:.')];
    expect(nextFocusStep(l2, new Set(['m:.']), 'd:src')).toBe('d:src');
    expect(nextFocusStep(l2, new Set(['m:.', 'd:src']), 'd:src')).toBeNull();
  });
  it('祖先已展开但 focus 仍不在树上:返回 null,不做兜底', () => {
    expect(nextFocusStep(root, new Set(['m:.', 'm:packages/core']), 'd:nowhere')).toBeNull();
    expect(nextFocusStep([n('m:a', 'module', null)], new Set(), 'd:b/c')).toBeNull();
  });
  it('路径前缀按段比较:m:pkg 不覆盖 d:pkg2/x', () => {
    expect(nextFocusStep([n('m:pkg', 'module', null)], new Set(), 'd:pkg2/x')).toBeNull();
  });
});
