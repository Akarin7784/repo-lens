import type { ChatEvent } from '@repolens/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeTransport, DEMO_SCRIPT, type FakeStep } from '../../dev/fakeChatStream';
import { createFetchTransport } from '../../lib/chat/transport';
import { PROVIDER_DISCLOSURE } from '../../lib/privacy/disclosure';
import { ChatPanel, CLIENT_TIMEOUT_MS } from './ChatPanel';

function ask(q = '【假数据】示例问题') {
  fireEvent.change(screen.getByRole('textbox', { name: '提问' }), { target: { value: q } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
}
const lastAnswer = () => screen.getAllByTestId('answer').at(-1)!;
const errorOf = (code: string, retryable: boolean): FakeStep =>
  ({
    event: 'error',
    data: { code, message: 'x', retryable },
  }) as ChatEvent;

afterEach(() => vi.useRealTimers());

describe('<ChatPanel> 数据流披露(T-234)', () => {
  it.each([
    ['dashscope', PROVIDER_DISCLOSURE.dashscope],
    ['local', PROVIDER_DISCLOSURE.local],
  ] as const)('embeddingProvider=%s → 对应文案', (p, text) => {
    render(<ChatPanel repoId={1} transport={createFakeTransport([])} embeddingProvider={p} />);
    expect(screen.getByTestId('chat-disclosure')).toHaveTextContent(text);
  });

  it('未传 embeddingProvider → 未知、保守口径(不当 local)', () => {
    render(<ChatPanel repoId={1} transport={createFakeTransport([])} />);
    const el = screen.getByTestId('chat-disclosure');
    expect(el).toHaveTextContent(PROVIDER_DISCLOSURE.unknown);
    expect(el).not.toHaveTextContent('不会发送给第三方向量服务');
    expect(el.className).toContain('text-muted');
  });
});

describe('<ChatPanel>(假流,未接真实后端)', () => {
  it('按事件顺序流式渲染:tool 提示 → token 追加 → 引用角标与卡片 → done 附加提示(含 keyword-only 降级)', async () => {
    render(<ChatPanel repoId={1} transport={createFakeTransport(DEMO_SCRIPT)} />);
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    const a = lastAnswer();
    expect(a).toHaveTextContent('第一处引用 [1],模型原始标记不会显示');
    expect(within(a).getByRole('list', { name: '引用' })).toHaveTextContent(
      'src/db/index.ts:10–48',
    );
    expect(a).toHaveTextContent('已降级为关键词检索');
    expect(a).toHaveTextContent('已过滤 1 条无法校验的引用');
    expect(a.className).toContain('font-sans');
  });

  it('retrieval=hybrid 或缺省时不显示降级提示;fallback=retrieval 显示「未生成回答」', async () => {
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([
          { event: 'token', data: { text: 'ok' } },
          {
            event: 'done',
            data: {
              messageId: 1,
              droppedCitations: 0,
              fallback: 'retrieval',
              usage: { in: 0, out: 0 },
            },
          },
        ])}
      />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(lastAnswer()).not.toHaveTextContent('已降级为关键词检索');
    expect(lastAnswer()).toHaveTextContent('未生成回答');
  });

  it('点击角标或引用卡片回调该引用(由工作区跳到文件预览/图节点)', async () => {
    const onCite = vi.fn();
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport(DEMO_SCRIPT)}
        onCitationClick={onCite}
      />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    fireEvent.click(screen.getByRole('button', { name: '引用 2:src/server/app.ts' }));
    fireEvent.click(screen.getByRole('button', { name: /src\/db\/index\.ts:10–48/ }));
    expect(onCite.mock.calls.map((c) => c[0].nodeId)).toEqual([
      'f:src/server/app.ts',
      'f:src/db/index.ts',
    ]);
  });

  it('XSS:回答里的 HTML 按纯文本显示,不生成元素', async () => {
    const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([
          { event: 'token', data: { text: evil } },
          { event: 'done', data: { messageId: 1, droppedCitations: 0, usage: { in: 0, out: 0 } } },
        ])}
      />,
    );
    ask(evil);
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(lastAnswer()).toHaveTextContent(evil);
    expect(document.querySelector('img, script')).toBeNull();
    expect((window as { __xss?: number }).__xss).toBeUndefined();
  });

  it.each([
    ['LLM_UNAVAILABLE', true, '模型服务暂时不可用'],
    ['REPO_NOT_READY', true, '仓库还在分析中(摘要/索引未完成)'],
  ])('error %s → 文案,retryable 决定重试按钮;重试重新请求', async (code, retryable, text) => {
    let n = 0;
    const transport = createFakeTransport(() =>
      n++ === 0
        ? [{ event: 'token', data: { text: '部分' } }, errorOf(code, retryable)]
        : [
            { event: 'token', data: { text: '好了' } },
            {
              event: 'done',
              data: { messageId: 2, droppedCitations: 0, usage: { in: 0, out: 0 } },
            },
          ],
    );
    render(<ChatPanel repoId={1} transport={transport} />);
    ask();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(text));
    expect(lastAnswer()).toHaveTextContent('部分'); // error 前已输出的内容保留
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(lastAnswer()).toHaveTextContent('好了');
    expect(screen.getAllByTestId('answer')).toHaveLength(1);
  });

  it('BUDGET_EXCEEDED(retryable=false):无重试按钮,输入框禁用并说明原因', async () => {
    render(
      <ChatPanel repoId={1} transport={createFakeTransport([errorOf('BUDGET_EXCEEDED', false)])} />,
    );
    ask();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('今日额度已用完'));
    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
    expect(screen.getByRole('textbox', { name: '提问' })).toBeDisabled();
  });

  it('RATE_LIMITED:重试按钮倒计时 10 秒后才可点', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ChatPanel repoId={1} transport={createFakeTransport([errorOf('RATE_LIMITED', true)])} />,
    );
    ask();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('提问太频繁'));
    expect(screen.getByRole('button', { name: '重试' })).toBeDisabled();
    expect(screen.getByTestId('retry-wait')).toHaveTextContent('10 秒后可再提问');
    // 倒计时是逐秒 setTimeout 链,CI 上 React 提交可能晚于计时推进:多推一秒并等待提交,避免时序抖动
    for (let i = 0; i < 11; i++) await act(async () => void vi.advanceTimersByTime(1000));
    await waitFor(() => expect(screen.getByRole('button', { name: '重试' })).toBeEnabled());
    expect(screen.queryByTestId('retry-wait')).toBeNull();
  });

  it('流在 done 前结束 → 「回答中途断开」可重试,保留已输出 token 与可点引用', async () => {
    render(<ChatPanel repoId={1} transport={createFakeTransport(DEMO_SCRIPT.slice(0, 4))} />);
    ask();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('回答中途断开'));
    // T-234:与 #111 一致,注明已输出内容刷新后不保留
    expect(screen.getByRole('alert')).toHaveTextContent('刷新后不保留');
    expect(lastAnswer()).toHaveTextContent('假流生成的示例回答');
    expect(screen.getByRole('button', { name: /src\/db\/index\.ts:10–48/ })).toBeTruthy();
  });

  it('断流后出现「重试」按钮,点击用同一问题重发', async () => {
    const reqs: unknown[] = [];
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport(DEMO_SCRIPT.slice(0, 4), { onRequest: (r) => reqs.push(r) })}
      />,
    );
    ask('【假数据】示例问题');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('回答中途断开'));
    const retry = screen.getByRole('button', { name: '重试' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(reqs).toHaveLength(2));
    expect(reqs[1]).toEqual(reqs[0]);
    expect(reqs[1]).toMatchObject({ message: '【假数据】示例问题' });
  });

  it('传输层网络错误 → 中断提示与重试', async () => {
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([
          { event: 'token', data: { text: 'a' } },
          { fail: { code: 'NETWORK', message: 'reset', retryable: true } },
        ])}
      />,
    );
    ask();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('网络连接中断'));
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('不合法事件(不符合 shared schema)被丢弃,不影响后续事件', async () => {
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([
          { raw: { event: 'token', data: '{bad json' } },
          { raw: { event: 'token', data: '{"text":1}' } },
          { event: 'token', data: { text: '正常' } },
          { event: 'done', data: { messageId: 1, droppedCitations: 0, usage: { in: 0, out: 0 } } },
        ])}
      />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(lastAnswer().textContent).toContain('正常');
  });

  it('20 秒无 token 且无 done/error → abort 并显示「回答超时,请重试」', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const signals: AbortSignal[] = [];
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([{ hang: true }], { onRequest: (_r, s) => signals.push(s) })}
      />,
    );
    ask();
    expect(screen.getByText('正在思考…')).toBeTruthy();
    await act(async () => void vi.advanceTimersByTime(CLIENT_TIMEOUT_MS + 10));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('回答超时,请重试'));
    expect(signals[0]!.aborted).toBe(true);
  });

  it('切换问题:上一个请求被 abort,其迟到事件不会写进任何回答', async () => {
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const transport = async function* (_id: number, req: { message: string }, signal: AbortSignal) {
      signals.push(signal);
      if (req.message === '第一问') {
        await gate;
        // 不检查 signal,模拟不配合取消的传输:面板自己必须丢弃
        yield { ok: true as const, event: { event: 'token' as const, data: { text: '迟到' } } };
        return;
      }
      yield { ok: true as const, event: { event: 'token' as const, data: { text: '第二答' } } };
      yield {
        ok: true as const,
        event: {
          event: 'done' as const,
          data: { messageId: 2, droppedCitations: 0, usage: { in: 0, out: 0 } },
        },
      };
    };
    render(<ChatPanel repoId={1} transport={transport} />);
    ask('第一问');
    ask('第二问');
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => release());
    const answers = screen.getAllByTestId('answer');
    expect(answers[0]!.dataset.status).toBe('aborted');
    expect(document.body.textContent).not.toContain('迟到');
  });

  it('卸载时取消进行中的请求', () => {
    const signals: AbortSignal[] = [];
    const { unmount } = render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([{ hang: true }], { onRequest: (_r, s) => signals.push(s) })}
      />,
    );
    ask();
    expect(signals[0]!.aborted).toBe(false);
    unmount();
    expect(signals[0]!.aborted).toBe(true);
  });

  it('「停止」按钮取消当前回答,可重试', async () => {
    render(<ChatPanel repoId={1} transport={createFakeTransport([{ hang: true }])} />);
    ask();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('aborted'));
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('done.sessionId 可接收但不依赖:下一轮请求不带 sessionId(多轮等后端 P4)', async () => {
    const reqs: unknown[] = [];
    const doneWithSession = {
      event: 'done',
      data: { messageId: 1, sessionId: 42, droppedCitations: 0, usage: { in: 1, out: 1 } },
    } as ChatEvent;
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([doneWithSession], { onRequest: (r) => reqs.push(r) })}
      />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    ask();
    await waitFor(() => expect(reqs).toHaveLength(2));
    expect(reqs[1]).not.toHaveProperty('sessionId');
  });

  it('用户点停止 → 显示「已停止」,不是错误样式/文案', async () => {
    render(<ChatPanel repoId={1} transport={createFakeTransport([{ hang: true }])} />);
    ask();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    const st = await within(lastAnswer()).findByRole('status');
    expect(st).toHaveTextContent(/^已停止$/);
    expect(st).not.toHaveClass('text-accent-strong');
    expect(within(lastAnswer()).queryByRole('alert')).toBeNull();
    expect(lastAnswer()).not.toHaveTextContent(/出错|失败|中断|断开|超时/);
  });

  it('同一 id 重复引用:每次追加角标,引用卡片只一张', async () => {
    const c = (id: number) =>
      ({
        event: 'citation',
        data: { id, path: `src/${id}.ts`, startLine: 1, endLine: 2, nodeId: `f:src/${id}.ts` },
      }) as ChatEvent;
    render(
      <ChatPanel
        repoId={1}
        transport={createFakeTransport([
          { event: 'token', data: { text: '甲' } },
          c(2),
          { event: 'token', data: { text: '乙 [[S1:1-2]]' } },
          c(1),
          c(2),
          { event: 'token', data: { text: '丙 [[S' } },
          {
            event: 'done',
            data: { messageId: 1, droppedCitations: 0, usage: { in: 1, out: 1 } },
          },
        ])}
      />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    const sups = lastAnswer().querySelectorAll('sup');
    expect([...sups].map((x) => x.textContent)).toEqual(['[2]', '[1]', '[2]']);
    expect(within(lastAnswer()).getAllByRole('button', { name: /src\/2\.ts/ })).toHaveLength(3);
    expect(lastAnswer().textContent).not.toContain('[[');
  });

  /** 与 apps/api/src/chat/route.ts(#108)一致的事件顺序:tool(rewrite) → tool(retrieve) → token/citation → error 替代 done */
  const midStreamError = (retryable: boolean): FakeStep[] => [
    { event: 'tool', data: { name: 'rewrite', args: {} } },
    { event: 'tool', data: { name: 'retrieve', args: { k: 8 } } },
    { event: 'token', data: { text: '已输出的前半段' } },
    {
      event: 'citation',
      data: { id: 1, path: 'src/a.ts', startLine: 1, endLine: 3, nodeId: 'f:src/a.ts' },
    },
    {
      event: 'error',
      data: { code: 'LLM_UNAVAILABLE', message: '回答超时,请重试', retryable },
    },
  ];

  it('流中途 error(retryable=true):保留部分回答与引用,标明未完成且刷新后不保留,给重试', async () => {
    render(<ChatPanel repoId={1} transport={createFakeTransport(midStreamError(true))} />);
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('error'));
    const a = lastAnswer();
    expect(a).toHaveTextContent('已输出的前半段');
    expect(within(a).getByRole('list', { name: '引用' })).toHaveTextContent('src/a.ts:1–3');
    expect(within(a).getByRole('alert')).toHaveTextContent('模型服务暂时不可用');
    expect(within(a).getByRole('alert')).toHaveTextContent('回答未完成');
    expect(within(a).getByRole('alert')).toHaveTextContent('刷新后不保留');
    expect(within(a).getByRole('button', { name: '重试' })).toBeEnabled();
  });

  it('流中途 error(retryable=false):同样标明未完成,但不给重试', async () => {
    render(<ChatPanel repoId={1} transport={createFakeTransport(midStreamError(false))} />);
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('error'));
    expect(within(lastAnswer()).getByRole('alert')).toHaveTextContent('回答未完成');
    expect(within(lastAnswer()).queryByRole('button', { name: /重试/ })).toBeNull();
  });

  it('开流前 error(没有任何正文):不显示「回答未完成」', async () => {
    render(
      <ChatPanel repoId={1} transport={createFakeTransport([errorOf('LLM_UNAVAILABLE', true)])} />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('error'));
    expect(lastAnswer()).not.toHaveTextContent('回答未完成');
  });

  // #108 开流前的 HTTP 错误(apps/api/src/chat/route.ts 检查顺序:id → schema → 限流/并发 → 404/409;errors.ts 状态码)
  const httpCases: [number, unknown, RegExp, boolean][] = [
    [
      400,
      { error: { code: 'BAD_REQUEST', message: '请求体无效', details: { fields: ['message'] } } },
      /问答请求失败:请求体无效/,
      false,
    ],
    [
      404,
      { error: { code: 'REPO_NOT_FOUND', message: '会话不存在' } },
      /问答请求失败:会话不存在/,
      false,
    ],
    [
      409,
      { error: { code: 'REPO_NOT_READY', message: '仓库尚未分析完成' } },
      /仓库还在分析中/,
      true,
    ],
    // 并发满:没有 details(没有 reason,也没有 retryAfterSec)
    [
      429,
      { error: { code: 'RATE_LIMITED', message: '当前问答并发已满,请稍后再试' } },
      /提问太频繁,请稍后再试/,
      true,
    ],
    [
      500,
      { error: { code: 'INTERNAL', message: '服务器内部错误' } },
      /问答请求失败:服务器内部错误/,
      true,
    ],
  ];
  it.each(httpCases)(
    '开流前 HTTP %i:中文提示,不出现 NaN/undefined,重试按状态给出',
    async (status, body, text, retry) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      );
      render(
        <ChatPanel
          repoId={1}
          transport={createFetchTransport('http://api.test', fetchImpl as unknown as typeof fetch)}
        />,
      );
      ask();
      await waitFor(() => expect(lastAnswer().dataset.status).toBe('error'));
      const alert = within(lastAnswer()).getByRole('alert');
      expect(alert.textContent).toMatch(text);
      expect(lastAnswer().textContent).not.toMatch(/NaN|undefined|null/);
      expect(lastAnswer()).not.toHaveTextContent('回答未完成');
      const btn = within(lastAnswer()).queryByRole('button', { name: /重试/ });
      if (retry) expect(btn).not.toBeNull();
      else expect(btn).toBeNull();
      if (status === 429) {
        expect(btn).toHaveTextContent(/^重试$/);
        expect(within(lastAnswer()).getByTestId('retry-wait')).toHaveTextContent('10 秒后可再提问');
      }
    },
  );
});

describe('<ChatPanel> 契约 v2:done.truncated(T-235)', () => {
  const done = (extra: Record<string, unknown>): FakeStep =>
    ({
      event: 'done',
      data: { messageId: 1, droppedCitations: 0, usage: { in: 0, out: 0 }, ...extra },
    }) as ChatEvent;
  const tok: FakeStep = { event: 'token', data: { text: '部分回答' } } as ChatEvent;

  it('truncated=true → 显示「回答可能被截断」,不给重试(回答已正常落库)', async () => {
    render(
      <ChatPanel repoId={1} transport={createFakeTransport([tok, done({ truncated: true })])} />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(lastAnswer()).toHaveTextContent('回答可能被截断');
    expect(within(lastAnswer()).queryByRole('button', { name: /重试/ })).toBeNull();
    expect(within(lastAnswer()).queryByRole('alert')).toBeNull();
  });

  it.each([
    ['缺省', {}],
    ['false', { truncated: false }],
  ])('truncated %s → 不显示截断提示', async (_n, extra) => {
    render(<ChatPanel repoId={1} transport={createFakeTransport([tok, done(extra)])} />);
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('done'));
    expect(lastAnswer()).not.toHaveTextContent('截断');
  });
});

describe('<ChatPanel> 契约 v2:429 按 details.reason 细分(T-235)', () => {
  const cases: Array<[string, Record<string, unknown> | undefined, RegExp, RegExp | null, string]> =
    [
      [
        'rate_limit + retryAfterSec=30',
        { reason: 'rate_limit', retryAfterSec: 30 },
        /本小时提问次数已用完,请稍后再试/,
        null,
        '30 秒后可再提问',
      ],
      [
        'rate_limit 无 retryAfterSec → 兜底 10s',
        { reason: 'rate_limit' },
        /本小时提问次数已用完/,
        null,
        '10 秒后可再提问',
      ],
      [
        'rate_limit retryAfterSec 非正整数 → 兜底 10s',
        { reason: 'rate_limit', retryAfterSec: '30' },
        /本小时提问次数已用完/,
        null,
        '10 秒后可再提问',
      ],
      [
        'rate_limit retryAfterSec 超上限 → 截到 3600s',
        { reason: 'rate_limit', retryAfterSec: 99999 },
        /本小时提问次数已用完/,
        null,
        '约 60 分钟后可再提问',
      ],
      [
        'concurrency(即使带了 retryAfterSec 也不用)',
        { reason: 'concurrency', retryAfterSec: 30 },
        /当前提问的人较多,请稍后再试/,
        /本小时/,
        '10 秒后可再提问',
      ],
      [
        '未知 reason',
        { reason: 'something_new', retryAfterSec: 30 },
        /提问太频繁,请稍后再试/,
        /本小时|提问的人较多/,
        '10 秒后可再提问',
      ],
      [
        'rate_limit 59 秒(不足 60,无「约」)',
        { reason: 'rate_limit', retryAfterSec: 59 },
        /本小时/,
        null,
        '59 秒后可再提问',
      ],
      [
        'rate_limit 60 秒 → 约 1 分钟',
        { reason: 'rate_limit', retryAfterSec: 60 },
        /本小时/,
        null,
        '约 1 分钟后可再提问',
      ],
      [
        'rate_limit 61 秒 → 约 2 分钟(向上取整)',
        { reason: 'rate_limit', retryAfterSec: 61 },
        /本小时/,
        null,
        '约 2 分钟后可再提问',
      ],
      [
        'rate_limit 3599 秒 → 约 60 分钟',
        { reason: 'rate_limit', retryAfterSec: 3599 },
        /本小时/,
        null,
        '约 60 分钟后可再提问',
      ],
      ['缺 details', undefined, /提问太频繁,请稍后再试/, /本小时|提问的人较多/, '10 秒后可再提问'],
    ];
  it.each(cases)('%s', async (_n, details, text, notText, waitText) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'RATE_LIMITED', message: 'x', ...(details && { details }) },
          }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ),
    );
    render(
      <ChatPanel
        repoId={1}
        transport={createFetchTransport('http://api.test', fetchImpl as unknown as typeof fetch)}
      />,
    );
    ask();
    await waitFor(() => expect(lastAnswer().dataset.status).toBe('error'));
    const alert = within(lastAnswer()).getByRole('alert');
    expect(alert.textContent).toMatch(text);
    if (notText) expect(alert.textContent).not.toMatch(notText);
    expect(lastAnswer().textContent).not.toMatch(/NaN|undefined|null/);
    // T-236:等待时长只在提示行;按钮文字固定「重试」,仅禁用
    const wait = within(lastAnswer()).getByTestId('retry-wait');
    expect(wait.textContent).toBe(waitText);
    const btn = within(lastAnswer()).getByRole('button', { name: /重试/ });
    expect(btn.textContent).toBe('重试');
    expect(btn).toBeDisabled();
  });
});
