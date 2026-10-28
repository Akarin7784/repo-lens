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
