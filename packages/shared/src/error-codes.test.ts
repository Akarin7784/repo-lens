import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  ApiErrorSchema,
  EXCLUDED_REASONS,
  FileContentSchema,
  REPO_NOT_READY_REASONS,
  SENSITIVE_PLACEHOLDER,
  excludedNotice,
  excludedReasonOf,
} from './index.js';

describe('错误码与子原因(FILE_NOT_FOUND / REPO_NOT_READY details.reason)', () => {
  it('FILE_NOT_FOUND 是独立错误码', () => {
    expect(API_ERROR_CODES).toContain('FILE_NOT_FOUND');
    expect(
      ApiErrorSchema.parse({ error: { code: 'FILE_NOT_FOUND', message: '文件不存在' } }).error.code,
    ).toBe('FILE_NOT_FOUND');
  });
  it('details.reason 只接受三种取值,且可缺省(旧响应兼容)', () => {
    expect(REPO_NOT_READY_REASONS).toEqual([
      'GRAPH_NOT_READY',
      'SNAPSHOT_MISSING',
      'REPOS_DIR_NOT_CONFIGURED',
    ]);
    for (const reason of REPO_NOT_READY_REASONS)
      expect(
        ApiErrorSchema.safeParse({
          error: { code: 'REPO_NOT_READY', message: 'x', details: { reason } },
        }).success,
      ).toBe(true);
    expect(
      ApiErrorSchema.safeParse({ error: { code: 'REPO_NOT_READY', message: 'x' } }).success,
    ).toBe(true);
    expect(
      ApiErrorSchema.safeParse({
        error: { code: 'REPO_NOT_READY', message: 'x', details: { reason: 'OTHER' } },
      }).success,
    ).toBe(false);
  });
});

describe('excluded.reason 枚举', () => {
  const base = {
    path: 'a',
    commitSha: 'a'.repeat(40),
    totalLines: null,
    start: null,
    end: null,
    hasMore: false,
    content: null,
  };
  it('只接受 sensitive / too-large / binary', () => {
    expect(EXCLUDED_REASONS).toEqual(['sensitive', 'too-large', 'binary']);
    for (const reason of EXCLUDED_REASONS)
      expect(
        FileContentSchema.safeParse({
          ...base,
          excluded: { reason, notice: excludedNotice(reason) },
        }).success,
      ).toBe(true);
    expect(
      FileContentSchema.safeParse({ ...base, excluded: { reason: 'env-file', notice: 'x' } })
        .success,
    ).toBe(false);
  });
  it('规则 id 映射:体积/二进制原样,其余敏感规则归为 sensitive', () => {
    expect(excludedReasonOf('too-large')).toBe('too-large');
    expect(excludedReasonOf('binary')).toBe('binary');
    expect(excludedReasonOf('env-file')).toBe('sensitive');
    expect(excludedNotice('sensitive')).toBe(SENSITIVE_PLACEHOLDER);
  });
});
