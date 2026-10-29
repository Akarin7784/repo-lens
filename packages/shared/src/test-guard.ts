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
