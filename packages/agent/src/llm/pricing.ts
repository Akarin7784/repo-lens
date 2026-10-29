/**
 * 价格表:每 100 万 token 的美元价格,数值上等于「每 token 的 micro-USD」。
 * 默认值按 D1 建议(gpt-4o-mini / gpt-4o 公开价),D1 定下 provider 后再核对。
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}
export type PriceTable = Record<string, ModelPrice>;

export const DEFAULT_PRICES: PriceTable = {
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
export function costMicroUsd(p: ModelPrice, tokensIn: number, tokensOut: number): number {
  return Math.ceil(tokensIn * p.inputPerMTok + tokensOut * p.outputPerMTok);
}
