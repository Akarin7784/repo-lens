/**
 * LLM 日志/错误文案脱敏。
 * 每次调用新建 RegExp,避免导出带 /g 的常量在多次 .test/.exec 间 lastIndex 粘连。
 */

/** 通用 OpenAI 风格 key 形态,含部分打码回显(`sk-ab****xyz`);至少 4 个后续字符才匹配 */
const SK_SOURCE = '(?<![A-Za-z0-9])sk-[A-Za-z0-9*._-]{4,}';

/** 把文案里的 `sk-…` 形态一律换成 `***`;不足 4 个后续字符的 `sk-xx` 不动 */
export function redactSecrets(s: string): string {
  return s.replace(new RegExp(SK_SOURCE, 'gi'), '***');
}
