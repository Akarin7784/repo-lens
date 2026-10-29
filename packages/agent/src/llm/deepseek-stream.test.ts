import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '@repolens/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLlmConfig } from './config.js';
import { DeepSeekClient, LlmStreamError } from './deepseek.js';
import { LlmGateway } from './gateway.js';
import { MemoryLlmKv } from './memory-kv.js';
import { estimateTextTokens, estimateUsage } from './estimate.js';
import { DEFAULT_PRICES, costMicroUsd } from './pricing.js';
import { LlmError, type LlmCall, type LlmStreamEvent } from './types.js';

// 本地假 DeepSeek SSE 服务:只监听 127.0.0.1 随机端口,不访问真实接口,key 是假的
const KEY = 'sk-test-not-a-real-key-456';
type Handler = (rq: IncomingMessage, rs: ServerResponse) => void | Promise<void>;
let server: Server;
let base: string;
let handler: Handler;
/** 最近一次请求;closedEarly:响应写完之前连接被客户端关闭(abort 是否真正关闭上游) */
let last: { body?: Record<string, unknown>; auth?: string; closedEarly?: boolean } = {};
const readBody = (r: IncomingMessage) =>
  new Promise<string>((ok) => {
    let s = '';
    r.on('data', (c) => (s += c));
    r.on('end', () => ok(s));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  server = createServer(async (rq, rs) => {
    const me: typeof last = {
      auth: rq.headers.authorization,
      body: JSON.parse(await readBody(rq)),
      closedEarly: false,
    };
    last = me;
    rs.on('close', () => {
      if (!rs.writableEnded) me.closedEarly = true;
    });
    await handler(rq, rs);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((ok) => server.close(() => ok()));
});
beforeEach(() => {
  last = {};
});

const sse = (rs: ServerResponse) =>
  rs.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
const chunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (content: string, extra: object = {}) =>
  chunk({ choices: [{ index: 0, delta: { content }, finish_reason: null }], ...extra });
const usageChunk = (
  u = { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 600 },
) => chunk({ choices: [], usage: u });
const finish = (reason: string) =>
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const DONE = 'data: [DONE]\n\n';
/** 按给定片段依次写出(模拟任意 TCP 切分),最后 end */
const script =
  (parts: string[], o: { gapMs?: number; end?: boolean } = {}): Handler =>
  async (_rq, rs) => {
    sse(rs);
    for (const p of parts) {
      rs.write(p);
      if (o.gapMs) await sleep(o.gapMs);
    }
    if (o.end !== false) rs.end();
  };

const call = (extra: Partial<LlmCall> = {}): LlmCall => ({
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});
// 默认 2s:冷启动的第一个请求(建连 + JIT)在 CI 上可超过 300ms;测超时的用例各自传更小的值
const client = (o: ConstructorParameters<typeof DeepSeekClient>[1] = {}) =>
  new DeepSeekClient(KEY, { baseUrl: base, firstChunkTimeoutMs: 2000, idleTimeoutMs: 2000, ...o });
async function collect(it: AsyncIterable<LlmStreamEvent>) {
  const evs: LlmStreamEvent[] = [];
  for await (const e of it) evs.push(e);
  return evs;
}
async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('应当失败');
}
const texts = (evs: LlmStreamEvent[]) =>
  evs.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');

describe('DeepSeekClient.stream(本地假 SSE 服务)', () => {
  it('正常流:stream + include_usage 请求体;只发 content;[DONE] 时发最后一个 chunk 的 usage', async () => {
    handler = script([
      delta('你好'),
      delta(','),
      delta('世界'),
      finish('stop'),
      usageChunk(),
      DONE,
    ]);
    const evs = await collect(client().stream(call({ maxTokens: 64, temperature: 0 })));
    expect(last.auth).toBe(`Bearer ${KEY}`);
    expect(last.body).toMatchObject({
      model: 'deepseek-flash',
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'none',
      max_tokens: 64,
      temperature: 0,
    });
    expect(texts(evs)).toBe('你好,世界');
    expect(evs.at(-1)).toEqual({
      type: 'usage',
      usage: { tokensIn: 1000, tokensOut: 200, cachedTokensIn: 600 },
    });
    expect(evs.filter((e) => e.type === 'usage')).toHaveLength(1);
  });

  it('[DONE] 之后的内容不再读取,上游连接被关闭', async () => {
    handler = script([delta('a'), usageChunk(), DONE, delta('不该出现')], { end: false });
    const evs = await collect(client().stream(call()));
    expect(texts(evs)).toBe('a');
    await sleep(50);
    expect(last.closedEarly).toBe(true);
  });

  it('reasoning_content 不当作 token 发出', async () => {
    handler = script([
      chunk({ choices: [{ index: 0, delta: { reasoning_content: '先想一想' } }] }),
      chunk({ choices: [{ index: 0, delta: { content: null, reasoning_content: '再想' } }] }),
      delta('答案'),
      usageChunk(),
      DONE,
    ]);
    const evs = await collect(client().stream(call()));
    expect(evs.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: '答案' }]);
  });

  it('finish_reason:length → usage 事件带 truncated:true 向上报告', async () => {
    handler = script([delta('写到一半'), finish('length'), usageChunk(), DONE]);
    const evs = await collect(client().stream(call()));
    expect(evs.at(-1)).toMatchObject({ type: 'usage', truncated: true });
    handler = script([delta('完整'), finish('stop'), usageChunk(), DONE]);
    expect((await collect(client().stream(call()))).at(-1)).not.toHaveProperty('truncated');
  });

  it('半行 / 半个事件 / 多字节字符跨 chunk 切分都能拼回', async () => {
    const whole = [delta('中文'), delta('拼接'), usageChunk(), DONE].join('');
    const bytes = Buffer.from(whole);
    // 每 3 字节切一刀:必然切在 UTF-8 多字节字符中间和 "data:" 前缀中间
    const parts: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 3) parts.push(bytes.subarray(i, i + 3));
    handler = async (_rq, rs) => {
      sse(rs);
      for (const p of parts) {
        rs.write(p);
        await sleep(1);
      }
      rs.end();
    };
    const evs = await collect(client().stream(call()));
    expect(texts(evs)).toBe('中文拼接');
    expect(evs.at(-1)?.type).toBe('usage');
  });

  it('CRLF 行尾、无空格的 data:、注释行与 event:/id: 字段按 SSE 规范处理', async () => {
    handler = script([
      ': keep-alive\r\n\r\n',
      'id: 1\r\nevent: message\r\n',
      `data:${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\r\n\r\n`,
      usageChunk().replace(/\n/g, '\r\n'),
      'data: [DONE]',
    ]);
    const evs = await collect(client().stream(call()));
    expect(texts(evs)).toBe('x');
    expect(evs.at(-1)?.type).toBe('usage');
  });

  it('坏 SSE 行(data 不是 JSON):抛 LlmStreamError(bad-sse),已发正文不收回', async () => {
    handler = script([delta('前半'), 'data: {not json\n\n', usageChunk(), DONE]);
    const got: LlmStreamEvent[] = [];
    const err = await failure(
      (async () => {
        for await (const e of client().stream(call())) got.push(e);
      })(),
    );
    expect(err).toBeInstanceOf(LlmStreamError);
    expect((err as LlmStreamError).reason).toBe('bad-sse');
    expect(texts(got)).toBe('前半');
  });

  it('流内 error 对象:抛 upstream-error,文案里的 key 被抹掉', async () => {
    handler = script([chunk({ error: { message: `bad key ${KEY}` } })]);
    const err = await failure(collect(client().stream(call())));
    expect((err as LlmStreamError).reason).toBe('upstream-error');
    expect(err.message).toContain('***');
    expect(err.message).not.toContain(KEY);
  });

  it('非 2xx:LlmHttpError 带状态码,不含 key', async () => {
    handler = (_rq, rs) => {
      rs.writeHead(401, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ error: { message: `Authentication Fails ${KEY}` } }));
    };
    const err = await failure(collect(client().stream(call())));
    expect(err).toMatchObject({ name: 'LlmHttpError', status: 401 });
    expect(err.message).not.toContain(KEY);
  });

  it('中途断流(没有 [DONE] 就 EOF):抛 ended-early', async () => {
    handler = script([delta('a'), delta('b')]);
    const err = await failure(collect(client().stream(call())));
    expect((err as LlmStreamError).reason).toBe('ended-early');
  });

  it('中途断流(连接被重置):抛错,不挂起', async () => {
    handler = async (_rq, rs) => {
      sse(rs);
      rs.write(delta('a'));
      await sleep(20);
      rs.socket?.destroy();
    };
    const err = await failure(collect(client().stream(call())));
    expect(err).toBeInstanceOf(Error);
  });

  it('慢首包:超过 firstChunkTimeoutMs 抛 first-chunk-timeout 并关闭上游;keep-alive 注释不算首包', async () => {
    handler = async (_rq, rs) => {
      sse(rs);
      for (let i = 0; i < 10; i++) {
        if (rs.destroyed) return;
        rs.write(': keep-alive\n\n');
        await sleep(50);
      }
      rs.end(DONE);
    };
    const t0 = Date.now();
    const err = await failure(collect(client({ firstChunkTimeoutMs: 150 }).stream(call())));
    expect((err as LlmStreamError).reason).toBe('first-chunk-timeout');
    expect(Date.now() - t0).toBeLessThan(400);
    await sleep(50);
    expect(last.closedEarly).toBe(true);
  });

  it('响应头都不来也按首包超时', async () => {
    handler = async () => {
      /* 永不响应 */
    };
    const err = await failure(collect(client({ firstChunkTimeoutMs: 100 }).stream(call())));
    expect((err as LlmStreamError).reason).toBe('first-chunk-timeout');
  });

  it('chunk 间空闲:超过 idleTimeoutMs 抛 idle-timeout 并关闭上游', async () => {
    handler = script([delta('a'), delta('b')], { gapMs: 400, end: false });
    const got: string[] = [];
    const err = await failure(
      (async () => {
        for await (const e of client({ idleTimeoutMs: 150 }).stream(call()))
          if (e.type === 'text') got.push(e.text);
      })(),
    );
    expect((err as LlmStreamError).reason).toBe('idle-timeout');
    expect(got).toEqual(['a']);
    await sleep(50);
    expect(last.closedEarly).toBe(true);
  });

  it('总时限 timeoutMs:持续有 data 也会在总时限到达时中止', async () => {
    handler = script(
      Array.from({ length: 50 }, () => delta('.')),
      { gapMs: 20, end: false },
    );
    const t0 = Date.now();
    const err = await failure(collect(client({ timeoutMs: 200 }).stream(call())));
    expect(err.name).toBe('TimeoutError');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('调用方 abort:抛 signal.reason,上游连接被关闭', async () => {
    handler = script(
      Array.from({ length: 50 }, () => delta('.')),
      { gapMs: 20, end: false },
    );
    const ac = new AbortController();
    const reason = new Error('client disconnected');
    const err = await failure(
      (async () => {
        let n = 0;
        for await (const e of client().stream(call({ signal: ac.signal })))
          if (e.type === 'text' && ++n === 2) ac.abort(reason);
      })(),
    );
    expect(err).toBe(reason);
    await sleep(50);
    expect(last.closedEarly).toBe(true);
  });

  it('调用方 it.return()(route 的 finally):cancel reader,上游连接被关闭', async () => {
    handler = script(
      Array.from({ length: 50 }, () => delta('.')),
      { gapMs: 20, end: false },
    );
    const it = client().stream(call());
    expect((await it.next()).value).toEqual({ type: 'text', text: '.' });
    await it.return(undefined);
    await sleep(50);
    expect(last.closedEarly).toBe(true);
  });

  it('错误信息与客户端序列化里都没有 key', async () => {
    const c = client();
    handler = script([delta('a')]);
    const err = await failure(collect(c.stream(call())));
    expect(`${err.message}${err.stack}`).not.toContain(KEY);
    expect(JSON.stringify(c)).not.toContain(KEY);
  });
});

describe('网关 → DeepSeekClient.stream → llm_usage', () => {
  function gw() {
    const warns: { obj: object; msg: string }[] = [];
    const usage = new MemoryStore();
    const g = new LlmGateway({
      client: client(),
      kv: new MemoryLlmKv(),
      usage,
      prices: DEFAULT_PRICES,
      dailyBudgetCents: 500,
      log: { warn: (obj, msg) => warns.push({ obj, msg }) },
    });
    const rows = () =>
      (
        usage as unknown as {
          usage: { ok: boolean; tokensIn: number; tokensOut: number; costMicroUsd: number }[];
        }
      ).usage;
    return { g, rows, warns };
  }
  const greq = { ...call(), purpose: 'chat' as const, repoId: 1, sessionId: 2 };

  it('usage 事件的 token 数写进 llm_usage,花费按真实 usage(含缓存命中)计算', async () => {
    handler = script([delta('ok'), usageChunk(), DONE]);
    const { g, rows } = gw();
    const s = g.stream(greq);
    let r = await s.next();
    while (!r.done) r = await s.next();
    const cost = costMicroUsd(DEFAULT_PRICES['deepseek-flash']!, 1000, 200, 600);
    expect(r.value).toMatchObject({ text: 'ok', costMicroUsd: cost });
    expect(r.value).not.toHaveProperty('truncated');
    expect(rows()).toEqual([
      expect.objectContaining({ ok: true, tokensIn: 1000, tokensOut: 200, costMicroUsd: cost }),
    ]);
  });

  it('length:照常记账,网关返回值带 truncated:true', async () => {
    handler = script([delta('半'), finish('length'), usageChunk(), DONE]);
    const { g, rows } = gw();
    const s = g.stream(greq);
    let r = await s.next();
    while (!r.done) r = await s.next();
    expect(r.value.truncated).toBe(true);
    expect(rows()[0]).toMatchObject({ ok: true, tokensOut: 200 });
  });

  const drain = (s: AsyncGenerator<unknown, unknown>) =>
    (async () => {
      let r = await s.next();
      while (!r.done) r = await s.next();
      return r.value as import('./types.js').LlmResult;
    })();
  const ok0 = expect.objectContaining({ ok: false, tokensIn: 0, tokensOut: 0, costMicroUsd: 0 });

  it('stop + [DONE] 但缺 usage:按字数上界估算,记 ok=1,打 estimated 告警,不报错', async () => {
    handler = script([delta('你好'), delta(' world'), finish('stop'), DONE]);
    const { g, rows, warns } = gw();
    const r = await drain(g.stream(greq));
    // 输入:'hi' 2 字符 + 每条 4 = 6;输出:'你好 world' 8 字符
    expect(estimateUsage(greq.messages, '你好 world')).toEqual({
      tokensIn: 6,
      tokensOut: 8,
      cachedTokensIn: 0,
    });
    const cost = costMicroUsd(DEFAULT_PRICES['deepseek-flash']!, 6, 8, 0);
    expect(r).toMatchObject({ text: '你好 world', usageEstimated: true, costMicroUsd: cost });
    expect(r.usage).toEqual({ tokensIn: 6, tokensOut: 8, cachedTokensIn: 0 });
    expect(rows()).toEqual([
      expect.objectContaining({ ok: true, tokensIn: 6, tokensOut: 8, costMicroUsd: cost }),
    ]);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toContain('estimated');
    expect(warns[0]!.obj).toMatchObject({ estimated: true, sessionId: 2, tokensOut: 8 });
  });

  it('估算是上界:不少于真实 token(中英文、代码)', () => {
    for (const t of ['中文回答一段', 'const x = 1;', 'hello world, plain english'])
      expect(estimateTextTokens(t)).toBeGreaterThanOrEqual(Math.ceil(t.length * 0.6));
    expect(estimateTextTokens('')).toBe(0);
  });

  it('length + 缺 usage:不估算,记 ok=0,抛 LLM_UNAVAILABLE', async () => {
    handler = script([delta('半'), finish('length'), DONE]);
    const { g, rows, warns } = gw();
    const err = (await failure(drain(g.stream(greq)))) as LlmError;
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(rows()).toEqual([ok0]);
    expect(warns).toEqual([]);
  });

  it('没有任何 finish_reason + 缺 usage:记 ok=0,抛 LLM_UNAVAILABLE', async () => {
    handler = script([delta('ok'), DONE]);
    const { g, rows } = gw();
    const err = (await failure(drain(g.stream(greq)))) as LlmError;
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect(rows()).toEqual([ok0]);
  });

  it('stop 但缺 [DONE](EOF):不估算,记 ok=0,cause 为 ended-early', async () => {
    handler = script([delta('ok'), finish('stop')]);
    const { g, rows } = gw();
    const err = (await failure(drain(g.stream(greq)))) as LlmError;
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect((err.cause as LlmStreamError).reason).toBe('ended-early');
    expect(rows()).toEqual([ok0]);
  });

  it('调用方在 yield 处 it.return():补记恰好一行 ok=0,上游连接被关闭', async () => {
    handler = script(
      Array.from({ length: 50 }, () => delta('.')),
      { gapMs: 20, end: false },
    );
    const { g, rows } = gw();
    const s = g.stream(greq);
    expect((await s.next()).value).toEqual({ text: '.' });
    await s.return(undefined as never);
    expect(rows()).toEqual([ok0]);
    await vi.waitFor(() => expect(last.closedEarly).toBe(true));
    // 再次 return / next 不会再写
    await s.return(undefined as never);
    expect((await s.next()).done).toBe(true);
    expect(rows()).toHaveLength(1);
  });

  it('正常结束且已记账后再 it.return():不追加第二行', async () => {
    handler = script([delta('ok'), usageChunk(), DONE]);
    const { g, rows } = gw();
    const s = g.stream(greq);
    await drain(s);
    await s.return(undefined as never);
    expect(rows()).toEqual([expect.objectContaining({ ok: true, tokensIn: 1000 })]);
  });

  it('失败已记 ok=0 后再 it.return():不追加第二行', async () => {
    handler = script([delta('ok'), DONE]);
    const { g, rows } = gw();
    const s = g.stream(greq);
    await failure(drain(s));
    await s.return(undefined as never);
    expect(rows()).toEqual([ok0]);
  });

  it('坏 SSE 行在网关层是 LLM_UNAVAILABLE(cause 为 bad-sse)', async () => {
    handler = script(['data: nope\n\n']);
    const { g } = gw();
    const err = (await failure(
      (async () => {
        for await (const _ of g.stream(greq)) void _;
      })(),
    )) as LlmError;
    expect(err.code).toBe('LLM_UNAVAILABLE');
    expect((err.cause as LlmStreamError).reason).toBe('bad-sse');
  });
});

describe('readLlmConfig:流式超时变量', () => {
  it('默认 20000;可配置', () => {
    expect(readLlmConfig({})).toMatchObject({
      streamFirstChunkTimeoutMs: 20_000,
      streamIdleTimeoutMs: 20_000,
    });
    expect(
      readLlmConfig({
        DEEPSEEK_STREAM_FIRST_CHUNK_TIMEOUT_MS: '5000',
        DEEPSEEK_STREAM_IDLE_TIMEOUT_MS: '8000',
      }),
    ).toMatchObject({ streamFirstChunkTimeoutMs: 5000, streamIdleTimeoutMs: 8000 });
  });
  it.each(['0', '-1', 'abc', '1.5', '60001'])('非法值 %s 启动即报错(fake 下也校验)', (v) => {
    expect(() => readLlmConfig({ DEEPSEEK_STREAM_IDLE_TIMEOUT_MS: v })).toThrow(
      /DEEPSEEK_STREAM_IDLE_TIMEOUT_MS/,
    );
    expect(() => readLlmConfig({ DEEPSEEK_STREAM_FIRST_CHUNK_TIMEOUT_MS: v })).toThrow(
      /DEEPSEEK_STREAM_FIRST_CHUNK_TIMEOUT_MS/,
    );
  });
});
