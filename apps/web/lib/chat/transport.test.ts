import { describe, expect, it, vi } from 'vitest';
import { ChatTransportError, createFetchTransport, type ChatItem } from './transport';

function sseResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}
async function drain(it: AsyncIterable<ChatItem>) {
  const out: ChatItem[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('createFetchTransport', () => {
  it('POST /api/repos/:id/chat,请求体按 shared ChatRequest;事件过 ChatEventSchema,不合法的标记为 ok:false', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(
        'event: token\ndata: {"text":"hi"}\n\n' +
          'event: citation\ndata: {"id":1,"path":"a.ts","startLine":5,"endLine":2,"nodeId":"f:a.ts"}\n\n' +
          'event: reset\ndata: {}\n\n' +
          'event: done\ndata: {"messageId":1,"droppedCitations":0,"retrieval":"keyword-only","usage":{"in":1,"out":2}}\n\n',
      ),
    );
    const t = createFetchTransport('http://api', fetchImpl as unknown as typeof fetch);
    const items = await drain(t(7, { message: '问' }, new AbortController().signal));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api/api/repos/7/chat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ message: '问' });
    expect(items.map((i) => (i.ok ? i.event.event : 'invalid'))).toEqual([
      'token',
      'invalid', // endLine < startLine
      'invalid', // 契约里没有 reset 事件
      'done',
    ]);
  });

  it('404 且没有约定错误体 → NOT_AVAILABLE(后端问答 API 未上线)', async () => {
    const t = createFetchTransport('', async () => new Response('Not Found', { status: 404 }));
    await expect(drain(t(1, { message: 'q' }, new AbortController().signal))).rejects.toMatchObject(
      {
        info: { code: 'NOT_AVAILABLE', retryable: false },
      },
    );
  });

  it('429 ApiError → RATE_LIMITED 可重试;fetch 抛错 → NETWORK', async () => {
    const t = createFetchTransport(
      '',
      async () =>
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow' } }), {
          status: 429,
        }),
    );
    const e = await drain(t(1, { message: 'q' }, new AbortController().signal)).catch((x) => x);
    expect(e).toBeInstanceOf(ChatTransportError);
    expect(e.info).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    const n = createFetchTransport('', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(drain(n(1, { message: 'q' }, new AbortController().signal))).rejects.toMatchObject(
      { info: { code: 'NETWORK', retryable: true } },
    );
  });

  it('已 abort 时 fetch 抛 AbortError 不当作错误', async () => {
    const ac = new AbortController();
    ac.abort();
    const t = createFetchTransport('', async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    expect(await drain(t(1, { message: 'q' }, ac.signal))).toEqual([]);
  });
});
