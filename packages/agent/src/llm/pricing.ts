/**
 * 价格表:每 100 万 token 的美元价格,数值上等于「每 token 的 micro-USD」。
 * deepseek-* 按 DeepSeek 官方价格页核对;gpt-* 为 D1 前的占位,保留以兼容旧配置。
 */
export interface ModelPrice {
  /** 输入(provider 缓存未命中)价 */
  inputPerMTok: number;
  outputPerMTok: number;
  /** 输入命中 provider 上下文缓存时的价格;不设则按 inputPerMTok */
  cachedInputPerMTok?: number;
}
export type PriceTable = Record<string, ModelPrice>;

export const DEFAULT_PRICES: PriceTable = {
  // DeepSeek(D1):https://api-docs.deepseek.com/quick_start/pricing ,2026-10-29 核对。
  // 官方分时段计价,高峰(周一至周五 UTC 01:00–04:00、06:00–10:00)为下列价格,其余时段减半。
  // 为了预算保守,一律按高峰价记账(实际扣费 ≤ 记账)。
  'deepseek-flash': { inputPerMTok: 0.3, cachedInputPerMTok: 0.006, outputPerMTok: 1.2 },
  'deepseek-v4-pro': { inputPerMTok: 1.32, cachedInputPerMTok: 0.044, outputPerMTok: 3.96 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'text-embedding-3-small': { inputPerMTok: 0.02, outputPerMTok: 0 },
  // FakeLlm 不花钱;测试里要验预算时传自定义价格表
  fake: { inputPerMTok: 0, outputPerMTok: 0 },
};

export class UnknownModelPriceError extends Error {
  constructor(readonly model: string) {
    super(`模型 ${model} 不在价格表里;没有价格无法记账和执行预算,拒绝调用`);
    this.name = 'UnknownModelPriceError';
  }
}

export function priceOf(prices: PriceTable, model: string): ModelPrice {
  const p = prices[model];
  if (!p) throw new UnknownModelPriceError(model);
  return p;
}

/** 费用(micro-USD,向上取整,只要用了 token 就至少记 1) */
export function costMicroUsd(
  p: ModelPrice,
  tokensIn: number,
  tokensOut: number,
  cachedTokensIn = 0,
): number {
  const cached = Math.min(Math.max(cachedTokensIn, 0), tokensIn);
  return Math.ceil(
    (tokensIn - cached) * p.inputPerMTok +
      cached * (p.cachedInputPerMTok ?? p.inputPerMTok) +
      tokensOut * p.outputPerMTok,
  );
}
