import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHoverController, createHoverStore, hoverHighlight, HOVER_DELAY_MS } from './hover';
import { parseAggOpacity, AGG_EDGE_OPACITY, showWeightLabel } from './toFlow';

describe('hoverHighlight(选中优先)', () => {
  it('无选中:相连边 on,其它保持 undefined', () => {
    expect(hoverHighlight(undefined, true)).toBe('on');
    expect(hoverHighlight(undefined, false)).toBeUndefined();
  });
  it('有选中:完全以选中为准,悬停不叠加', () => {
    expect(hoverHighlight('dim', true)).toBe('dim');
    expect(hoverHighlight('on', false)).toBe('on');
  });
});

describe('createHoverController 防抖', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('进入 120ms 后才生效,离开立即恢复', () => {
    const s = createHoverStore();
    const c = createHoverController(s, () => false);
    c.enter('a');
    vi.advanceTimersByTime(HOVER_DELAY_MS - 1);
    expect(s.get()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(s.get()).toBe('a');
    c.leave();
    expect(s.get()).toBeNull();
  });
  it('快速划过(未到 120ms 就离开)不触发', () => {
    const s = createHoverStore();
    const fn = vi.fn();
    s.subscribe(fn);
    const c = createHoverController(s, () => false);
    c.enter('a');
    vi.advanceTimersByTime(50);
    c.leave();
    vi.advanceTimersByTime(500);
    expect(s.get()).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
  it('选中状态下悬停被忽略', () => {
    const s = createHoverStore();
    const c = createHoverController(s, () => true);
    c.enter('a');
    vi.advanceTimersByTime(500);
    expect(s.get()).toBeNull();
  });
});

describe('parseAggOpacity', () => {
  it('默认 0.3,合法值可切换,非法值回落', () => {
    expect(AGG_EDGE_OPACITY).toBe(0.3);
    expect(parseAggOpacity(undefined)).toBe(0.3);
    expect(parseAggOpacity('0.4')).toBe(0.4);
    expect(parseAggOpacity('abc')).toBe(0.3);
    expect(parseAggOpacity('0')).toBe(0.3);
    expect(parseAggOpacity('1.5')).toBe(0.3);
  });
});

describe('悬停时 ×N 标签', () => {
  it('zoom < 0.9 时,悬停相连的聚合边也显示 ×N;不相连的仍隐藏', () => {
    const agg = { aggregated: true, weight: 6 };
    expect(showWeightLabel({ ...agg, highlight: hoverHighlight(undefined, true) }, false)).toBe(
      true,
    );
    expect(showWeightLabel({ ...agg, highlight: hoverHighlight(undefined, false) }, false)).toBe(
      false,
    );
  });
});
