import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GraphEdge, GraphNode } from '@repolens/shared';
import { GraphView } from './GraphView';
import type { GraphSource } from '../../lib/graph/source';
import type { GraphSlice } from '../../lib/graph/hierarchy';
import { createInlineEngine } from '../../lib/layout/elk';

const SHA = 'a'.repeat(40);
const mod = (id: string): GraphNode =>
  ({ id, type: 'module', parentId: null, label: id.slice(2), path: id.slice(2) }) as GraphNode;
const file = (path: string, parentId: string): GraphNode =>
  ({ id: `f:${path}`, type: 'file', parentId, label: path.split('/').pop()!, path }) as GraphNode;
const agg = (s: string, t: string, weight: number): GraphEdge =>
  ({
    id: `${s}->${t}`,
    source: s,
    target: t,
    type: 'imports',
    kind: 'static',
    srcFileId: 'f:a/x.ts',
    weight,
    aggregated: true,
  }) as GraphEdge;
const slice = (
  parentId: string | null,
  nodes: GraphNode[],
  edges: GraphEdge[],
  truncated = false,
): GraphSlice => ({
  nodes,
  edges,
  meta: { repoId: 1, commitSha: SHA, parentId, language: 'typescript' },
  truncated,
});

/** 模拟真实接口:无 rawEdges,边与边界节点随切片返回 */
function apiSource(): GraphSource & { calls: (string | null)[] } {
  const calls: (string | null)[] = [];
  return {
    repoLabel: 't/t',
    calls,
    loadChildren: vi.fn(async (p: string | null) => {
      calls.push(p);
      if (p === null) return slice(null, [mod('m:a'), mod('m:b')], [agg('m:a', 'm:b', 3)]);
      // m:b 是边界节点(parentId !== 'm:a')
      return slice(
        'm:a',
        [file('a/x.ts', 'm:a'), file('a/y.ts', 'm:a'), mod('m:b')],
        [agg('f:a/x.ts', 'm:b', 2), agg('f:a/y.ts', 'm:b', 1)],
        true,
      );
    }),
  };
}

describe('<GraphView> 真实接口:聚合边、边界节点、截断提示', () => {
  it('展开后用子层聚合边替代容器边;边界节点不进容器;折叠后恢复;截断提示只在该层可见时显示', async () => {
    const src = apiSource();
    const engine = await createInlineEngine();
    const { container } = render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView source={src} owner="t" repo="t" engine={engine} />
      </div>,
    );
    const q = (sel: string) => container.querySelector(sel);
    const status = () => screen.getByRole('status');
    // jsdom 不渲染边的 DOM,边数从状态条读(真实浏览器里的 ×N 标签与 hover 见 PR 截图)
    await waitFor(() => expect(status()).toHaveTextContent('当前显示 2 节点 / 1 条边'));
    expect(screen.getByLabelText('图例')).toHaveTextContent('聚合次数');
    expect(screen.queryByTestId('truncated-notice')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: '展开 a' }));
    // 容器边 m:a→m:b 被子层的 x→b、y→b 两条聚合边替代;边界节点 m:b 不进 m:a
    await waitFor(() => expect(status()).toHaveTextContent('当前显示 4 节点 / 2 条边'));
    expect(container.querySelectorAll('[data-testid="node-m:b"]')).toHaveLength(1);
    expect(q('[data-testid="node-m:a"] [data-testid="node-m:b"]')).toBeNull();
    expect(screen.getByTestId('truncated-notice')).toHaveTextContent('「a」的子节点超过 300 个');
    expect(src.calls).toEqual([null, 'm:a']);

    fireEvent.click(await screen.findByRole('button', { name: '收起 a' }));
    await waitFor(() => expect(status()).toHaveTextContent('当前显示 2 节点 / 1 条边'));
    expect(q('[data-testid="node-m:b"]')).not.toBeNull();
    expect(screen.queryByTestId('truncated-notice')).toBeNull();

    // 再展开走缓存,不重复请求
    fireEvent.click(await screen.findByRole('button', { name: '展开 a' }));
    await waitFor(() => expect(status()).toHaveTextContent('当前显示 4 节点 / 2 条边'));
    expect(src.calls).toEqual([null, 'm:a']);
  });

  const dir = (id: string, parentId: string): GraphNode =>
    ({ id, type: 'dir', parentId, label: id.slice(2), path: id.slice(2) }) as GraphNode;
  function focusSource(focus?: string) {
    const calls: (string | null)[] = [];
    const src: GraphSource = {
      repoLabel: 't/t',
      loadChildren: vi.fn(async (p: string | null) => {
        calls.push(p);
        if (p === null) {
          const s = slice(null, [mod('m:a'), mod('m:b')], []);
          return focus ? { ...s, meta: { ...s.meta, suggestedFocus: focus } } : s;
        }
        if (p === 'm:a') return slice('m:a', [dir('d:a/src', 'm:a'), file('a/r.ts', 'm:a')], []);
        return slice(
          p,
          [file('a/src/x.ts', 'd:a/src'), file('a/src/y.ts', 'd:a/src')],
          [agg('f:a/src/x.ts', 'f:a/src/y.ts', 1)],
        );
      }),
    };
    return { src, calls };
  }

  it('suggestedFocus:首次加载沿 parentId 链逐层请求并展开;手动折叠后不再自动展开', async () => {
    const { src, calls } = focusSource('d:a/src');
    const engine = await createInlineEngine();
    render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView source={src} owner="t" repo="t" engine={engine} />
      </div>,
    );
    const status = () => screen.getByRole('status');
    // m:a、m:b、d:a/src、a/r.ts、x、y = 6 个节点;根层 module 作为面包屑保留
    await waitFor(() => expect(status()).toHaveTextContent('当前显示 6 节点 / 1 条边'));
    expect(calls).toEqual([null, 'm:a', 'd:a/src']);
    expect(screen.getByTestId('node-m:b')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: '收起 a/src' }));
    await waitFor(() => expect(status()).toHaveTextContent('当前显示 4 节点 / 0 条边'));
    await new Promise((r) => setTimeout(r, 50));
    expect(status()).toHaveTextContent('当前显示 4 节点');
    expect(screen.getByRole('button', { name: '展开 a/src' })).toBeInTheDocument();
  });

  it('没有 suggestedFocus:首屏只有根层,不做任何兜底请求', async () => {
    const { src, calls } = focusSource();
    const engine = await createInlineEngine();
    render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView source={src} owner="t" repo="t" engine={engine} />
      </div>,
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('当前显示 2 节点 / 0 条边'),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([null]);
  });

  it('suggestedFocus 不在任何根层容器路径下:不请求,停在根层', async () => {
    const { src, calls } = focusSource('d:zzz');
    const engine = await createInlineEngine();
    render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView source={src} owner="t" repo="t" engine={engine} />
      </div>,
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('当前显示 2 节点'));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([null]);
  });

  it('suggestedFocus 是文件节点:只处理 module/dir,直接忽略,不请求', async () => {
    const { src, calls } = focusSource('f:a/r.ts');
    const engine = await createInlineEngine();
    render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView source={src} owner="t" repo="t" engine={engine} />
      </div>,
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('当前显示 2 节点'));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([null]);
  });

  it('自动下探的请求失败:显示错误并停止,不重试、不继续下探', async () => {
    const calls: (string | null)[] = [];
    const src: GraphSource = {
      repoLabel: 't/t',
      loadChildren: vi.fn(async (p: string | null) => {
        calls.push(p);
        if (p === null) {
          const s = slice(null, [mod('m:a'), mod('m:b')], []);
          return { ...s, meta: { ...s.meta, suggestedFocus: 'd:a/src' } };
        }
        throw new Error('boom');
      }),
    };
    const engine = await createInlineEngine();
    render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView source={src} owner="t" repo="t" engine={engine} />
      </div>,
    );
    expect(await screen.findByText(/加载 m:a 失败/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual([null, 'm:a']);
    expect(screen.getByRole('button', { name: '展开 a' })).toBeInTheDocument();
  });

  it('自动请求返回前用户已手动操作:丢弃返回结果,不再自动展开', async () => {
    const calls: (string | null)[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const src: GraphSource = {
      repoLabel: 't/t',
      loadChildren: vi.fn(async (p: string | null) => {
        calls.push(p);
        if (p === null) {
          const s = slice(null, [mod('m:a'), mod('m:b')], []);
          return { ...s, meta: { ...s.meta, suggestedFocus: 'd:a/src' } };
        }
        if (p === 'm:a') {
          await gate;
          return slice('m:a', [dir('d:a/src', 'm:a')], []);
        }
        return slice('m:b', [file('b/z.ts', 'm:b')], []);
      }),
    };
    const engine = await createInlineEngine();
    render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView source={src} owner="t" repo="t" engine={engine} />
      </div>,
    );
    await waitFor(() => expect(calls).toEqual([null, 'm:a']));
    fireEvent.click(await screen.findByRole('button', { name: '展开 b' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('当前显示 3 节点'));
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual([null, 'm:a', 'm:b']);
    expect(screen.getByRole('button', { name: '展开 a' })).toBeInTheDocument();
    expect(screen.queryByTestId('node-d:a/src')).not.toBeInTheDocument();
  });
});

describe('<GraphView> 外部跳转与选中回调(T-222)', () => {
  it('jumpRequest 指向未加载的文件:逐层展开所在容器后选中,并回调一跳邻居', async () => {
    const src = apiSource();
    const engine = await createInlineEngine();
    const onSel = vi.fn();
    const { rerender } = render(
      <div style={{ width: 800, height: 600 }}>
        <GraphView source={src} owner="t" repo="t" engine={engine} onSelectionChange={onSel} />
      </div>,
    );
    await waitFor(() => expect(src.calls).toEqual([null]));
    rerender(
      <div style={{ width: 800, height: 600 }}>
        <GraphView
          source={src}
          owner="t"
          repo="t"
          engine={engine}
          onSelectionChange={onSel}
          jumpRequest={{ id: 'f:a/x.ts', n: 1 }}
        />
      </div>,
    );
    await waitFor(() =>
      expect(onSel).toHaveBeenLastCalledWith({ id: 'f:a/x.ts', deps: ['m:b'], dependents: [] }),
    );
    expect(src.calls).toEqual([null, 'm:a']);
  });
});
