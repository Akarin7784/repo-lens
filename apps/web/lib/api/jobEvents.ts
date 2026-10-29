import {
  JobEventSchema,
  PROGRESS_STAGES,
  type JobEvent,
  type ProgressStage,
} from '@repolens/shared';

/** 进度面板状态:由 SSE 事件驱动的纯 reducer */
export type JobProgress = {
  stage: ProgressStage;
  progress: number;
  message?: string;
  /** stage_error:某阶段失败的说明(任务随后会收到 done{status:'failed'}) */
  stageError?: { stage: ProgressStage; message: string };
  graphReady: boolean;
  status: 'running' | 'done' | 'failed';
};

export const initialJobProgress: JobProgress = {
  stage: 'queued',
  progress: 0,
  graphReady: false,
  status: 'running',
};

export const STAGE_LABEL: Record<ProgressStage, string> = {
  queued: '排队中',
  cloning: '克隆仓库',
  scanning: '扫描文件',
  parsing: '解析依赖',
  graph_ready: '依赖图已生成',
  summarizing: '生成摘要',
  embedding: '建立索引',
  done: '完成',
};

export const stageIndex = (s: ProgressStage) => PROGRESS_STAGES.indexOf(s);

export function jobProgressReducer(s: JobProgress, e: JobEvent): JobProgress {
  switch (e.event) {
    case 'progress':
      return {
        ...s,
        // 进度只前进,不回退(重连回放旧事件时也安全)
        stage: stageIndex(e.data.stage) >= stageIndex(s.stage) ? e.data.stage : s.stage,
        progress: Math.max(s.progress, e.data.progress),
        message: e.data.message ?? s.message,
      };
    case 'graph_ready':
      return {
        ...s,
        graphReady: true,
        stage: stageIndex(s.stage) < stageIndex('graph_ready') ? 'graph_ready' : s.stage,
      };
    case 'stage_error':
      return { ...s, stageError: { stage: e.data.stage, message: e.data.message } };
    case 'done':
      return {
        ...s,
        status: e.data.status,
        ...(e.data.status === 'done' ? { stage: 'done' as const, progress: 100 } : {}),
      };
  }
}

/** EventSource 的最小接口(浏览器原生实现,测试里注入假实现) */
export type EventSourceLike = {
  addEventListener(type: string, fn: (ev: MessageEvent) => void): void;
  close(): void;
  onerror: ((ev: Event) => void) | null;
};
export type EventSourceFactory = (url: string) => EventSourceLike;

const EVENT_NAMES = ['progress', 'graph_ready', 'stage_error', 'done'] as const;

/**
 * 订阅 `GET /api/jobs/:id/events`。每条事件用 shared 的 JobEventSchema 校验,不合法的丢弃并回调 onInvalid。
 * 收到 done 后主动关闭(否则 EventSource 会自动重连)。断线重连交给 EventSource 自带的 Last-Event-ID。
 */
export function subscribeJobEvents(
  url: string,
  handlers: {
    onEvent: (e: JobEvent) => void;
    onInvalid?: (raw: string) => void;
    onConnectionError?: () => void;
  },
  factory: EventSourceFactory = (u) => new EventSource(u) as unknown as EventSourceLike,
): () => void {
  const es = factory(url);
  let closed = false;
  for (const name of EVENT_NAMES)
    es.addEventListener(name, (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return handlers.onInvalid?.(String(ev.data));
      }
      const parsed = JobEventSchema.safeParse({ event: name, data });
      if (!parsed.success) return handlers.onInvalid?.(String(ev.data));
      handlers.onEvent(parsed.data);
      if (parsed.data.event === 'done') {
        closed = true;
        es.close();
      }
    });
  es.onerror = () => {
    if (!closed) handlers.onConnectionError?.();
  };
  return () => {
    closed = true;
    es.close();
  };
}
