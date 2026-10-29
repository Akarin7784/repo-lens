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

describe('ONNX 线程数', () => {
  it('显式 EMBEDDING_THREADS 优先;否则按 WORKER_CPUS 向下取整、至少 1;都没有为 undefined', () => {
    expect(readEmbeddingConfig({ EMBEDDING_THREADS: '3', WORKER_CPUS: '2' }).threads).toBe(3);
    expect(readEmbeddingConfig({ WORKER_CPUS: '2' }).threads).toBe(2);
    expect(readEmbeddingConfig({ WORKER_CPUS: '1.5' }).threads).toBe(1);
    expect(readEmbeddingConfig({ WORKER_CPUS: '0.5' }).threads).toBe(1);
    expect(readEmbeddingConfig({ EMBEDDING_THREADS: '', WORKER_CPUS: '' }).threads).toBeUndefined();
    expect(() => readEmbeddingConfig({ EMBEDDING_THREADS: '0' })).toThrow();
    expect(() => readEmbeddingConfig({ EMBEDDING_THREADS: '1.5' })).toThrow();
  });
  it('pipeline 选项:有线程数才设 session_options', async () => {
    const { onnxPipelineOptions } = await import('./embedder.js');
    expect(onnxPipelineOptions(2)).toEqual({
      dtype: 'fp32',
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    });
    expect(onnxPipelineOptions()).toEqual({ dtype: 'fp32' });
  });
});
