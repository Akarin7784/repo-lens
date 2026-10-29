import hono from '../../fixtures/hono.sample.graph.json';
import zustand from '../../fixtures/zustand.sample.graph.json';

/**
 * 示例数据(手写 fixture,见 fixtures/README.md),**只用于单元/组件测试**,页面不再引用。
 * 线上图页一律走真实接口(lib/api/client.ts)。
 */
export const SAMPLE_REPOS = {
  hono: {
    owner: 'honojs',
    repo: 'hono',
    blurb: '主演示:中等规模的 Web 框架',
    data: hono as unknown,
  },
  zustand: { owner: 'pmndrs', repo: 'zustand', blurb: '小规模:快速出图', data: zustand as unknown },
} as const;

export type SampleId = keyof typeof SAMPLE_REPOS;
export const isSampleId = (id: string): id is SampleId => Object.hasOwn(SAMPLE_REPOS, id);
