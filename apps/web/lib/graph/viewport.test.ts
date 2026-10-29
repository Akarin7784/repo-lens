import { describe, expect, it } from 'vitest';
import { absolutePosition, anchoredViewport, makeAnchor, viewportAfterLayout } from './viewport';

const nodes = [
  { id: 'm:a', position: { x: 100, y: 50 } },
  { id: 'd:a/src', position: { x: 10, y: 20 }, parentId: 'm:a' },
  { id: 'f:a/src/x.ts', position: { x: 3, y: 4 }, parentId: 'd:a/src' },
];

describe('viewport 锚点(T-239)', () => {
  it('absolutePosition 沿 parentId 累加子流程相对坐标;找不到返回 null', () => {
    expect(absolutePosition(nodes, 'm:a')).toEqual({ x: 100, y: 50 });
    expect(absolutePosition(nodes, 'f:a/src/x.ts')).toEqual({ x: 113, y: 74 });
    expect(absolutePosition(nodes, 'nope')).toBeNull();
  });

  it('布局后节点移动:缩放不变,锚点节点屏幕位置不变', () => {
    const vp = { x: -40, y: 30, zoom: 1.7 };
    const a = makeAnchor('m:a', { x: 100, y: 50 }, vp)!;
    const moved = { x: 420, y: -80 };
    const v = anchoredViewport(a, moved);
    expect(v.zoom).toBe(1.7);
    expect(moved.x * v.zoom + v.x).toBeCloseTo(a.sx);
    expect(moved.y * v.zoom + v.y).toBeCloseTo(a.sy);
  });

  it('节点没动:视口完全不变(展开/收起前后 zoom+pan 不变)', () => {
    const vp = { x: 12, y: -7, zoom: 0.6 };
    const a = makeAnchor('m:a', { x: 100, y: 50 }, vp)!;
    expect(viewportAfterLayout(a, nodes)).toEqual(vp);
  });

  it('无锚点(初次加载/切仓库/自动下探/全部收起)→ fit;锚点节点已不在图中 → fit', () => {
    expect(viewportAfterLayout(null, nodes)).toBe('fit');
    const a = makeAnchor('gone', { x: 0, y: 0 }, { x: 0, y: 0, zoom: 1 })!;
    expect(viewportAfterLayout(a, nodes)).toBe('fit');
  });
});

describe('viewport 非有限数保护(T-241)', () => {
  it('makeAnchor:视口或坐标含 NaN/Infinity → null(不锚定)', () => {
    const p = { x: 100, y: 50 };
    expect(makeAnchor('m:a', p, { x: NaN, y: NaN, zoom: NaN })).toBeNull();
    expect(makeAnchor('m:a', p, { x: 0, y: 0, zoom: NaN })).toBeNull();
    expect(makeAnchor('m:a', p, { x: Infinity, y: 0, zoom: 1 })).toBeNull();
    expect(makeAnchor('m:a', { x: NaN, y: 0 }, { x: 0, y: 0, zoom: 1 })).toBeNull();
    expect(makeAnchor('m:a', p, { x: 0, y: 0, zoom: 1 })).not.toBeNull();
  });

  it('viewportAfterLayout:锚点含 NaN 或计算结果非有限 → fit', () => {
    expect(viewportAfterLayout({ id: 'm:a', sx: NaN, sy: NaN, zoom: NaN }, nodes)).toBe('fit');
    expect(viewportAfterLayout({ id: 'm:a', sx: 0, sy: 0, zoom: NaN }, nodes)).toBe('fit');
    const bad = [{ id: 'm:a', position: { x: NaN, y: 0 } }];
    expect(viewportAfterLayout({ id: 'm:a', sx: 1, sy: 2, zoom: 1 }, bad)).toBe('fit');
    const huge = [{ id: 'm:a', position: { x: Number.MAX_VALUE, y: 0 } }];
    expect(viewportAfterLayout({ id: 'm:a', sx: 1, sy: 2, zoom: 10 }, huge)).toBe('fit');
  });
});
