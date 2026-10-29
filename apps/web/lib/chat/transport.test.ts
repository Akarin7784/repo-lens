import { describe, expect, it, vi } from 'vitest';
import {
  buildChatRequest,
  ChatTransportError,
  createFetchTransport,
  stripCitationMarkers,
  type ChatItem,
} from './transport';

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

describe('buildChatRequest(请求体唯一构造点)', () => {
  it('字段名 message;trim;空或超过 2000 字返回 null;contextNodeIds 最多 20 个', () => {
    expect(buildChatRequest('  问  ')).toEqual({ message: '问' });
    expect(buildChatRequest('   ')).toBeNull();
    expect(buildChatRequest('x'.repeat(2000))?.message).toHaveLength(2000);
    expect(buildChatRequest('x'.repeat(2001))).toBeNull();
    const ids = Array.from({ length: 25 }, (_, i) => `f:src/a${i}.ts`);
    expect(buildChatRequest('q', ids)?.contextNodeIds).toHaveLength(20);
    expect(buildChatRequest('q', [])).toEqual({ message: 'q' });
  });
});

describe('stripCitationMarkers', () => {
  it('去掉 [[Sn:a-b]] 原始标记;流式时隐藏未闭合尾巴,结束后保留普通方括号', () => {
    expect(stripCitationMarkers('见 [[S1:10-20]] 与[[S12:3-3]]。', false)).toBe('见  与。');
    expect(stripCitationMarkers('见 [[S1:1', true)).toBe('见 ');
    expect(stripCitationMarkers('数组 a[0]', true)).toBe('数组 a[0]');
    expect(stripCitationMarkers('末尾 [', false)).toBe('末尾 [');
  });
});
