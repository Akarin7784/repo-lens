import { describe, expect, it } from 'vitest';
import { readSubmitLimits } from './limits.js';

describe('readSubmitLimits', () => {
  it('未设置或为空时默认 5 与 60', () => {
    expect(readSubmitLimits({})).toEqual({ rateLimitPerHour: 5, submitLimitPerHour: 60 });
    expect(
      readSubmitLimits({ RATE_LIMIT_NEW_REPOS_PER_HOUR: '', RATE_LIMIT_SUBMITS_PER_HOUR: ' ' }),
    ).toEqual({ rateLimitPerHour: 5, submitLimitPerHour: 60 });
  });
  it('读取环境变量', () => {
    expect(
      readSubmitLimits({ RATE_LIMIT_NEW_REPOS_PER_HOUR: '8', RATE_LIMIT_SUBMITS_PER_HOUR: '100' }),
    ).toEqual({ rateLimitPerHour: 8, submitLimitPerHour: 100 });
  });
  it('非正整数直接报错', () => {
    for (const v of ['0', '-1', '2.5', 'abc'])
      expect(() => readSubmitLimits({ RATE_LIMIT_SUBMITS_PER_HOUR: v })).toThrow(
        /RATE_LIMIT_SUBMITS_PER_HOUR/,
      );
  });
});
