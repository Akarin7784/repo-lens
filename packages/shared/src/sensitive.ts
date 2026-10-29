/**
 * 敏感文件排除规则(摘要提示词、embedding 切块 / RAG 来源、`/files` 接口共用同一份规则表)。
 * 命中的文件:内容不送模型、不进切块与检索、不对外返回;只保留路径、语言、行数做规则摘要。
 * 规则表可扩展:往 SENSITIVE_PATH_RULES / SENSITIVE_CONTENT_RULES 追加即可,id 会出现在日志与提示里
 * (只记规则 id,绝不记命中的内容)。
 */
export interface SensitivePathRule {
  id: string;
  /** 对文件名(basename,小写)匹配 */
  test: RegExp;
}
export interface SensitiveContentRule {
  id: string;
  test: RegExp;
}

export const SENSITIVE_PATH_RULES: SensitivePathRule[] = [
  { id: 'dotenv', test: /^\.env($|\.)/ }, // .env、.env.local、.env.production…(含 .env.example,宁可多排)
  { id: 'pem', test: /\.pem$/ },
  { id: 'ssh-key', test: /^id_(rsa|dsa|ecdsa|ed25519)/ },
  { id: 'key-file', test: /\.key$/ },
  { id: 'certificate', test: /\.(crt|cer|der|p7b)$/ },
  { id: 'keystore', test: /\.(p12|pfx|jks|keystore)$/ },
  { id: 'npmrc', test: /^\.npmrc$/ },
  { id: 'netrc', test: /^[._]netrc$/ },
  { id: 'pgpass', test: /^\.pgpass$/ },
  { id: 'htpasswd', test: /^\.htpasswd$/ },
];

export const SENSITIVE_CONTENT_RULES: SensitiveContentRule[] = [
  { id: 'private-key-block', test: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/ },
  { id: 'aws-access-key-id', test: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', test: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: 'openai-style-key', test: /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { id: 'slack-token', test: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'google-api-key', test: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-secret-key', test: /\b[sr]k_live_[0-9A-Za-z]{16,}/ },
];

const base = (p: string) => (p.split('/').pop() ?? p).toLowerCase();

/** 只看路径;命中返回规则 id */
export function sensitivePathRule(path: string): string | null {
  const b = base(path);
  return SENSITIVE_PATH_RULES.find((r) => r.test.test(b))?.id ?? null;
}

/** 只看内容;命中返回规则 id */
export function sensitiveContentRule(content: string): string | null {
  return SENSITIVE_CONTENT_RULES.find((r) => r.test.test(content))?.id ?? null;
}

/** 路径或内容任一命中即排除;content 为 null 时只看路径 */
export function sensitiveRule(path: string, content: string | null): string | null {
  return sensitivePathRule(path) ?? (content === null ? null : sensitiveContentRule(content));
}

/** `/files` 等对外接口返回的占位提示 */
export const SENSITIVE_PLACEHOLDER = '[已排除:疑似敏感文件,内容不展示、不送模型、不建索引]';
