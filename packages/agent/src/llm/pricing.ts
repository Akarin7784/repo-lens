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
  // DeepSeek(D1):https://api-docs.deepseek.com/zh-cn/quick_start/pricing ,2026-10-29 架构核对。
  // 官方页按「人民币元 / 百万 token」标价;高峰价(元):
  //   flash:缓存命中输入 0.04、未命中输入 2、输出 8
  //   pro:  缓存命中输入 0.30、未命中输入 9.0、输出 27.0
  // 这里统一按 1 USD ≈ 6.67 元换算成美元(两个模型同一汇率),保留到 0.001:
  //   flash:0.04/6.67≈0.006、2/6.67≈0.30、8/6.67≈1.2
  //   pro:  0.30/6.67≈0.045、9.0/6.67≈1.35、27.0/6.67≈4.05
  // 官方分时段计价,其余时段减半;为了预算保守,一律按高峰价记账(实际扣费 ≤ 记账)。
  'deepseek-flash': { inputPerMTok: 0.3, cachedInputPerMTok: 0.006, outputPerMTok: 1.2 },
  'deepseek-v4-pro': { inputPerMTok: 1.35, cachedInputPerMTok: 0.045, outputPerMTok: 4.05 },
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
