import { BreakerClient, type BreakerKv } from './breaker.js';
import { DEEPSEEK_DEFAULT_BASE_URL, DeepSeekClient } from './deepseek.js';
import { FakeLlm } from './fake.js';
import type { LlmClient } from './types.js';

export const LLM_PROVIDERS = ['fake', 'deepseek'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';

export interface LlmConfig {
  provider: LlmProvider;
  /** LLM_SUMMARY_MODEL:file/dir/module 摘要 */
  summaryModel: string;
  /** LLM_CHAT_MODEL:repo 摘要与问答 */
  chatModel: string;
  dailyBudgetCents: number;
  taskBudgetCents: number;
  /** DEEPSEEK_BASE_URL(仅 deepseek) */
  baseUrl: string | null;
  /** DEEPSEEK_API_KEY 是否已设置;key 本身不放进配置对象,避免被日志/序列化带出 */
  hasApiKey: boolean;
}

function cents(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} 必须是非负整数(美分),收到 "${raw}"`);
  return Number(raw.trim());
}
const str = (env: NodeJS.ProcessEnv, name: string) => env[name]?.trim() || undefined;

/** 读取 LLM 相关环境变量。默认 fake,不需要 key;LLM_PROVIDER=deepseek 时必须有 DEEPSEEK_API_KEY */
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = str(env, 'LLM_PROVIDER') ?? 'fake';
  if (!(LLM_PROVIDERS as readonly string[]).includes(provider))
    throw new Error(`LLM_PROVIDER 只能是 ${LLM_PROVIDERS.join(' | ')},收到 "${provider}"`);
  const base = {
    dailyBudgetCents: cents(env, 'DAILY_LLM_BUDGET_CENTS', 500),
    taskBudgetCents: cents(env, 'LLM_TASK_BUDGET_CENTS', 30),
  };
  if (provider === 'fake')
    // fake 下模型名只用于记账和缓存 key,统一用 fake(价格 0),忽略模型变量
    return {
      provider,
      summaryModel: 'fake',
      chatModel: 'fake',
      baseUrl: null,
      hasApiKey: false,
      ...base,
    };
  if (!str(env, 'DEEPSEEK_API_KEY'))
    throw new Error('LLM_PROVIDER=deepseek 需要设置 DEEPSEEK_API_KEY');
  const baseUrl = str(env, 'DEEPSEEK_BASE_URL') ?? DEEPSEEK_DEFAULT_BASE_URL;
  if (!/^https?:\/\//.test(baseUrl))
    throw new Error(`DEEPSEEK_BASE_URL 必须是 http(s) URL,收到 "${baseUrl}"`);
  return {
    provider: 'deepseek',
    summaryModel: str(env, 'LLM_SUMMARY_MODEL') ?? DEEPSEEK_DEFAULT_MODEL,
    chatModel: str(env, 'LLM_CHAT_MODEL') ?? DEEPSEEK_DEFAULT_MODEL,
    baseUrl,
    hasApiKey: true,
    ...base,
  };
}

/**
 * 按配置建底层客户端。deepseek 的 key 在这里才从 env 读取,只交给 DeepSeekClient 的私有字段。
 * 传 kv(Redis)时套上 provider 级熔断 `cb:llm:{provider}`。
 */
export function createLlmClient(
  cfg: LlmConfig,
  o: { env?: NodeJS.ProcessEnv; kv?: BreakerKv; fetch?: typeof fetch } = {},
): LlmClient {
  switch (cfg.provider) {
    case 'fake':
      return new FakeLlm();
    case 'deepseek': {
      const env = o.env ?? process.env;
      const c = new DeepSeekClient(env.DEEPSEEK_API_KEY?.trim() ?? '', {
        baseUrl: cfg.baseUrl ?? undefined,
        fetch: o.fetch,
      });
      return o.kv ? new BreakerClient(c, o.kv) : c;
    }
  }
}
