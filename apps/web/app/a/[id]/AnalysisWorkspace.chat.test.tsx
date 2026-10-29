import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../../lib/api/client';
import { FakeES } from '../../../test/fakeEventSource';
import { createFakeTransport, DEMO_SCRIPT } from '../../../dev/fakeChatStream';

// GraphView 用桩:只记录 jumpRequest;逐层展开到可见层在 GraphView.api.test 的 jumpRequest 用例里覆盖
const stub = vi.hoisted(() => ({
  jumps: [] as string[],
  select: null as null | ((s: { id: string; deps: string[]; dependents: string[] } | null) => void),
}));
vi.mock('../../../components/graph/GraphView', () => ({
  GraphView: (p: {
    jumpRequest?: { id: string; n: number } | null;
    onSelectionChange?: typeof stub.select;
  }) => {
    stub.select = p.onSelectionChange ?? null;
    if (p.jumpRequest && stub.jumps.length < p.jumpRequest.n) stub.jumps.push(p.jumpRequest.id);
    return <div data-testid="graph-stub" />;
  },
}));
import { AnalysisWorkspace } from './AnalysisWorkspace';

const jobId = '1:382d29c485e67018c06e75ec7235130d0968522c';

describe('<AnalysisWorkspace> 问答联动(T-230,假流)', () => {
  it('右栏「问答」标签;点击引用 → 切回详情并请求图跳转到该文件节点(选中后详情加载文件)', async () => {
    const api = {
      getRepoStatus: vi.fn(),
      getGraph: vi.fn(() => new Promise(() => {})),
      getNodeDetail: vi.fn(() => new Promise(() => {})),
      jobEventsUrl: (id: string) => `/api/jobs/${id}/events`,
    } as unknown as ApiClient;
    render(
      <AnalysisWorkspace
        repoId={1}
        jobId={jobId}
        api={api}
        eventSource={(u) => new FakeES(u)}
        chatTransport={createFakeTransport(DEMO_SCRIPT)}
      />,
    );
    act(() =>
      FakeES.last!.emit('graph_ready', { jobId, repoId: 1, graphUrl: '/api/repos/1/graph' }),
    );
    await screen.findByTestId('graph-stub');
    fireEvent.click(screen.getByRole('tab', { name: '问答' }));
    expect(screen.getByTestId('detail-aside').dataset.drawer).toBe('open');
    fireEvent.change(screen.getByRole('textbox', { name: '提问' }), { target: { value: '问' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const chip = await screen.findByRole('button', { name: /src\/server\/app\.ts:22–31/ });
    fireEvent.click(chip);
    expect(stub.jumps).toEqual(['f:src/server/app.ts']);
    expect(screen.getByRole('tab', { name: '详情' })).toHaveAttribute('aria-selected', 'true');
    // GraphView 选中后回调 → 详情面板加载该文件
    act(() => stub.select!({ id: 'f:src/server/app.ts', deps: [], dependents: [] }));
    await waitFor(() =>
      expect(api.getNodeDetail).toHaveBeenCalledWith(1, 'f:src/server/app.ts', expect.anything()),
    );
    // 切回问答,对话仍在(面板常驻挂载)
    fireEvent.click(screen.getByRole('tab', { name: '问答' }));
    expect(screen.getByText(/假流生成的示例回答/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\[\[S\d/);
  });
});
