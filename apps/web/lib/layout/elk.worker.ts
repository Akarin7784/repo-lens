/// <reference lib="webworker" />
// elkjs 布局 worker:主线程发 { id, graph },这里同步跑 elk.bundled 后回 { id, result } 或 { id, error }
import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();
self.onmessage = async (
  ev: MessageEvent<{ id: number; graph: Parameters<typeof elk.layout>[0] }>,
) => {
  const { id, graph } = ev.data;
  try {
    const result = await elk.layout(graph);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
