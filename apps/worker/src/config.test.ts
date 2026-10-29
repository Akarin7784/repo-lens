import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig 接入 readLlmConfig', () => {
  it('默认 fake provider 与 D2 预算,不需要 key', () => {
    expect(loadConfig({}).llm).toMatchObject({
      provider: 'fake',
      dailyBudgetCents: 500,
      taskBudgetCents: 30,
    });
  });
  it('LLM 配置非法时直接抛错(worker 启动失败)', () => {
    expect(() => loadConfig({ DAILY_LLM_BUDGET_CENTS: 'abc' })).toThrow(/DAILY_LLM_BUDGET_CENTS/);
    expect(() => loadConfig({ LLM_TASK_BUDGET_CENTS: '-5' })).toThrow(/LLM_TASK_BUDGET_CENTS/);
    expect(() => loadConfig({ LLM_PROVIDER: 'openai' })).toThrow(/LLM_PROVIDER/);
  });
});
