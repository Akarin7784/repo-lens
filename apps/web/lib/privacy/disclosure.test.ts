import { describe, expect, it } from 'vitest';
import { getDisclosure, PROVIDER_DISCLOSURE, THIRD_PARTY_DISCLOSURE } from './disclosure';

const FILTER = '不保证覆盖所有敏感内容';

describe('getDisclosure(T-234)', () => {
  it('dashscope:代码片段发阿里云百炼,问题发阿里云百炼和大模型服务', () => {
    const t = getDisclosure('dashscope');
    expect(t).toBe(PROVIDER_DISCLOSURE.dashscope);
    expect(t).toContain('代码片段会发送给阿里云百炼');
    expect(t).toContain('问题会发送给阿里云百炼和大模型服务');
    expect(t).toContain(FILTER);
  });

  it('local:向量本机生成、不发第三方向量服务;问题仍发大模型服务;不提阿里云百炼', () => {
    const t = getDisclosure('local');
    expect(t).toBe(PROVIDER_DISCLOSURE.local);
    expect(t).toContain('不会发送给第三方向量服务');
    expect(t).toContain('问题也会发送给大模型服务');
    expect(t).not.toContain('阿里云百炼');
    expect(t).toContain(FILTER);
  });

  it('非约定值(旧/异常响应)→ 未知,保守口径', () => {
    const t = getDisclosure('openai' as never);
    expect(t).toBe(PROVIDER_DISCLOSURE.unknown);
  });

  it('缺省(undefined)→ 未知,保守口径,绝不当 local', () => {
    const t = getDisclosure(undefined);
    expect(t).toBe(PROVIDER_DISCLOSURE.unknown);
    expect(t).not.toBe(PROVIDER_DISCLOSURE.local);
    expect(t).toContain('未知');
    expect(t).toContain('可能会发送给阿里云百炼和所配置的大模型服务');
    expect(t).toContain(FILTER);
  });

  it('三种文案与提交页静态文案都不点名具体模型', () => {
    for (const t of [...Object.values(PROVIDER_DISCLOSURE), THIRD_PARTY_DISCLOSURE])
      expect(t).not.toMatch(/deepseek|qwen|通义|gpt|claude|text-embedding/i);
  });
});
