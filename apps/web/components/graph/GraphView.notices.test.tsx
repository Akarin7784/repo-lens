import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GraphNode } from '@repolens/shared';
import { GraphView } from './GraphView';
import type { GraphSource } from '../../lib/graph/source';
import type { GraphSlice } from '../../lib/graph/hierarchy';
import { createInlineEngine } from '../../lib/layout/elk';

/**
 * T-224c:进度横幅(topNotice)与截断提示的避让。
 * jsdom 不做布局,这里只断言 DOM 结构与类名:两者是同一个纵向 flex 容器的子元素、按顺序排列,
 * 自身都不再绝对定位(不会叠在同一坐标上);容器不拦截点击,层级低于搜索框。
 * 像素层面的不重叠见 docs/assets/T-224c/ 的真实浏览器截图与 playwright 包围盒检查。
 */
const SHA = 'a'.repeat(40);
const mod = (id: string): GraphNode =>
  ({ id, type: 'module', parentId: null, label: id.slice(2), path: id.slice(2) }) as GraphNode;
const truncatedRoot = (): GraphSource => ({
  repoLabel: 't/t',
  loadChildren: vi.fn(async (): Promise<GraphSlice> => ({
    nodes: [mod('m:a'), mod('m:b')],
    edges: [],
    meta: { repoId: 1, commitSha: SHA, parentId: null, language: 'typescript' },
    truncated: true,
  })),
});
const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

describe('<GraphView> 顶部提示栏(T-224c)', () => {
  it('横幅与截断提示同在一个 flex-col 容器里,横幅在前,子元素都不绝对定位', async () => {
    const engine = await createInlineEngine();
    render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView
          source={truncatedRoot()}
          owner="t"
          repo="t"
          engine={engine}
          topNotice={
            <div data-testid="progress-banner" className="pointer-events-none">
              进行中
            </div>
          }
        />
      </div>,
    );
    const notice = await screen.findByTestId('truncated-notice');
    const banner = screen.getByTestId('progress-banner');
    const box = screen.getByTestId('graph-top-notices');
    expect(notice.parentElement).toBe(box);
    expect(banner.parentElement).toBe(box);
    expect([...box.children]).toEqual([banner, notice]);
    const c = classes(box);
    for (const k of [
      'absolute',
      'flex',
      'flex-col',
      'gap-2',
      'pointer-events-none',
      'z-10',
      'top-14',
    ])
      expect(c).toContain(k);
    expect(classes(notice)).not.toContain('absolute');
    expect(classes(notice)).toContain('pointer-events-auto');
    expect(classes(banner)).toContain('pointer-events-none');
    // 搜索框容器层级高于提示栏:下拉不会被横幅或截断提示盖住
    const search = screen.getByRole('combobox').closest('.absolute')!;
    expect(classes(search)).toContain('z-20');
  });

  it('只有截断、没有横幅时仍在同一容器;两者都没有时不渲染容器', async () => {
    const engine = await createInlineEngine();
    const { unmount } = render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView source={truncatedRoot()} owner="t" repo="t" engine={engine} />
      </div>,
    );
    const notice = await screen.findByTestId('truncated-notice');
    expect(notice.parentElement).toBe(screen.getByTestId('graph-top-notices'));
    expect(screen.getByTestId('graph-top-notices').children).toHaveLength(1);
    unmount();

    const plain: GraphSource = {
      repoLabel: 't/t',
      loadChildren: vi.fn(async (): Promise<GraphSlice> => ({
        nodes: [mod('m:a')],
        edges: [],
        meta: { repoId: 1, commitSha: SHA, parentId: null, language: 'typescript' },
        truncated: false,
      })),
    };
    render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView source={plain} owner="t" repo="t" engine={engine} />
      </div>,
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('当前显示 1 节点'));
    expect(screen.queryByTestId('graph-top-notices')).toBeNull();
  });
});
