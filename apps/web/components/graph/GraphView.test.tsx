import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { GraphView } from './GraphView';
import { createFixtureSource } from '../../lib/graph/source';
import { SAMPLE_REPOS } from '../../lib/fixtures';
import { createInlineEngine } from '../../lib/layout/elk';

async function mount() {
  const s = SAMPLE_REPOS.zustand;
  const engine = await createInlineEngine();
  return render(
    <div style={{ width: 1000, height: 700 }}>
      <GraphView
        source={createFixtureSource('pmndrs/zustand', s.data)}
        owner={s.owner}
        repo={s.repo}
        engine={engine}
      />
    </div>,
  );
}
const mwFile = '[data-testid^="node-f:src/middleware/"]';

describe('<GraphView> 环边与图例', () => {
  it('hono 示例的收起视图里有环边标记,图例含「循环依赖」与「仅类型引用」', async () => {
    const s = SAMPLE_REPOS.hono;
    const engine = await createInlineEngine();
    render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView
          source={createFixtureSource('honojs/hono', s.data)}
          owner={s.owner}
          repo={s.repo}
          engine={engine}
        />
      </div>,
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('环边 2'));
    const legend = screen.getByLabelText('图例');
    expect(legend).toHaveTextContent('循环依赖');
    expect(legend).toHaveTextContent('仅类型引用');
  });
});

describe('<GraphView> 交互', () => {
  it('单击节点主体只选中、不展开;Esc 取消选中', async () => {
    const { container } = await mount();
    await screen.findByRole('button', { name: '展开 middleware' });
    const card = container.querySelector('[data-testid="node-m:src/middleware"]')!;
    fireEvent.click(card);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('已选中 src/middleware'),
    );
    expect(container.querySelector(mwFile)).toBeNull();
    expect(card.className).toContain('border-accent-strong');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent('已选中'));
  });

  it('双击 module 展开(附加快捷方式)', async () => {
    const { container } = await mount();
    await screen.findByRole('button', { name: '展开 middleware' });
    fireEvent.doubleClick(container.querySelector('[data-testid="node-m:src/middleware"]')!);
    await waitFor(() => expect(container.querySelector(mwFile)).not.toBeNull());
  });

  it('点击 module 的 ▸ 展开按钮显示其文件,再点收起', async () => {
    const s = SAMPLE_REPOS.zustand;
    const engine = await createInlineEngine();
    const { container } = render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView
          source={createFixtureSource('pmndrs/zustand', s.data)}
          owner={s.owner}
          repo={s.repo}
          engine={engine}
        />
      </div>,
    );
    const btn = await screen.findByRole('button', { name: '展开 middleware' });
    expect(container.querySelector('[data-testid^="node-f:src/middleware/"]')).toBeNull();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(container.querySelector('[data-testid^="node-f:src/middleware/"]')).not.toBeNull(),
    );
    fireEvent.click(await screen.findByRole('button', { name: '收起 middleware' }));
    await waitFor(() =>
      expect(container.querySelector('[data-testid^="node-f:src/middleware/"]')).toBeNull(),
    );
  });
});

// jsdom 里 React Flow 量不到节点尺寸,不渲染边;边级别的样式断言在 WeightedEdge.test.tsx
describe('<GraphView> 悬停预览(T-221)', () => {
  const node = (c: HTMLElement, id: string) =>
    c.querySelector(`[data-testid="node-${id}"]`)!.closest('.react-flow__node')!;
  const wrap = () => screen.getByTestId('graph-wrap');

  it('悬停 120ms 防抖后进入悬停态,移开立即恢复;状态栏计数不变', async () => {
    const { container } = await mount();
    await screen.findByRole('button', { name: '展开 middleware' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('当前显示'));
    const before = screen.getByRole('status').textContent;
    fireEvent.mouseEnter(node(container, 'm:src/middleware'));
    expect(wrap().dataset.hovering).toBeUndefined(); // 防抖期间不生效
    await waitFor(() => expect(wrap().dataset.hovering).toBe('true'));
    expect(screen.getByRole('status').textContent).toBe(before);
    fireEvent.mouseLeave(node(container, 'm:src/middleware'));
    expect(wrap().dataset.hovering).toBeUndefined();
    expect(screen.getByRole('status').textContent).toBe(before);
  });

  it('选中优先:有选中节点时悬停不生效;选中时清掉已有悬停', async () => {
    const { container } = await mount();
    await screen.findByRole('button', { name: '展开 middleware' });
    const mw = node(container, 'm:src/middleware');
    fireEvent.mouseEnter(mw);
    await waitFor(() => expect(wrap().dataset.hovering).toBe('true'));
    fireEvent.click(container.querySelector('[data-testid="node-m:src/middleware"]')!);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('已选中 src/middleware'),
    );
    expect(wrap().dataset.hovering).toBeUndefined();
    const other = [...container.querySelectorAll('[data-testid^="node-m:"]')].find(
      (n) => n.getAttribute('data-testid') !== 'node-m:src/middleware',
    )!;
    fireEvent.mouseEnter(other.closest('.react-flow__node')!);
    await new Promise((r) => setTimeout(r, 250));
    expect(wrap().dataset.hovering).toBeUndefined();
    expect(screen.getByRole('status')).toHaveTextContent('已选中 src/middleware');
  });
});

describe('<GraphView> 折叠后清除选中(T-222d)', () => {
  async function mountWith(onSel: (s: unknown) => void, clearRequest = 0) {
    const s = SAMPLE_REPOS.zustand;
    const engine = await createInlineEngine();
    const ui = (c: number) => (
      <div style={{ width: 1000, height: 700 }}>
        <GraphView
          source={createFixtureSource('pmndrs/zustand', s.data)}
          owner={s.owner}
          repo={s.repo}
          engine={engine}
          onSelectionChange={onSel}
          clearRequest={c}
        />
      </div>
    );
    const r = render(ui(clearRequest));
    return { ...r, rerenderClear: (c: number) => r.rerender(ui(c)) };
  }

  it('选中目录里的文件后折叠该目录:选中被清除,回调 null,状态栏不再显示「已选中」', async () => {
    const calls: unknown[] = [];
    const { container } = await mountWith((s) => calls.push(s));
    fireEvent.click(await screen.findByRole('button', { name: '展开 middleware' }));
    await waitFor(() => expect(container.querySelector(mwFile)).not.toBeNull());
    const file = container.querySelector(mwFile)!;
    const fileId = file.getAttribute('data-testid')!.slice('node-'.length);
    fireEvent.click(file);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已选中'));
    expect(calls.at(-1)).toMatchObject({ id: fileId });
    fireEvent.click(await screen.findByRole('button', { name: '收起 middleware' }));
    await waitFor(() => expect(container.querySelector(mwFile)).toBeNull());
    await waitFor(() => expect(calls.at(-1)).toBeNull());
    expect(screen.getByRole('status')).not.toHaveTextContent('已选中');
  });

  it('选中后「全部收起」同样清除选中', async () => {
    const calls: unknown[] = [];
    const { container } = await mountWith((s) => calls.push(s));
    fireEvent.click(await screen.findByRole('button', { name: '展开 middleware' }));
    await waitFor(() => expect(container.querySelector(mwFile)).not.toBeNull());
    fireEvent.click(container.querySelector(mwFile)!);
    await waitFor(() => expect(calls.at(-1)).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '全部收起' }));
    await waitFor(() => expect(calls.at(-1)).toBeNull());
  });

  it('折叠的不是选中节点所在目录:选中保持', async () => {
    const calls: unknown[] = [];
    const { container } = await mountWith((s) => calls.push(s));
    await screen.findByRole('button', { name: '展开 middleware' });
    fireEvent.click(container.querySelector('[data-testid="node-m:src/middleware"]')!);
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ id: 'm:src/middleware' }));
    fireEvent.click(screen.getByRole('button', { name: '展开 middleware' }));
    await waitFor(() => expect(container.querySelector(mwFile)).not.toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: '收起 middleware' }));
    await waitFor(() => expect(container.querySelector(mwFile)).toBeNull());
    expect(calls.at(-1)).not.toBeNull();
  });

  it('clearRequest 变化(窄屏抽屉「关闭」)取消选中', async () => {
    const calls: unknown[] = [];
    const { container, rerenderClear } = await mountWith((s) => calls.push(s));
    await screen.findByRole('button', { name: '展开 middleware' });
    fireEvent.click(container.querySelector('[data-testid="node-m:src/middleware"]')!);
    await waitFor(() => expect(calls.at(-1)).not.toBeNull());
    rerenderClear(1);
    await waitFor(() => expect(calls.at(-1)).toBeNull());
  });
});
