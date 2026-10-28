import Fastify, { type FastifyInstance } from 'fastify';
import type { HealthResponse } from '@repolens/shared';

/** 构建 Fastify 实例(不监听端口,便于测试用 inject)。业务路由在 T-003 加入。 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'api',
    time: new Date().toISOString(),
  }));
  return app;
}
