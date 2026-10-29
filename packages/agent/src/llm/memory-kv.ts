import type { LlmKv } from './gateway.js';

/** 进程内 KV(测试 / 无 Redis 时用);TTL 不生效 */
export class MemoryLlmKv implements LlmKv {
  readonly m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
    return 'OK';
  }
  async incrby(k: string, n: number) {
    const v = Number(this.m.get(k) ?? 0) + n;
    this.m.set(k, String(v));
    return v;
  }
  async expire() {
    return 1;
  }
}
