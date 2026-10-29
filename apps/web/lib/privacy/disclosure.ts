import type { RepoStatus } from '@repolens/shared';

export type EmbeddingProvider = NonNullable<RepoStatus['embeddingProvider']>;

/**
 * 第三方数据流披露(T-231 / T-234)。
 * - 提交页:提交前还没有分析任务,无法知道该仓库会用哪个 embedding 提供方,所以显示覆盖最坏情况的静态文案
 *   THIRD_PARTY_DISCLOSURE。README「隐私与数据流」一节手写同一段文字,两处须逐字一致(home.test.tsx 检查)。
 * - 分析工作区(问答面板):已有 RepoStatus.embeddingProvider 时用 getDisclosure(provider) 显示更准确的文案;
 *   字段缺省一律按「未知」处理,不当 local。
 * 「会被过滤」的范围以 packages/shared/src/sensitive.ts 的 exclusionRule 为准(.env* 与私钥均在规则内)。
 */
const FILTER_NOTE =
  '发送前会按规则过滤常见的密钥和环境变量文件(如 .env、私钥),但不保证覆盖所有敏感内容,请勿提交含敏感信息的仓库。';

export const THIRD_PARTY_DISCLOSURE =
  '启用外部向量服务时,检索所需的代码片段会发送给阿里云百炼;生成摘要和问答时,相关代码片段还会发送给所配置的大模型服务。你输入的问题也会发送给阿里云百炼和大模型服务。' +
  FILTER_NOTE;

export const PROVIDER_DISCLOSURE = {
  dashscope:
    '本仓库的向量由阿里云百炼生成:检索所需的代码片段会发送给阿里云百炼;生成摘要和问答时,相关代码片段还会发送给所配置的大模型服务。你输入的问题会发送给阿里云百炼和大模型服务。' +
    FILTER_NOTE,
  local:
    '本仓库的向量在本机生成,代码片段不会发送给第三方向量服务;生成摘要和问答时,相关代码片段仍会发送给所配置的大模型服务。你输入的问题也会发送给大模型服务(用于生成回答)。' +
    FILTER_NOTE,
  unknown:
    '本仓库的向量提供方未知,按最坏情况说明:代码片段和你输入的问题可能会发送给阿里云百炼和所配置的大模型服务。' +
    FILTER_NOTE,
} as const;

/** 按提供方取披露文案;undefined(RepoStatus 没有该字段)或任何非约定值都按「未知」 */
export function getDisclosure(provider: EmbeddingProvider | undefined): string {
  if (provider === 'dashscope') return PROVIDER_DISCLOSURE.dashscope;
  if (provider === 'local') return PROVIDER_DISCLOSURE.local;
  return PROVIDER_DISCLOSURE.unknown;
}
