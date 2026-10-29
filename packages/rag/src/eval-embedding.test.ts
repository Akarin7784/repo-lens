import { describe, expect, it } from 'vitest';
import { FakeEmbedder } from './embedder.js';
import { DashscopeEmbedder } from './dashscope.js';
import {
  evalEmbeddingLine,
  evalVectorCacheFile,
  makeEvalEmbedder,
  selectEvalEmbedding,
} from './eval-embedding.js';

const FAKE_KEY = 'sk-test-not-a-real-key';

describe('评测 embedding 选择(scripts/rag-eval.mjs)', () => {
  it('默认 local:模型、维度、集合名与向量缓存路径固定(行为不变)', () => {
    const c = selectEvalEmbedding({});
    expect(c).toEqual({
      provider: 'local',
      model: 'Xenova/multilingual-e5-small',
      dim: 384,
      collection: 'eval_local_Xenova_multilingual-e5-small_384',
      dashscope: null,
    });
    expect(evalVectorCacheFile(c, null)).toBe('/tmp/rl-eval-vectors.json');
    expect(evalVectorCacheFile(c, 'v3')).toBe('/tmp/rl-eval-vectors-v3.json');
    // local 不读 EMBEDDING_MODEL / DASHSCOPE_*,也不要求 key
    expect(
      selectEvalEmbedding({
        EMBEDDING_MODEL: 'other',
        DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding',
      }),
    ).toEqual(c);
    expect(evalEmbeddingLine(c)).toBe(
      'EVAL embedding provider=local model=Xenova/multilingual-e5-small dim=384 collection=eval_local_Xenova_multilingual-e5-small_384',
    );
  });

  it('dashscope:默认模型仍为 text-embedding-v3;集合名带 provider+model+请求维度', () => {
    const c = selectEvalEmbedding({ EMBEDDING_PROVIDER: 'dashscope', DASHSCOPE_API_KEY: FAKE_KEY });
    expect([c.provider, c.model, c.dim, c.collection]).toEqual([
      'dashscope',
      'text-embedding-v3',
      1024,
      'eval_dashscope_text-embedding-v3_1024',
    ]);
    const q = selectEvalEmbedding({
      EMBEDDING_PROVIDER: 'dashscope',
      DASHSCOPE_API_KEY: FAKE_KEY,
      DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding-flash',
      DASHSCOPE_EMBEDDING_DIM: '512',
    });
    expect(q.collection).toBe('eval_dashscope_qwen3_7-text-embedding-flash_512');
    expect(evalVectorCacheFile(q, null)).toBe(
      '/tmp/rl-eval-vectors-eval_dashscope_qwen3_7-text-embedding-flash_512.json',
    );
    expect(evalVectorCacheFile(q, null)).not.toBe(evalVectorCacheFile(c, null));
  });

  it('dashscope:key 只读 DASHSCOPE_API_KEY,缺失报错只报变量名;开始行不含 key', () => {
    expect(() =>
      selectEvalEmbedding({ EMBEDDING_PROVIDER: 'dashscope', DEEPSEEK_API_KEY: FAKE_KEY }),
    ).toThrow(/DASHSCOPE_API_KEY/);
    const c = selectEvalEmbedding({ EMBEDDING_PROVIDER: 'dashscope', DASHSCOPE_API_KEY: FAKE_KEY });
    expect(c.dashscope?.apiKey).toBe(FAKE_KEY);
    expect(evalEmbeddingLine(c)).not.toContain(FAKE_KEY);
    expect(() => selectEvalEmbedding({ EMBEDDING_PROVIDER: 'openai' })).toThrow(
      /EMBEDDING_PROVIDER/,
    );
    let msg = '';
    try {
      selectEvalEmbedding({
        EMBEDDING_PROVIDER: 'dashscope',
        DASHSCOPE_API_KEY: FAKE_KEY,
        DASHSCOPE_EMBEDDING_MODEL: 'qwen3.7-text-embedding-flash',
        DASHSCOPE_EMBEDDING_DIM: '2560',
      });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain('DASHSCOPE_EMBEDDING_DIM');
    expect(msg).not.toContain(FAKE_KEY);
  });

  it('makeEvalEmbedder:local 走 local 工厂;dashscope 用假 fetch,不发真实请求;维度不符报错', async () => {
    const local = makeEvalEmbedder(selectEvalEmbedding({}), {
      local: () => new FakeEmbedder(),
      dashscope: () => {
        throw new Error('不应调用');
      },
    });
    expect(local.dim).toBe(384);
    const c = selectEvalEmbedding({
      EMBEDDING_PROVIDER: 'dashscope',
      DASHSCOPE_API_KEY: FAKE_KEY,
      DASHSCOPE_EMBEDDING_DIM: '64',
    });
    const urls: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      urls.push(url);
      const n = (JSON.parse(String(init.body)).input as string[]).length;
      return new Response(
        JSON.stringify({
          data: Array.from({ length: n }, (_, index) => ({
            index,
            embedding: Array(64).fill(0.125),
          })),
          usage: { total_tokens: n },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const ds = makeEvalEmbedder(c, {
      local: () => new FakeEmbedder(),
      dashscope: (cfg) => new DashscopeEmbedder(cfg, { fetch: fakeFetch }),
    });
    expect((await ds.embedQuery('q')).length).toBe(64);
    expect(urls).toHaveLength(1);
    expect(() =>
      makeEvalEmbedder(c, { local: () => new FakeEmbedder(), dashscope: () => new FakeEmbedder() }),
    ).toThrow(/维度 384 != 请求维度 64/);
  });
});
