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
  // credentials、credentials.json、.git-credentials、gcp-credentials.json 这类凭据文件;
  // 只认无扩展名或配置/数据扩展名,credentials.ts 这类源码不算
  {
    id: 'credentials-file',
    test: /(^|[._-])credentials(\.(json|ya?ml|toml|ini|xml|txt|csv|conf|cfg|properties))?$/,
  },
  // secrets、secrets.json / secrets.yml …:与 credentials 同规则,只认无扩展名或配置/数据扩展名,
  // secrets.ts 这类源码按内容规则判断
  { id: 'secrets-file', test: /^secrets(\.(json|ya?ml|toml|env|ini|txt))?$/ },
];

export const SENSITIVE_CONTENT_RULES: SensitiveContentRule[] = [
  { id: 'private-key-block', test: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/ },
  { id: 'aws-access-key-id', test: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', test: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: 'openai-style-key', test: /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { id: 'slack-token', test: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'google-api-key', test: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-secret-key', test: /\b[sr]k_(live|test)_[0-9A-Za-z]{16,}/ },
  // .npmrc 写法:`//registry.npmjs.org/:_authToken=…` 或顶层 `_authToken=…`(值为 ${ENV} 引用的不算)
  { id: 'npm-auth-token', test: /(^|:)_authToken\s*=\s*(?!\$\{)\S+/m },
  { id: 'npm-token', test: /\bnpm_[A-Za-z0-9]{36}\b/ },
  // JWT:三段 base64url,头和载荷都以 eyJ 开头
  { id: 'jwt', test: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
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

/** 送模型 / 切块的单文件体积上限(字节),与 analyzer 扫描的 MAX_FILE_BYTES 一致 */
export const MAX_SEND_BYTES = 500 * 1024;

/** 超限或二进制(含 NUL)的内容:只给规则摘要,不送模型、不切块 */
export function unsendableContentRule(content: string): 'too-large' | 'binary' | null {
  if (Buffer.byteLength(content, 'utf8') > MAX_SEND_BYTES) return 'too-large';
  if (content.includes('\u0000')) return 'binary';
  return null;
}

/** 送模型 / 切块前的总闸:敏感规则 → 体积 → 二进制;content 为 null 时只看路径 */
export function exclusionRule(path: string, content: string | null): string | null {
  return sensitiveRule(path, content) ?? (content === null ? null : unsendableContentRule(content));
}

/** `/files` 等对外接口返回的占位提示 */
export const SENSITIVE_PLACEHOLDER = '[已排除:疑似敏感文件,内容不展示、不送模型、不建索引]';
