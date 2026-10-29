import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../../lib/api/client';
import { FakeES } from '../../../test/fakeEventSource';

// 用桩替换 GraphView:只关心工作区如何响应选中与「关闭」,图本身在 GraphView 测试里覆盖
const stub = vi.hoisted(() => ({
  select: null as null | ((s: { id: string; deps: string[]; dependents: string[] } | null) => void),
  clear: 0,
}));
vi.mock('../../../components/graph/GraphView', () => ({
  GraphView: (p: { onSelectionChange?: typeof stub.select; clearRequest?: number }) => {
    stub.select = p.onSelectionChange ?? null;
    if ((p.clearRequest ?? 0) > stub.clear) {
      stub.clear = p.clearRequest!;
      queueMicrotask(() => stub.select?.(null)); // 与真实 GraphView 一致:取消选中后回调 null
    }
    return <div data-testid="graph-stub" />;
  },
}));
import { AnalysisWorkspace } from './AnalysisWorkspace';

const SHA = '382d29c485e67018c06e75ec7235130d0968522c';
const jobId = `1:${SHA}`;

describe('<AnalysisWorkspace> 详情面板窄屏抽屉(T-222d)', () => {
  it('未选中:aside 带 hidden(窄屏不占位)+ md:block;选中:底部抽屉(文档流内,高 55vh);点「关闭」收起', async () => {
    const api = {
      getRepoStatus: vi.fn(),
      getGraph: vi.fn(() => new Promise(() => {})),
      getNodeDetail: vi.fn(() => new Promise(() => {})),
      jobEventsUrl: (id: string) => `/api/jobs/${id}/events`,
    } as unknown as ApiClient;
    render(
      <AnalysisWorkspace repoId={1} jobId={jobId} api={api} eventSource={(u) => new FakeES(u)} />,
    );
    act(() =>
      FakeES.last!.emit('graph_ready', { jobId, repoId: 1, graphUrl: '/api/repos/1/graph' }),
    );
    await screen.findByTestId('graph-stub');
    const aside = screen.getByTestId('detail-aside');
    expect(aside.dataset.drawer).toBe('closed');
    expect(aside.className).toMatch(/(^| )hidden( |$)/);
    expect(aside.className).toContain('md:block');
    expect(screen.queryByRole('button', { name: '关闭详情' })).toBeNull();

    act(() => stub.select!({ id: 'f:src/a.ts', deps: [], dependents: [] }));
    await waitFor(() => expect(aside.dataset.drawer).toBe('open'));
    expect(aside.className).toContain('h-[55vh]');
    expect(aside.className).toContain('max-h-[55vh]');
    expect(aside.className).toContain('md:w-[360px]');
    expect(aside.className).not.toMatch(/(^| )hidden( |$)/);
    expect(screen.getByTestId('node-detail')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
    await waitFor(() => expect(aside.dataset.drawer).toBe('closed'));
    expect(screen.queryByTestId('node-detail')).toBeNull();
  });
});
