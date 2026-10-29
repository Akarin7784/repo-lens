import { useMemo } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { GraphView } from './GraphView';
import { createFixtureSource, type GraphSource } from '../../lib/graph/source';
import { SAMPLE_REPOS } from '../../lib/fixtures';
import { createInlineEngine } from '../../lib/layout/elk';

// T-240:包一层 useReactFlow,只记录 fitView / setViewport 调用,行为仍走真实实现
const spies = vi.hoisted(() => ({ fitView: vi.fn(), setViewport: vi.fn() }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const a = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...a,
    useReactFlow: () => {
      const r = a.useReactFlow();
      return useMemo(
        () => ({
          ...r,
          fitView: ((...x: Parameters<typeof r.fitView>) => {
            spies.fitView(...x);
            return r.fitView(...x);
          }) as typeof r.fitView,
          setViewport: ((...x: Parameters<typeof r.setViewport>) => {
            spies.setViewport(...x);
            return r.setViewport(...x);
          }) as typeof r.setViewport,
        }),
        [r],
      );
    },
  };
});

const MW = 'm:src/middleware';
const mwFile = '[data-testid^="node-f:src/middleware/"]';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** fixture 源,但 middleware 的 loadChildren 由测试控制 */
function controlledSource() {
  const s = SAMPLE_REPOS.zustand;
  const base = createFixtureSource('pmndrs/zustand', s.data);
  const pending: ReturnType<typeof deferred<Awaited<ReturnType<GraphSource['loadChildren']>>>>[] =
    [];
  const calls: (string | null)[] = [];
  const source: GraphSource = {
    ...base,
    loadChildren: (id) => {
      calls.push(id);
      if (id !== MW) return base.loadChildren(id);
      const d = deferred<Awaited<ReturnType<GraphSource['loadChildren']>>>();
      pending.push(d);
      return d.promise;
    },
  };
  return { source, base, pending, calls };
}

async function mount(source: GraphSource) {
  const s = SAMPLE_REPOS.zustand;
  const engine = await createInlineEngine();
  const r = render(
    <div style={{ width: 1000, height: 700 }}>
      <GraphView source={source} owner={s.owner} repo={s.repo} engine={engine} />
    </div>,
  );
  await screen.findByRole('button', { name: '展开 middleware' });
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('当前显示'));
  await waitFor(() => expect(spies.fitView).toHaveBeenCalled());
  return r;
}

/** 触发一次与展开/收起无关的重新布局(切换外部依赖),并等它的 fit 发生 */
async function unrelatedRelayout() {
  const n = spies.fitView.mock.calls.length;
  fireEvent.click(screen.getByRole('checkbox', { name: '外部依赖' }));
  await waitFor(() => expect(spies.fitView.mock.calls.length).toBeGreaterThan(n));
}

describe('<GraphView> 锚点后续(T-240)', () => {
  beforeEach(() => {
    spies.fitView.mockClear();
    spies.setViewport.mockClear();
  });

  it('展开后恢复视图用 setViewport(..., { duration: 200 }),缩放保持', async () => {
    const c = controlledSource();
    await mount(c.source);
    fireEvent.click(screen.getByRole('button', { name: '展开 middleware' }));
    c.pending[0]!.resolve(await c.base.loadChildren(MW));
    await waitFor(() => expect(document.querySelector(mwFile)).not.toBeNull());
    await waitFor(() => expect(spies.setViewport).toHaveBeenCalledTimes(1));
    expect(spies.setViewport).toHaveBeenCalledWith(expect.objectContaining({ zoom: 1 }), {
      duration: 200,
    });
  });

  it('loadChildren 失败后,下一次无关布局不用残留锚点(走 fit,不 setViewport)', async () => {
    const c = controlledSource();
    await mount(c.source);
    fireEvent.click(screen.getByRole('button', { name: '展开 middleware' }));
    c.pending[0]!.reject(new Error('boom'));
    await screen.findByText(/加载 m:src\/middleware 失败/);
    await unrelatedRelayout();
    expect(spies.setViewport).not.toHaveBeenCalled();
  });

  it('状态没变化的点击(加载中)不留锚点:此时发生的无关布局走 fit', async () => {
    const c = controlledSource();
    await mount(c.source);
    fireEvent.click(screen.getByRole('button', { name: '展开 middleware' }));
    await unrelatedRelayout();
    expect(spies.setViewport).not.toHaveBeenCalled();
    c.pending[0]!.resolve(await c.base.loadChildren(MW));
    await waitFor(() => expect(document.querySelector(mwFile)).not.toBeNull());
  });

  it('连点两次展开(第二次在第一次加载中):只请求一次,只锚定一次,之后无关布局走 fit', async () => {
    const c = controlledSource();
    await mount(c.source);
    const btn = screen.getByRole('button', { name: '展开 middleware' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(c.calls.filter((x) => x === MW)).toHaveLength(1);
    c.pending[0]!.resolve(await c.base.loadChildren(MW));
    await waitFor(() => expect(document.querySelector(mwFile)).not.toBeNull());
    await waitFor(() => expect(spies.setViewport).toHaveBeenCalledTimes(1));
    await unrelatedRelayout();
    expect(spies.setViewport).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/失败/)).toBeNull();
  });
});
