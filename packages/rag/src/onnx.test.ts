import { describe, expect, it } from 'vitest';
import { OnnxEmbedder } from './embedder.js';

// 真实模型测试:需本地已下载模型目录(镜像构建时下载)。CI 不设该变量,跳过。
const dir = process.env.RAG_ONNX_MODEL_DIR;

describe.skipIf(!dir)('OnnxEmbedder(本地 e5 fp32)', () => {
  it('384 维、归一化,中文查询更接近相关英文代码', async () => {
    const e = new OnnxEmbedder('Xenova/multilingual-e5-small', dir!);
    const q = await e.embedQuery('跨域请求怎么配置?');
    const [cors, gzip] = await e.embedDocuments([
      'src/middleware/cors/index.ts cors\nexport const cors = (options) => { Access-Control-Allow-Origin }',
      'src/middleware/compress/index.ts compress\nexport const compress = () => { gzip deflate }',
    ]);
    expect(q).toHaveLength(384);
    expect(Math.hypot(...q)).toBeCloseTo(1, 4);
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    expect(dot(q, cors!)).toBeGreaterThan(dot(q, gzip!));
  }, 120_000);
});
