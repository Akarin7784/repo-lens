import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeProbeError,
  mysqlServerRootUrl,
  mysqlUrlWithDb,
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

describe('mysqlServerRootUrl / mysqlUrlWithDb', () => {
  it('带库名:pathname 置为 /', () => {
    expect(mysqlServerRootUrl('mysql://root:dev@127.0.0.1:3306/repolens_test')).toBe(
      'mysql://root:dev@127.0.0.1:3306/',
    );
  });

  it('无库名的主机 URL 不会被吃成 mysql://', () => {
    // 旧 replace(/\/[^/]*$/, '/') 会把 mysql://u:p@h:3306 变成 mysql://
    expect(mysqlServerRootUrl('mysql://u:p@h:3306')).toBe('mysql://u:p@h:3306/');
  });

  it('换库名', () => {
    expect(mysqlUrlWithDb('mysql://root:dev@127.0.0.1:3306/repolens_test', 'repolens_mig_test')).toBe(
      'mysql://root:dev@127.0.0.1:3306/repolens_mig_test',
    );
  });
});

describe('probeService', () => {
  const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

  it('前 N-1 次失败、最后一次成功:可达,按指数退避等待,并 warn 第 N 次才连上', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toMatch(/MySQL 探测第 4 次才连上/);
    expect(msg).not.toContain('不可达');
  });

  it('第 1 次即成功:不打「才连上」warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = await probeService('Redis', '[t] z', async () => {}, {
      attempts: 3,
      sleep: async () => {},
      env: {},
    });
    expect(ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
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

  it('口令含空格:scheme URL 截断后残留 w@h(现状锁定,不扩脱敏)', () => {
    expect(describeProbeError(new Error('mysql://u:p w@h/db'))).toBe('<url> w@h/db');
  });

  it('无 scheme 的 u:p@h 不脱敏(现状锁定)', () => {
    expect(describeProbeError(new Error('fail u:p@h'))).toBe('fail u:p@h');
  });
});
