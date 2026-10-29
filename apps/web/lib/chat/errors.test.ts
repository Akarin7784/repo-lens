import { describe, expect, it } from 'vitest';
import { formatWait } from './errors';

describe('formatWait(T-236)', () => {
  it.each([
    [1, '1 秒'],
    [10, '10 秒'],
    [59, '59 秒'],
    [60, '约 1 分钟'],
    [61, '约 2 分钟'],
    [119, '约 2 分钟'],
    [120, '约 2 分钟'],
    [3599, '约 60 分钟'],
    [3600, '约 60 分钟'],
    [121, '约 3 分钟'],
  ])('%i 秒 → %s', (sec, text) => {
    expect(formatWait(sec)).toBe(text);
    expect(`${formatWait(sec)}后可再提问`).toBe(`${text}后可再提问`);
  });
});

describe('formatWait 前置条件(T-237)', () => {
  it('0 → 「0 秒」:不做兜底,由调用方保证 >0 才渲染', () => {
    expect(formatWait(0)).toBe('0 秒');
  });
});
