import { estimateUsage } from './estimate.js';
import type { LlmCall, LlmCallResult, LlmClient, LlmStreamEvent, LlmUsage } from './types.js';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

/** 流式专有的失败(超时 / 坏 SSE / 断流 / 流内 error);由网关包成 LLM_UNAVAILABLE */
export class LlmStreamError extends Error {
  constructor(
    readonly reason:
      'first-chunk-timeout' | 'idle-timeout' | 'bad-sse' | 'upstream-error' | 'ended-early',
    message: string,
  ) {
    super(message);
    this.name = 'LlmStreamError';
  }
}

/** 首包 / 相邻 chunk 空闲超时默认值 */
export const DEEPSEEK_STREAM_IDLE_DEFAULT_MS = 20_000;
const TOTAL_DEFAULT_MS = 60_000;

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
}
interface StreamChunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: RawUsage | null;
  error?: { message?: string };
}

const mapUsage = (u: RawUsage | null | undefined): LlmUsage | null =>
  u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number'
    ? {
        tokensIn: u.prompt_tokens,
        tokensOut: u.completion_tokens,
        cachedTokensIn: u.prompt_cache_hit_tokens ?? 0,
      }
    : null;

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/**
 * DeepSeek OpenAI 兼容客户端:POST {baseUrl}/chat/completions(非流式)。
 * 文档:https://api-docs.deepseek.com/api/create-chat-completion
 * - 关闭思考模式(reasoning_effort: none),摘要类任务不需要,省 token。
 * - json=true 时开启 response_format json_object(调用方的 prompt 必须要求 JSON,见文档)。
 * - usage 取响应字段:prompt_tokens(= 命中 + 未命中)、completion_tokens、prompt_cache_hit_tokens。
 * - 不在本层重试;重试、熔断、降级由 BreakerClient / 网关 / 调用方负责。
 * - key 只放在请求头;错误信息只含状态码与响应里的 error.message,不含请求头。
 */
export class DeepSeekClient implements LlmClient {
  readonly provider = 'deepseek';
  readonly #apiKey: string;
  constructor(
    apiKey: string,
    private readonly o: {
      baseUrl?: string;
      /** 单次调用总时限(call 与 stream 共用),默认 60s */
      timeoutMs?: number;
      /** stream:发请求到第一个 data 事件的最长等待,默认 20s */
      firstChunkTimeoutMs?: number;
      /** stream:相邻两个 data 事件之间的最长空闲,默认 20s */
      idleTimeoutMs?: number;
      fetch?: typeof fetch;
    } = {},
  ) {
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY 未设置');
    this.#apiKey = apiKey;
  }

  private body(req: LlmCall, stream: boolean) {
    return {
      model: req.model,
      messages: req.messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      reasoning_effort: 'none',
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
    };
  }

  private post(req: LlmCall, stream: boolean, signal: AbortSignal) {
    const base = (this.o.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');
    return (this.o.fetch ?? fetch)(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify(this.body(req, stream)),
      signal,
    });
  }

  /** 服务端报错文案可能回显请求头;先抹掉 key 再截断,原始响应体不进错误信息 */
  private redact(msg: string) {
    return msg.split(this.#apiKey).join('***').slice(0, 200);
  }

  private httpError(status: number, raw: string) {
    let msg = '';
    try {
      msg = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? '';
    } catch {
      /* 非 JSON 响应 */
    }
    msg = this.redact(msg);
    return new LlmHttpError(status, `DeepSeek HTTP ${status}${msg ? `: ${msg}` : ''}`);
  }

  async call(req: LlmCall): Promise<LlmCallResult> {
    const total = AbortSignal.timeout(this.o.timeoutMs ?? TOTAL_DEFAULT_MS);
    // 客户端自身超时 + 调用方取消(摘要单文件超时等),任一触发即中止请求
    const res = await this.post(
      req,
      false,
      req.signal ? AbortSignal.any([req.signal, total]) : total,
    );
    const raw = await res.text();
    if (!res.ok) throw this.httpError(res.status, raw);
    let data: ChatResponse;
    try {
      data = JSON.parse(raw) as ChatResponse;
    } catch {
      throw new LlmHttpError(res.status, 'DeepSeek 响应不是 JSON');
    }
    const text = data.choices?.[0]?.message?.content;
    const u = data.usage;
    if (
      typeof text !== 'string' ||
      !u ||
      typeof u.prompt_tokens !== 'number' ||
      typeof u.completion_tokens !== 'number'
    )
      throw new LlmHttpError(res.status, 'DeepSeek 响应缺少 choices[0].message.content 或 usage');
    return {
      text,
      usage: {
        tokensIn: u.prompt_tokens,
        tokensOut: u.completion_tokens,
        cachedTokensIn: u.prompt_cache_hit_tokens ?? 0,
      },
    };
  }

  /**
   * 流式:POST stream:true + stream_options.include_usage:true,解析 SSE。
   * - 只把 `delta.content` 作为 text 事件发出;`reasoning_content`(思考内容)不发、不计入正文。
   * - 用量取 include_usage 的最后一个 chunk(`choices: []` + `usage`),在 `[DONE]` 时作为最后一个事件发出。
   *   没收到 usage 就 `[DONE]`:
   *   - 收到过 `finish_reason: "stop"`(且有 [DONE]):按字数上界估算 usage(estimateUsage,公式见 estimate.ts),
   *     usage 事件带 `estimated: true`;
   *   - 没有 stop(只有 `length`、或没有任何 finish_reason):不发 usage 事件,
   *     由网关按「没给 usage 就结束」记 ok=0、报 LLM_UNAVAILABLE。缺 [DONE] 见下方 ended-early。
   * - `finish_reason: "length"`:正文到此为止,usage 事件带 `truncated: true` 向上报告(不静默截断)。
   * - 格式错误的 SSE 行:`data:` 内容不是 JSON(且不是 `[DONE]`)时抛 LlmStreamError('bad-sse'),
   *   网关包成 LLM_UNAVAILABLE;注释行(`: keep-alive`)和 `event:`/`id:`/`retry:` 等非 data 字段按 SSE 规范忽略。
   *   流内 `{"error":{...}}` 抛 LlmStreamError('upstream-error')(文案先抹 key)。
   * - 跨 chunk 的半行:按字节流解码后按行缓冲,行和事件(空行分隔)可以任意切分。
   * - 没有 `[DONE]` 就 EOF:抛 LlmStreamError('ended-early')。
   * - 超时:总时限 timeoutMs(默认 60s,与 call 一致);首个 data 事件 firstChunkTimeoutMs、
   *   相邻 data 事件 idleTimeoutMs(默认都 20s)。注释行(keep-alive)不算 data,不重置这两个计时。
   * - 取消:req.signal / 超时任一触发即 abort fetch(关闭上游连接);生成器退出(正常、出错、调用方 return)
   *   时都会 cancel reader 并 abort,不留上游连接。
   */
  async *stream(req: LlmCall): AsyncGenerator<LlmStreamEvent> {
    const own = new AbortController();
    const total = AbortSignal.timeout(this.o.timeoutMs ?? TOTAL_DEFAULT_MS);
    const signal = AbortSignal.any(
      req.signal ? [req.signal, total, own.signal] : [total, own.signal],
    );
    const firstMs = this.o.firstChunkTimeoutMs ?? DEEPSEEK_STREAM_IDLE_DEFAULT_MS;
    const idleMs = this.o.idleTimeoutMs ?? DEEPSEEK_STREAM_IDLE_DEFAULT_MS;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gotData = false;
    // 计时器到点:abort 整个请求,挂起的 read() 随之以 own.signal.reason 失败
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          own.abort(
            gotData
              ? new LlmStreamError('idle-timeout', `DeepSeek 流空闲超过 ${idleMs}ms`)
              : new LlmStreamError('first-chunk-timeout', `DeepSeek 首包超过 ${firstMs}ms`),
          ),
        gotData ? idleMs : firstMs,
      );
    };
    // 被 abort 时把原因统一抛出(fetch / read 抛的 AbortError 不带具体原因)
    const reasonOr = (err: unknown) => (signal.aborted ? (signal.reason ?? err) : err);
    try {
      arm();
      let res: Response;
      try {
        res = await this.post(req, true, signal);
      } catch (err) {
        throw reasonOr(err);
      }
      if (!res.ok) {
        let raw = '';
        try {
          raw = await res.text();
        } catch {
          /* 读错误体失败:只报状态码 */
        }
        throw this.httpError(res.status, raw);
      }
      if (!res.body) throw new LlmStreamError('ended-early', 'DeepSeek 流式响应没有 body');
      reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let data: string[] = [];
      let usage: LlmUsage | null = null;
      let truncated = false;
      let stopped = false;
      let full = '';
      // 处理一个完整事件的 data;返回 true 表示收到 [DONE]
      const onEvent = function* (
        this: DeepSeekClient,
        payload: string,
      ): Generator<LlmStreamEvent, boolean> {
        if (payload === '[DONE]') {
          if (usage) yield { type: 'usage', usage, ...(truncated ? { truncated: true } : {}) };
          else if (stopped)
            yield { type: 'usage', usage: estimateUsage(req.messages, full), estimated: true };
          return true;
        }
        let c: StreamChunk;
        try {
          c = JSON.parse(payload) as StreamChunk;
        } catch {
          throw new LlmStreamError('bad-sse', 'DeepSeek 流中有无法解析的 data 行');
        }
        if (!c || typeof c !== 'object')
          throw new LlmStreamError('bad-sse', 'DeepSeek 流中有无法解析的 data 行');
        if (c.error) {
          const m = this.redact(c.error.message ?? '');
          throw new LlmStreamError('upstream-error', `DeepSeek 流内错误${m ? `: ${m}` : ''}`);
        }
        const ch = c.choices?.[0];
        const t = ch?.delta?.content;
        if (typeof t === 'string' && t) {
          full += t;
          yield { type: 'text', text: t };
        }
        if (ch?.finish_reason === 'length') truncated = true;
        if (ch?.finish_reason === 'stop') stopped = true;
        const u = mapUsage(c.usage);
        if (u) usage = u;
        return false;
      };
      for (;;) {
        let r: ReadableStreamReadResult<Uint8Array>;
        try {
          r = await reader.read();
        } catch (err) {
          throw reasonOr(err);
        }
        if (signal.aborted) throw signal.reason;
        // EOF 时补一个空行:最后一个事件后没有空行也照常处理
        buf += r.done ? `${dec.decode()}\n\n` : dec.decode(r.value, { stream: true });
        let nl: number;
        while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + (buf.startsWith('\r\n', nl) ? 2 : 1));
          if (line === '') {
            if (data.length === 0) continue;
            const payload = data.join('\n');
            data = [];
            gotData = true;
            arm();
            if (yield* onEvent.call(this, payload)) return;
            continue;
          }
          if (line.startsWith(':')) continue;
          const i = line.indexOf(':');
          const field = i < 0 ? line : line.slice(0, i);
          if (field !== 'data') continue;
          let v = i < 0 ? '' : line.slice(i + 1);
          if (v.startsWith(' ')) v = v.slice(1);
          data.push(v);
        }
        if (r.done) {
          throw new LlmStreamError('ended-early', 'DeepSeek 流在 [DONE] 之前结束');
        }
      }
    } finally {
      clearTimeout(timer);
      if (reader) void reader.cancel().catch(() => {});
      own.abort();
    }
  }
}
