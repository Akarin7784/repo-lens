import { describe, expect, it } from 'vitest';
import { parseSse, type SseFrame } from './sse';

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch);
      c.close();
    },
  });
}
async function collect(s: ReadableStream<Uint8Array>) {
  const out: SseFrame[] = [];
  for await (const f of parseSse(s)) out.push(f);
  return out;
}

describe('parseSse', () => {
  it('跨 chunk 切开的帧、CRLF、注释心跳、多行 data', async () => {
    const frames = await collect(
      streamOf([
        ': ping\n\nevent: tok',
        'en\r\ndata: {"text":"a"}\r\n\r\n',
        'event: token\ndata: line1\ndata: line2\n\n',
      ]),
    );
    expect(frames).toEqual([
      { event: 'token', data: '{"text":"a"}' },
      { event: 'token', data: 'line1\nline2' },
    ]);
  });

  it('多字节中文在字节中间被切开仍能正确拼接', async () => {
    const bytes = new TextEncoder().encode('event: token\ndata: {"text":"连接池"}\n\n');
    const cut = bytes.indexOf(0xe8) + 1; // 「连」的第一个字节之后
    const frames = await collect(streamOf([bytes.slice(0, cut), bytes.slice(cut)]));
    expect(JSON.parse(frames[0]!.data)).toEqual({ text: '连接池' });
  });

  it('没有以空行结束的残帧不派发;缺省事件名为 message', async () => {
    expect(await collect(streamOf(['data: x\n\nevent: done\ndata: {}']))).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });
});
