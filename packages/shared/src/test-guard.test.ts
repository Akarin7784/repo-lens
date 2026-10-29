import { afterEach, describe, expect, it, vi } from 'vitest';
import { onServiceUnavailable, requireDbTests } from './test-guard.js';

afterEach(() => vi.restoreAllMocks());

describe('onServiceUnavailable', () => {
  it('REQUIRE_DB_TESTS=1 时 MySQL/Redis 跳过路径抛错', () => {
    const env = { REQUIRE_DB_TESTS: '1' };
    expect(() => onServiceUnavailable('MySQL', 'x', env)).toThrow(/REQUIRE_DB_TESTS=1.*MySQL/);
    expect(() => onServiceUnavailable('Redis', 'x', env)).toThrow(/REQUIRE_DB_TESTS=1.*Redis/);
  });

  it('未设置时只打 warn,不抛错(本地行为不变)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => onServiceUnavailable('Redis', 'msg', {})).not.toThrow();
    expect(warn).toHaveBeenCalledWith('msg');
  });

  it('只认 "1"', () => {
    expect(requireDbTests({ REQUIRE_DB_TESTS: '0' })).toBe(false);
    expect(requireDbTests({ REQUIRE_DB_TESTS: 'true' })).toBe(false);
    expect(requireDbTests({ REQUIRE_DB_TESTS: '1' })).toBe(true);
  });
});
