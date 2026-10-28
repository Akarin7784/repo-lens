import type { Redis } from 'ioredis';
import type { JobEvent } from '@repolens/shared';
import { JOB_EVENTS_MAXLEN, JOB_EVENTS_TTL_S, redisKeys } from '@repolens/db';

/** 进度事件出口;Redis 实现写 Stream,测试可用数组实现 */
export interface EventSink {
  emit(e: JobEvent): Promise<void>;
}

/** XADD job:{jobId}:events MAXLEN ~ 500 * event <name> data <json>,并续期 24h */
export class RedisEventSink implements EventSink {
  constructor(private readonly redis: Redis) {}
  async emit(e: JobEvent): Promise<void> {
    const key = redisKeys.jobEvents(e.data.jobId);
    await this.redis
      .multi()
      .xadd(
        key,
        'MAXLEN',
        '~',
        JOB_EVENTS_MAXLEN,
        '*',
        'event',
        e.event,
        'data',
        JSON.stringify(e.data),
      )
      .expire(key, JOB_EVENTS_TTL_S)
      .exec();
  }
}

export class MemoryEventSink implements EventSink {
  readonly events: JobEvent[] = [];
  async emit(e: JobEvent): Promise<void> {
    this.events.push(e);
  }
}
