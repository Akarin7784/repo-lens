/**
 * DashScope embedding 模型能力表(按模型名)。
 *
 * 来源:阿里云百炼文档
 * - 同步接口 https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api
 * - 向量化总览 https://help.aliyun.com/zh/model-studio/embedding
 * - 模型页 https://help.aliyun.com/zh/model-studio/qwen3-7-text-embedding
 * - 限流 https://help.aliyun.com/zh/model-studio/rate-limit
 * 文档页更新日期未验证(页面「更新时间」为脚本渲染,抓取为空)。
 * 429 响应头(Retry-After / ratelimit 头)未验证:实测未触发 429,成功与 400 响应均无相关头。
 * 单条 token 上限为文档值,未实测;字符截断仍按保守的 DASHSCOPE_MAX_INPUT_CHARS。
 */
export interface DashscopeModelCaps {
  /** 文档单次最多条数(不依赖 flash 实测可收 21 条) */
  docBatchMax: number;
  /** 允许的 dimensions 取值 */
  dims: readonly number[];
  /** 未配置 DASHSCOPE_EMBEDDING_DIM 时使用 */
  defaultDim: number;
  /** 单条输入 token 上限(文档值,未实测) */
  maxInputTokens: number;
  /** 默认每分钟 token 上限(进程内令牌桶) */
  defaultTpm: number;
  /** 价格(元 / 千 token,北京) */
  yuanPer1kTokens: number;
}

export const DASHSCOPE_MODELS: Readonly<Record<string, DashscopeModelCaps>> = {
  // v3:官方单次 ≤10 条(2026-10-29 实测 11 条 400);单条 8192 token;TPM 沿用 #88 的 1,000,000
  'text-embedding-v3': {
    docBatchMax: 10,
    dims: [1024, 768, 512, 256, 128, 64],
    defaultDim: 1024,
    maxInputTokens: 8192,
    defaultTpm: 1_000_000,
    yuanPer1kTokens: 0.0005,
  },
  // qwen3.7:官方 TPM 1,000,000(北京,主账号合并计算),默认取 800,000 留余量
  'qwen3.7-text-embedding': {
    docBatchMax: 20,
    dims: [2560, 2048, 1536, 1024, 768, 512, 256],
    defaultDim: 1024,
    maxInputTokens: 128_000,
    defaultTpm: 800_000,
    yuanPer1kTokens: 0.0005,
  },
  // flash 传表外维度(如 2560)实测会静默返回 1024 维,故只允许下列维度,且逐批校验返回长度
  'qwen3.7-text-embedding-flash': {
    docBatchMax: 20,
    dims: [1024, 768, 512, 256],
    defaultDim: 1024,
    maxInputTokens: 128_000,
    defaultTpm: 800_000,
    yuanPer1kTokens: 0.000125,
  },
};

/** 实际默认批量上限:即使文档允许 20,仍按 10 发送 */
export const DASHSCOPE_DEFAULT_BATCH_CAP = 10;

export function dashscopeModelCaps(model: string): DashscopeModelCaps | undefined {
  return Object.prototype.hasOwnProperty.call(DASHSCOPE_MODELS, model)
    ? DASHSCOPE_MODELS[model]
    : undefined;
}
