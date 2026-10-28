import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { redisKeys, type Store, type TaskRow } from '@repolens/db';

export interface SseOptions {
  redis: Redis;
  store: Store;
  task: TaskRow;
  lastEventId: string;
  pingIntervalMs: number;
}

const frame = (id: string, event: string, data: string) =>
  `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;

/** 流过期(24h)但任务已结束时,用 DB 状态补发终态事件 */
function synthesize(task: TaskRow): string {
  const { jobId, repoId } = task;
  if (task.stage === 'done')
    return (
      frame('0-1', 'progress', JSON.stringify({ jobId, stage: 'done', progress: 100 })) +
      frame(
        '0-2',
        'graph_ready',
        JSON.stringify({ jobId, repoId, graphUrl: `/api/repos/${repoId}/graph` }),
      ) +
      frame('0-3', 'done', JSON.stringify({ jobId, status: 'done' }))
    );
  return (
    frame(
      '0-1',
      'stage_error',
      JSON.stringify({
        jobId,
        stage: task.stats.failedStage ?? 'queued',
        message: task.errorMsg ?? '任务失败',
      }),
    ) + frame('0-2', 'done', JSON.stringify({ jobId, status: 'failed' }))
  );
}

/**
 * SSE:XREAD BLOCK 读 job:{jobId}:events,支持 Last-Event-ID 续传;每 15s 发 `: ping`;收到 done 后关闭。
 * 每个客户端独占一条 Redis 连接(BLOCK 会占住连接)。
 */
export async function streamJobEvents(reply: FastifyReply, o: SseOptions): Promise<void> {
  const key = redisKeys.jobEvents(o.task.jobId);
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.write('retry: 3000\n\n');

  let closed = false;
  const sub = o.redis.duplicate();
  const ping = setInterval(() => raw.write(': ping\n\n'), o.pingIntervalMs);
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    sub.disconnect();
    raw.end();
  };
  raw.on('close', finish);

  try {
    if (!(await o.redis.exists(key))) {
      const fresh = await o.store.getTask(o.task.jobId);
      if (fresh && (fresh.stage === 'done' || fresh.stage === 'failed')) {
        raw.write(synthesize(fresh));
        return finish();
      }
    }
    let last = o.lastEventId;
    while (!closed) {
      const res = (await sub.xread('COUNT', 100, 'BLOCK', 5000, 'STREAMS', key, last)) as
        [string, [string, string[]][]][] | null;
      for (const [id, fields] of res?.[0]?.[1] ?? []) {
        last = id;
        const f = new Map<string, string>();
        for (let i = 0; i + 1 < fields.length; i += 2) f.set(fields[i]!, fields[i + 1]!);
        const ev = f.get('event') ?? 'message';
        raw.write(frame(id, ev, f.get('data') ?? '{}'));
        if (ev === 'done') return finish();
      }
    }
  } catch {
    finish();
  }
}
