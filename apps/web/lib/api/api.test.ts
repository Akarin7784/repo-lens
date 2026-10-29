import { describe, expect, it, vi } from 'vitest';
import { API_ERROR_CODES } from '@repolens/shared';
import { createApiClient } from './client';
import { ApiRequestError, ERROR_TEXT, looseError, toApiError, userMessageOf } from './errors';
import { initialJobProgress, jobProgressReducer, subscribeJobEvents } from './jobEvents';
import { FakeES } from '../../test/fakeEventSource';

const SHA = '382d29c485e67018c06e75ec7235130d0968522c';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const graph = (parentId: string | null) => ({
  nodes: [{ id: 'm:src', type: 'module', parentId: null, label: 'src', path: 'src' }],
  edges: [],
  meta: { repoId: 1, commitSha: SHA, parentId, language: 'typescript' },
});

describe('createApiClient', () => {
  it('图接口只带 parentId,不带任何多余参数(后端对未知参数返回 400)', async () => {
    const f = vi.fn(async () => json(200, graph('m:src/middleware')));
    const api = createApiClient('http://api:4000', f as unknown as typeof fetch);
    await api.getGraph(1, null);
    await api.getGraph(1, 'm:src/middleware');
    const urls = f.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls).toEqual([
      'http://api:4000/api/repos/1/graph',
      'http://api:4000/api/repos/1/graph?parentId=m%3Asrc%2Fmiddleware',
    ]);
  });

  it('读取 x-graph-truncated 响应头', async () => {
    const f = vi.fn(async () => {
      const r = json(200, graph('d:src/middleware'));
      r.headers.set('x-graph-truncated', 'true');
      return r;
    });
    const api = createApiClient('', f as unknown as typeof fetch);
    expect((await api.getGraph(2, 'd:src/middleware')).truncated).toBe(true);
    const g = vi.fn(async () => json(200, graph(null)));
    expect(
      (await createApiClient('', g as unknown as typeof fetch).getGraph(2, null)).truncated,
    ).toBe(false);
  });

  it('POST /api/repos:请求体与响应都按 shared schema', async () => {
    const res = {
      repoId: 1,
      jobId: `1:${SHA}`,
      status: 'queued',
      repo: 'pmndrs/zustand',
      commitSha: SHA,
    };
    const f = vi.fn(async () => json(202, res));
    const api = createApiClient('', f as unknown as typeof fetch);
    await expect(api.createRepo({ repoUrl: 'https://github.com/pmndrs/zustand' })).resolves.toEqual(
      res,
    );
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/repos');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ repoUrl: 'https://github.com/pmndrs/zustand' });
  });

  it('2xx 但不符合 GraphDataSchema → INVALID_RESPONSE', async () => {
    const bad = { ...graph(null), meta: { ...graph(null).meta, commitSha: 'x' } };
    const api = createApiClient('', (async () => json(200, bad)) as unknown as typeof fetch);
    await expect(api.getGraph(1, null)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('非 2xx 按 ApiErrorSchema 取错误码(含 BAD_REQUEST)', async () => {
    const api = createApiClient('', (async () =>
      json(400, {
        error: { code: 'BAD_REQUEST', message: 'repo id 非法' },
      })) as unknown as typeof fetch);
    const e = await api.getRepoStatus(1).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiRequestError);
    expect((e as ApiRequestError).code).toBe('BAD_REQUEST');
    expect((e as ApiRequestError).userMessage).toBe('请求参数不合法。(repo id 非法)');
  });

  it('网络错误 → NETWORK 提示', async () => {
    const api = createApiClient('', (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    const e = await api.getGraph(1, null).catch((x: unknown) => x);
    expect((e as ApiRequestError).code).toBe('NETWORK');
    expect(userMessageOf(e)).toContain('无法连接分析服务');
  });

  it('jobEventsUrl 编码 jobId', () => {
    expect(createApiClient('http://a').jobEventsUrl(`1:${SHA}`)).toBe(
      `http://a/api/jobs/1%3A${SHA}/events`,
    );
  });
});

describe('错误码中文提示', () => {
  it('覆盖 shared 的全部错误码', () => {
    for (const c of API_ERROR_CODES) expect(ERROR_TEXT[c]).toMatch(/[\u4e00-\u9fa5]/);
  });
  it('响应体不合法时按状态码归类', () => {
    expect(toApiError(502, null).code).toBe('INTERNAL');
    expect(toApiError(418, { nope: 1 }).code).toBe('INVALID_RESPONSE');
  });
});

describe('jobProgressReducer', () => {
  const jobId = `1:${SHA}`;
  it('progress 只前进;graph_ready、stage_error、done 各自生效', () => {
    let s = jobProgressReducer(initialJobProgress, {
      event: 'progress',
      data: { jobId, stage: 'parsing', progress: 40, message: '解析 10/18 文件' },
    });
    s = jobProgressReducer(s, {
      event: 'progress',
      data: { jobId, stage: 'cloning', progress: 5 },
    });
    expect(s).toMatchObject({ stage: 'parsing', progress: 40, message: '解析 10/18 文件' });
    s = jobProgressReducer(s, {
      event: 'graph_ready',
      data: { jobId, repoId: 1, graphUrl: '/api/repos/1/graph' },
    });
    expect(s).toMatchObject({ graphReady: true, stage: 'graph_ready' });
    s = jobProgressReducer(s, { event: 'done', data: { jobId, status: 'done' } });
    expect(s).toMatchObject({ status: 'done', stage: 'done', progress: 100 });
  });
  it('stage_error + done(failed)', () => {
    let s = jobProgressReducer(initialJobProgress, {
      event: 'stage_error',
      data: { jobId, stage: 'cloning', message: 'clone 超时' },
    });
    s = jobProgressReducer(s, { event: 'done', data: { jobId, status: 'failed' } });
    expect(s).toMatchObject({
      status: 'failed',
      stageError: { stage: 'cloning', message: 'clone 超时' },
    });
  });
});

describe('subscribeJobEvents', () => {
  it('按 JobEventSchema 校验,丢弃非法事件,done 后关闭', () => {
    const events: string[] = [];
    const invalid: string[] = [];
    let errs = 0;
    subscribeJobEvents(
      '/api/jobs/x/events',
      {
        onEvent: (e) => events.push(e.event),
        onInvalid: (r) => invalid.push(r),
        onConnectionError: () => errs++,
      },
      (u) => new FakeES(u),
    );
    const es = FakeES.last!;
    es.emit('progress', { jobId: 'x', stage: 'cloning', progress: 3 });
    es.emit('progress', { jobId: 'x', stage: 'nope', progress: 3 });
    es.emit('progress', 'not json');
    es.onerror?.(new Event('error'));
    es.emit('done', { jobId: 'x', status: 'done' });
    es.onerror?.(new Event('error'));
    expect(events).toEqual(['progress', 'done']);
    expect(invalid).toHaveLength(2);
    expect(errs).toBe(1);
    expect(es.closed).toBe(true);
  });
});

describe('looseError:details.retryAfterSec 边界(T-236)', () => {
  const parse = (retryAfterSec: unknown) =>
    looseError({
      error: {
        code: 'RATE_LIMITED',
        message: 'x',
        details: { reason: 'rate_limit', retryAfterSec },
      },
    });
  it.each([
    ['0', 0],
    ['负数', -5],
    ['小数 1.5', 1.5],
    ['字符串 "30"', '30'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('%s → undefined(不当成合法秒数)', (_n, v) => {
    const e = parse(v);
    expect(e).not.toBeNull();
    expect(e!.reason).toBe('rate_limit');
    expect(e!.retryAfterSec).toBeUndefined();
  });
  it('正整数 30 → 30(对照)', () => {
    expect(parse(30)!.retryAfterSec).toBe(30);
  });
});
