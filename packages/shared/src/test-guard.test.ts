import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeProbeError,
  onServiceUnavailable,
  probeService,
  requireDbTests,
} from './test-guard.js';

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

describe('probeService', () => {
  const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

  it('前 N-1 次失败、最后一次成功:可达,按指数退避等待', async () => {
    const waits: number[] = [];
    let n = 0;
    const ok = await probeService(
      'MySQL',
      '[t] x',
      async () => {
        if (++n < 4) throw fail('ETIMEDOUT', 'connect ETIMEDOUT');
      },
      {
        attempts: 4,
        baseMs: 100,
        sleep: async (ms) => void waits.push(ms),
        env: { REQUIRE_DB_TESTS: '1' },
      },
    );
    expect(ok).toBe(true);
    expect(n).toBe(4);
    expect(waits).toEqual([100, 200, 400]);
  });

  it('全部失败 + REQUIRE_DB_TESTS=1:抛错,信息带 err.code 与 message,不含 URL/口令', async () => {
    let n = 0;
    const waits: number[] = [];
    const p = probeService(
      'MySQL',
      '[t] MySQL 不可达(repolens_test)',
      async () => {
        n++;
        throw fail(
          'ECONNREFUSED',
          'connect ECONNREFUSED to mysql://root:s3cretPW@127.0.0.1:3306/db',
        );
      },
      {
        attempts: 3,
        baseMs: 10,
        sleep: async (ms) => void waits.push(ms),
        env: { REQUIRE_DB_TESTS: '1' },
      },
    );
    const err = (await p.catch((e: unknown) => e)) as Error;
    expect(n).toBe(3);
    expect(waits).toEqual([10, 20]); // 最后一次失败后不再空等
    expect(err.message).toMatch(/REQUIRE_DB_TESTS=1.*MySQL/);
    expect(err.message).toContain('ECONNREFUSED: connect ECONNREFUSED');
    expect(err.message).toContain('3 次尝试均失败');
    expect(err.message).not.toContain('s3cretPW');
    expect(err.message).not.toContain('mysql://');
  });

  it('全部失败、本地未设:只 warn 并返回 false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = await probeService(
      'Redis',
      '[t] y',
      async () => {
        throw fail('ECONNREFUSED', 'refused');
      },
      { attempts: 2, sleep: async () => {}, env: {} },
    );
    expect(ok).toBe(false);
    expect(warn.mock.calls[0]![0]).toContain('ECONNREFUSED: refused');
  });
});

describe('describeProbeError', () => {
  it('抹掉 URL 与 //user:pass@ 形态,无 code 时只给 message', () => {
    expect(describeProbeError(new Error('bad redis://:pw@h:6379/1 x'))).toBe('bad <url> x');
    expect(describeProbeError(new Error('at //root:pw@host'))).toBe('at //<cred>@host');
    expect(describeProbeError('plain')).toBe('plain');
  });
});
