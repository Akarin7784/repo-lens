/**
 * 集成测试的统一跳过判断。
 * 本地默认:服务不可达只打 warn,由调用方 describe.skipIf 跳过。
 * REQUIRE_DB_TESTS=1(CI 设置):不可达直接抛错,避免静默跳过。
 */
export function requireDbTests(env: Record<string, string | undefined> = process.env): boolean {
  return env.REQUIRE_DB_TESTS === '1';
}

export function onServiceUnavailable(
  kind: 'MySQL' | 'Redis',
  message: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (requireDbTests(env)) {
    throw new Error(`[REQUIRE_DB_TESTS=1] ${kind} 不可达,不允许跳过:${message}`);
  }
  console.warn(message);
}

/**
 * 把探测错误压成「code: message」,并抹掉其中可能出现的连接串(含口令),只给日志 / 报错用。
 *
 * 已知边界(mysql2/ioredis 实际错误一般不带连接串,风险低,单测锁定现状):
 * - 口令含空格时 scheme URL 只吃到空格前,会残留如 `w@h`
 * - 无 scheme 的 `u:p@h` 不脱敏
 */
export function describeProbeError(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = e && typeof e.code === 'string' ? e.code : undefined;
  const raw = e && typeof e.message === 'string' ? e.message : String(err);
  const msg = raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\/\/[^/\s:@]*:[^@\s]*@/g, '//<cred>@');
  return code ? `${code}: ${msg}` : msg;
}

/**
 * 去掉 MySQL URL 的库名(pathname → `/`),探测只连服务器根。
 * 用 WHATWG URL,避免 `replace(/\/[^/]*$/, '/')` 把无库名的
 * `mysql://u:p@h:3306` 吃成 `mysql://`。
 */
export function mysqlServerRootUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/';
  return u.href;
}

/** 把 MySQL URL 的 pathname 换成指定库名(自动补前导 `/`)。 */
export function mysqlUrlWithDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = db.startsWith('/') ? db : `/${db}`;
  return u.href;
}

export interface ProbeOptions {
  /** 总尝试次数,默认 4 */
  attempts?: number;
  /** 首次退避毫秒,之后翻倍,默认 250 */
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
}

/**
 * 集成测试的服务探测:`probe` 抛错则退避重试(attempts 次);全部失败时调用 onServiceUnavailable,
 * 报错信息只带最后一次错误的 err.code 与 err.message(连接串已抹掉),不带 URL / 口令。
 * REQUIRE_DB_TESTS=1 时不可达抛错,本地不设则 warn 并返回 false(语义与之前一致)。
 * 不复用 @repolens/db 的 withRetry:shared 位于依赖最底层,不能反向依赖 db。
 *
 * 最坏耗时(默认 attempts=4, baseMs=250, 单次 connectTimeout≈5s):
 * - 本机直接拒绝(ECONNREFUSED):每次探测约 1.75s(4 次尝试 + 250+500+1000ms 退避)
 * - 黑洞主机(直到 connectTimeout):每次约 21.75s(4×5s + 退避)
 * - 7 个探测累计约 152s;单包约 43.5s(可接受)。未加 env 调低 attempts,避免与 CI 语义纠缠。
 */
export async function probeService(
  kind: 'MySQL' | 'Redis',
  label: string,
  probe: () => Promise<unknown>,
  o: ProbeOptions = {},
): Promise<boolean> {
  const attempts = o.attempts ?? 4;
  const base = o.baseMs ?? 250;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await probe();
      // 文案不含「不可达」:CI 对测试日志 grep 该词会当跳过失败
      if (i > 1) console.warn(`${kind} 探测第 ${i} 次才连上`);
      return true;
    } catch (err) {
      last = err;
      if (i < attempts) await sleep(base * 2 ** (i - 1));
    }
  }
  onServiceUnavailable(
    kind,
    `${label}(${attempts} 次尝试均失败,最后错误 ${describeProbeError(last)})`,
    o.env,
  );
  return false;
}
