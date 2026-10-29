/**
 * T-230 假问答流(只用于测试与 dev 预览,不进生产路径)。
 * 后端问答 API 未实现前,用它按 shared 契约驱动 ChatPanel。所有内容都是假数据。
 */
import type { ChatEvent } from '@repolens/shared';
import { toChatItem, ChatTransportError, type ChatTransport } from '../lib/chat/transport';
import type { ChatErrorInfo } from '../lib/chat/answer';

export type FakeStep =
  | ChatEvent
  /** 原样的一帧(用于构造不合法事件) */
  | { raw: { event: string; data: string } }
  /** 在此处抛错,模拟网络中断 */
  | { fail: ChatErrorInfo }
  /** 在此处挂起,直到被 abort(模拟后端迟迟不响应) */
  | { hang: true };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** 按脚本逐条吐事件;每条经过 shared ChatEventSchema 校验(与生产传输同一个 toChatItem) */
export function createFakeTransport(
  script: FakeStep[] | ((question: string) => FakeStep[]),
  opts: { delayMs?: number; onRequest?: (req: unknown, signal: AbortSignal) => void } = {},
): ChatTransport {
  return async function* (_repoId, req, signal) {
    opts.onRequest?.(req, signal);
    const steps = typeof script === 'function' ? script(req.message) : script;
    for (const s of steps) {
      await sleep(opts.delayMs ?? 0, signal);
      if (signal.aborted) return;
      if ('hang' in s) {
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        return;
      }
      if ('fail' in s) throw new ChatTransportError(s.fail);
      if ('raw' in s) yield toChatItem(s.raw.event, s.raw.data);
      else yield toChatItem(s.event, JSON.stringify(s.data));
    }
  };
}

/** dev 预览/截图用的示例回答(假数据):流式 token + 两条引用 + keyword-only 降级 */
export const DEMO_SCRIPT: FakeStep[] = [
  { event: 'tool', data: { name: 'read_file', args: { path: 'src/db/index.ts' } } },
  { event: 'token', data: { text: '【假数据】这是假流生成的示例回答,第一处引用 [[S1:10-48]]' } },
  {
    event: 'citation',
    data: {
      id: 1,
      path: 'src/db/index.ts',
      startLine: 10,
      endLine: 48,
      nodeId: 'f:src/db/index.ts',
    },
  },
  { event: 'token', data: { text: ',模型原始标记不会显示;' } },
  { event: 'token', data: { text: '路径与行号只以 citation 事件为准,' } },
  { event: 'token', data: { text: '第二处引用 [[S2:22-31]]' } },
  {
    event: 'citation',
    data: {
      id: 2,
      path: 'src/server/app.ts',
      startLine: 22,
      endLine: 31,
      nodeId: 'f:src/server/app.ts',
    },
  },
  { event: 'token', data: { text: '。仅用于界面预览,不代表任何真实回答。' } },
  {
    event: 'done',
    data: {
      messageId: 1,
      droppedCitations: 1,
      retrieval: 'keyword-only',
      usage: { in: 5210, out: 402 },
    },
  },
];
