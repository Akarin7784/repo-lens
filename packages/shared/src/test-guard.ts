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
