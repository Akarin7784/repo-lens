import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { GraphView } from './GraphView';
import { createFixtureSource } from '../../lib/graph/source';
import { SAMPLE_REPOS } from '../../lib/fixtures';
import { createInlineEngine } from '../../lib/layout/elk';

const COMPOSE = '[data-testid="node-f:src/compose.ts"]';

async function mount() {
  const s = SAMPLE_REPOS.hono;
  const source = createFixtureSource('honojs/hono', s.data);
  const load = vi.spyOn(source, 'loadChildren');
  const sel: unknown[] = [];
  const engine = await createInlineEngine();
  const r = render(
    <div style={{ width: 1000, height: 700 }}>
      <GraphView
        source={source}
        owner={s.owner}
        repo={s.repo}
        engine={engine}
        onSelectionChange={(x) => sel.push(x)}
      />
    </div>,
  );
  await screen.findByRole('button', { name: '展开 router' });
  return { ...r, load, sel, box: screen.getByRole('combobox', { name: '按路径搜索节点' }) };
}
const type = (box: HTMLElement, v: string) => fireEvent.change(box, { target: { value: v } });
const key = (el: Element, k: string) => fireEvent.keyDown(el, { key: k });

describe('<GraphView> 路径搜索(T-224)', () => {
  it('只搜已加载节点:未加载的 compose.ts 显示「没有匹配的节点」,已加载的 router 能搜到', async () => {
    const { box } = await mount();
    box.focus();
    type(box, 'compose');
    expect(await screen.findByRole('listbox')).toHaveTextContent('没有匹配的节点');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    type(box, 'router');
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('src/router');
  });

  it('已加载但祖先全部折叠:回车后沿 parentId 链逐层展开(m:. → d:src),选中并回调,不重复请求', async () => {
    const { container, box, load, sel } = await mount();
    // 先手动展开两层让 compose.ts 进入图数据,再全部收起
    fireEvent.click(screen.getByRole('button', { name: '展开 (root)' }));
    fireEvent.click(await screen.findByRole('button', { name: '展开 src' }));
    await waitFor(() => expect(container.querySelector(COMPOSE)).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '全部收起' }));
    await waitFor(() => expect(container.querySelector(COMPOSE)).toBeNull());
    expect(screen.queryByRole('button', { name: '收起 (root)' })).toBeNull();
    const calls = load.mock.calls.length;

    box.focus();
    type(box, 'compose.ts');
    const opt = await screen.findByRole('option', { name: /src\/compose\.ts/ });
    expect(opt).toHaveAttribute('aria-selected', 'true');
    expect(opt).toHaveTextContent('文件');
    key(box, 'Enter');

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('已选中 src/compose.ts'),
    );
    expect(container.querySelector(COMPOSE)!.className).toContain('border-accent-strong');
    expect(screen.getByRole('button', { name: '收起 (root)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起 src' })).toBeInTheDocument();
    await waitFor(() => expect(sel.at(-1)).toMatchObject({ id: 'f:src/compose.ts' }));
    expect(load.mock.calls.length).toBe(calls); // 已加载的层直接展开,不再请求
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('键盘:/ 聚焦,↓↑ 循环移动 aria-activedescendant,回车定位当前项;Esc 先清空不取消选中,再按失焦', async () => {
    const { box } = await mount();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(box);
    type(box, 'r');
    const opts = await screen.findAllByRole('option');
    expect(opts.length).toBeGreaterThan(1);
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[0]!.id);
    key(box, 'ArrowDown');
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[1]!.id);
    key(box, 'ArrowUp');
    key(box, 'ArrowUp');
    expect(box.getAttribute('aria-activedescendant')).toBe(opts.at(-1)!.id);
    key(box, 'ArrowDown');
    key(box, 'ArrowDown');
    const want = screen
      .getAllByRole('option')[1]!
      .textContent!.replace(/^\S+\s*(模块|目录|文件)\s*/, '');
    key(box, 'Enter');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`已选中 ${want}`));
    // Esc 只清空搜索框,不冒泡成「取消选中」
    type(box, 'abc');
    key(box, 'Escape');
    expect(box).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('已选中');
    key(box, 'Escape');
    expect(document.activeElement).not.toBe(box);
  });

  it('输入框里输入 / 不会被快捷键吞掉', async () => {
    const { box } = await mount();
    box.focus();
    const ev = fireEvent.keyDown(box, { key: '/' });
    expect(ev).toBe(true); // 未 preventDefault
  });
});
