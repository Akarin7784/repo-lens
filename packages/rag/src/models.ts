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

// 来源标记:[文档]=D1–D4(见文件头);[实测]=notes/qwen37-embedding-facts.md 2026-10-29 实测;
// [未验证]=无文档或实测依据(含沿用 #88 的值)。D1 同步接口,D2 总览,D3 模型页,D4 限流。
export const DASHSCOPE_MODELS: Readonly<Record<string, DashscopeModelCaps>> = {
  // v3 不在 qwen3.7 事实文件覆盖范围内
  'text-embedding-v3': {
    docBatchMax: 10, // [文档] 单次 ≤10 条;[实测] 11 条返回 400(#88)
    dims: [1024, 768, 512, 256, 128, 64], // [未验证] 沿用 #88,事实文件未覆盖
    defaultDim: 1024, // [未验证] 沿用 #88
    maxInputTokens: 8192, // [未验证] 沿用 #88
    defaultTpm: 1_000_000, // [未验证] 沿用 #88 的 1,000,000(Eva 2026-10-29 确认保留)
    yuanPer1kTokens: 0.0005, // [未验证] 沿用 #88
  },
  'qwen3.7-text-embedding': {
    docBatchMax: 20, // [文档] D1、D2 20 条;[实测] 20 条 200、21 条 400
    dims: [2560, 2048, 1536, 1024, 768, 512, 256], // [文档] D1、D2;[实测] 2560/256 可用,128 返回 400
    defaultDim: 1024, // [实测] 不传 dimensions 返回 1024;[文档] D1、D2 标为默认
    maxInputTokens: 128_000, // [文档] D1、D3;[未验证] 未实测
    defaultTpm: 800_000, // 本地取值:[文档] D3、D4 TPM 1,000,000(北京,主账号合并),留 20% 余量
    yuanPer1kTokens: 0.0005, // [文档] D1、D2、D3(北京)
  },
  'qwen3.7-text-embedding-flash': {
    // [文档] D1、D2 20 条;[实测] 21 条也返回 200(与文档不一致),仍按文档取 20
    docBatchMax: 20,
    // [文档] D1、D2;[实测] 256 可用,2560 返回 200 但静默回落为 1024 维,故逐批校验返回长度
    dims: [1024, 768, 512, 256],
    defaultDim: 1024, // [实测] 不传 dimensions 返回 1024;[文档] D1、D2 标为默认
    maxInputTokens: 128_000, // [文档] D1;[未验证] 未实测
    defaultTpm: 800_000, // 本地取值:[文档] D3、D4 TPM 1,000,000,留 20% 余量
    yuanPer1kTokens: 0.000125, // [文档] D1、D2、D3(北京)
  },
};

/** 实际默认批量上限:即使文档允许 20,仍按 10 发送(本地取值,与 #88 一致) */
export const DASHSCOPE_DEFAULT_BATCH_CAP = 10;

export function dashscopeModelCaps(model: string): DashscopeModelCaps | undefined {
  return Object.prototype.hasOwnProperty.call(DASHSCOPE_MODELS, model)
    ? DASHSCOPE_MODELS[model]
    : undefined;
}
