import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '@repolens/shared';
import { buildApp } from './app.js';

describe('GET /health', () => {
  it('返回 ok', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(res.json()).status).toBe('ok');
    await app.close();
  });
});
