import type { ChatEvent } from '@repolens/shared';
import { describe, expect, it } from 'vitest';
import { answerReducer, initialAnswer, type Answer, type AnswerAction } from './answer';

const ev = (e: ChatEvent): AnswerAction => ({ type: 'event', event: e });
const tok = (text: string) => ev({ event: 'token', data: { text } });
const cite = (id: number) =>
  ev({
    event: 'citation',
    data: { id, path: `src/${id}.ts`, startLine: 1, endLine: 2, nodeId: `f:src/${id}.ts` },
  });
const done = ev({
  event: 'done',
  data: { messageId: 9, droppedCitations: 0, retrieval: 'hybrid', usage: { in: 1, out: 1 } },
});
const run = (acts: AnswerAction[], from: Answer = initialAnswer) =>
  acts.reduce(answerReducer, from);

describe('answerReducer', () => {
  it('thinking → token 流式追加(相邻 token 合并)→ 角标插在当时正文末尾 → done', () => {
    const a = run([tok('连接池在 '), cite(1), tok('中'), tok('创建'), done]);
    expect(a.status).toBe('done');
    expect(a.segments).toEqual([
      { kind: 'text', text: '连接池在 ' },
      { kind: 'cite', id: 1 },
      { kind: 'text', text: '中创建' },
    ]);
    expect(a.done).toMatchObject({ messageId: 9, retrieval: 'hybrid' });
  });

  it('done.sessionId(#108 起服务端始终填写)被保存到 Answer.done,不丢字段', () => {
    const a = run([
      tok('x'),
      ev({
        event: 'done',
        data: { messageId: 3, sessionId: 42, droppedCitations: 0, usage: { in: 1, out: 1 } },
      }),
    ]);
    expect(a.done?.sessionId).toBe(42);
    expect(a.done?.messageId).toBe(3);
  });

  it('流中途 error(#108 总时限超时 / 上游出错):保留已输出正文与引用,状态为 error', () => {
    const a = run([
      ev({ event: 'tool', data: { name: 'retrieve', args: { k: 8 } } }),
      tok('前半段'),
      cite(1),
      ev({
        event: 'error',
        data: { code: 'LLM_UNAVAILABLE', message: '回答超时,请重试', retryable: true },
      }),
    ]);
    expect(a.status).toBe('error');
    expect(a.segments).toEqual([
      { kind: 'text', text: '前半段' },
      { kind: 'cite', id: 1 },
    ]);
    expect(a.citations).toHaveLength(1);
    expect(a.error).toMatchObject({ code: 'LLM_UNAVAILABLE', retryable: true });
    expect(a.done).toBeNull();
  });

  it('done.messageId 在 Answer 类型上可选(T-232,shared 放宽前置;只有类型层覆盖,见 PR)', () => {
    // 类型断言:messageId 改回必填时,这行在 `tsc --noEmit` 下编译失败
    const d: NonNullable<Answer['done']> = { droppedCitations: 0 };
    const a: Answer = { ...initialAnswer, status: 'done', done: d };
    expect(a.done).not.toBeNull();
    expect(a.done?.messageId).toBeUndefined();
    expect('messageId' in d).toBe(false);
  });

  it('citation 先于第一个 token 到达(定位类问题缓冲下发):仍是 thinking,角标在开头', () => {
    const a = run([cite(1)]);
    expect(a.status).toBe('thinking');
    expect(run([tok('x')], a).segments[0]).toEqual({ kind: 'cite', id: 1 });
  });

  it('首次出现:citation.id 作显示编号,在到达处追加 [id] 角标并新增列表项', () => {
    const a = run([tok('甲'), cite(3)]);
    expect(a.segments).toEqual([
      { kind: 'text', text: '甲' },
      { kind: 'cite', id: 3 },
    ]);
    expect(a.citations.map((c) => c.id)).toEqual([3]);
  });

  it('重复引用:同一 id 每次到达都追加角标,但不新增列表项', () => {
    const a = run([tok('甲'), cite(1), tok('乙'), cite(1), cite(1)]);
    expect(a.segments.filter((s) => s.kind === 'cite')).toEqual([
      { kind: 'cite', id: 1 },
      { kind: 'cite', id: 1 },
      { kind: 'cite', id: 1 },
    ]);
    expect(a.citations).toHaveLength(1);
  });

  it('乱序到达:[2] 先于 [1] 时按到达位置插角标,列表按首次到达顺序', () => {
    const a = run([tok('甲'), cite(2), tok('乙'), cite(1), tok('丙'), cite(2)]);
    expect(a.segments).toEqual([
      { kind: 'text', text: '甲' },
      { kind: 'cite', id: 2 },
      { kind: 'text', text: '乙' },
      { kind: 'cite', id: 1 },
      { kind: 'text', text: '丙' },
      { kind: 'cite', id: 2 },
    ]);
    expect(a.citations.map((c) => c.id)).toEqual([2, 1]);
  });

  it('终止后的迟到事件全部忽略:error 之后的 done/token 不改变状态', () => {
    const a = run([
      tok('a'),
      ev({ event: 'error', data: { code: 'LLM_UNAVAILABLE', message: 'x', retryable: true } }),
      done,
      tok('b'),
    ]);
    expect(a.status).toBe('error');
    expect(a.error?.code).toBe('LLM_UNAVAILABLE');
    expect(a.segments).toEqual([{ kind: 'text', text: 'a' }]);
  });

  it('流结束但没有 done/error → interrupted,保留已输出内容与引用', () => {
    const a = run([tok('a'), cite(1), { type: 'ended' }]);
    expect(a.status).toBe('interrupted');
    expect(a.citations).toHaveLength(1);
  });

  it('done 之后的 ended 不覆盖 done', () => {
    expect(run([tok('a'), done, { type: 'ended' }]).status).toBe('done');
  });

  it('timeout 只在 thinking 时生效;已开始输出则忽略', () => {
    expect(run([{ type: 'timeout' }]).status).toBe('timeout');
    expect(run([tok('a'), { type: 'timeout' }]).status).toBe('streaming');
  });

  it('不合法事件只计数;tool 只更新提示且被 token 清掉', () => {
    const a = run([
      { type: 'invalid' },
      ev({ event: 'tool', data: { name: 'read_file', args: { path: 'src/a.ts' } } }),
    ]);
    expect(a.invalidEvents).toBe(1);
    expect(a.toolHint).toBe('正在读取 src/a.ts');
    expect(run([tok('x')], a).toolHint).toBeNull();
  });
});
