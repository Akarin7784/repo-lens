import { FakeLlm } from './fake.js';
import type { LlmClient } from './types.js';

export interface LlmConfig {
  /** 目前只支持 fake;真实 OpenAI 兼容 provider 待 D1 */
  provider: 'fake';
  summaryModel: string;
  chatModel: string;
  dailyBudgetCents: number;
  taskBudgetCents: number;
}

function cents(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} 必须是非负整数(美分),收到 "${raw}"`);
  return Number(raw.trim());
}

/** 读取 LLM 相关环境变量;不需要任何 key */
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = (env.LLM_PROVIDER ?? 'fake').trim() || 'fake';
  if (provider !== 'fake') {
    throw new Error(`LLM_PROVIDER=${provider} 尚未实现(真实 provider 待 D1 决策),请用 fake`);
  }
  return {
    provider,
    // fake provider 下模型名只用于记账和缓存 key,统一用 fake(价格 0)
    summaryModel: 'fake',
    chatModel: 'fake',
    dailyBudgetCents: cents(env, 'DAILY_LLM_BUDGET_CENTS', 500),
    taskBudgetCents: cents(env, 'LLM_TASK_BUDGET_CENTS', 30),
  };
}

export function createLlmClient(cfg: LlmConfig): LlmClient {
  switch (cfg.provider) {
    case 'fake':
      return new FakeLlm();
  }
}
