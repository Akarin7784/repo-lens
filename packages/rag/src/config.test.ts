import { describe, expect, it } from 'vitest';
import { readEmbeddingConfig } from './config.js';
import { DEFAULT_EMBED_LOCK_MAX_WAIT_SEC, DEFAULT_EMBED_LOCK_TTL_SEC } from './lock.js';

describe('向量化锁配置', () => {
  it('留空用默认值:TTL 300 秒、最长等待 3600 秒', () => {
    const c = readEmbeddingConfig({ EMBEDDING_LOCK_TTL_SEC: '', EMBEDDING_LOCK_MAX_WAIT_SEC: '' });
    expect([DEFAULT_EMBED_LOCK_TTL_SEC, DEFAULT_EMBED_LOCK_MAX_WAIT_SEC]).toEqual([300, 3600]);
    expect([c.lockTtlSec, c.lockMaxWaitSec]).toEqual([300, 3600]);
  });
  it('可配置;TTL < 60 或等待 < 1 拒绝', () => {
    const c = readEmbeddingConfig({
      EMBEDDING_LOCK_TTL_SEC: '120',
      EMBEDDING_LOCK_MAX_WAIT_SEC: '7',
    });
    expect([c.lockTtlSec, c.lockMaxWaitSec]).toEqual([120, 7]);
    expect(() => readEmbeddingConfig({ EMBEDDING_LOCK_TTL_SEC: '59' })).toThrow();
    expect(() => readEmbeddingConfig({ EMBEDDING_LOCK_MAX_WAIT_SEC: '0' })).toThrow();
  });
});
