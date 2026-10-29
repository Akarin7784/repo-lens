/**
 * T-230:把 fetch 的 ReadableStream 解析成 SSE 帧。
 * 问答是 POST(EventSource 只能 GET),所以不能用浏览器 EventSource,自己按 WHATWG SSE 规则切帧:
 * - 帧之间用空行分隔,兼容 \n、\r\n、\r;
 * - `event:` 取事件名(缺省 message),多行 `data:` 用 \n 拼接;以 `:` 开头的是注释(心跳),忽略;
 * - 字段名后的第一个空格去掉;chunk 可能在任意字节处切开(包括多字节中文中间),用 TextDecoder stream 模式拼接。
 * 流结束时残留的半帧丢弃(规范要求:没有以空行结束的帧不派发)。
 */
export type SseFrame = { event: string; data: string };

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let data: string[] = [];
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      // 按行切;最后一段可能是不完整的行,留到下一次
      const lines = buf.split(/\r\n|\r|\n/);
      buf = lines.pop() ?? '';
      // 末尾是单独的 \r 时,下一块可能以 \n 开头:split 已把 \r 当行尾,下一块开头的 \n 会多出一个空行,
      // 只有在已有字段时空行才会派发,空帧不派发,因此不会误发
      for (const line of lines) {
        if (line === '') {
          if (data.length > 0) yield { event: event || 'message', data: data.join('\n') };
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        let val = i < 0 ? '' : line.slice(i + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
        // id / retry:问答流不做断点续传(见 PR 说明),忽略
      }
    }
  } finally {
    reader.releaseLock();
  }
}
