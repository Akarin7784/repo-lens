import type { EventSourceLike } from '../lib/api/jobEvents';

/** 测试用 EventSource:手动 emit 命名事件 */
export class FakeES implements EventSourceLike {
  static last: FakeES | null = null;
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeES.last = this;
  }
  addEventListener(t: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  emit(t: string, data: unknown) {
    for (const fn of this.listeners.get(t) ?? [])
      fn({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}
