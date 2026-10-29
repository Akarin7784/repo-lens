import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisWorkspace } from './AnalysisWorkspace';
import { ApiRequestError } from '../../../lib/api/errors';
import type { ApiClient } from '../../../lib/api/client';
import { FakeES } from '../../../test/fakeEventSource';

const SHA = '382d29c485e67018c06e75ec7235130d0968522c';
const jobId = `1:${SHA}`;

function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    createRepo: vi.fn(),
    getRepoStatus: vi.fn(),
    getGraph: vi.fn(() => new Promise(() => {})),
    jobEventsUrl: (id: string) => `/api/jobs/${id}/events`,
    ...over,
  } as unknown as ApiClient;
}

describe('<AnalysisWorkspace>', () => {
  it('SSE 进度:进度条随 progress 前进;stage_error 以 alert 显示;不出现「示例数据」', async () => {
    const api = fakeApi();
    render(
      <AnalysisWorkspace
        repoId={1}
        jobId={jobId}
        repoLabel="pmndrs/zustand"
        api={api}
        eventSource={(u) => new FakeES(u)}
      />,
    );
    const es = FakeES.last!;
    expect(es.url).toBe(`/api/jobs/${jobId}/events`);
    act(() =>
      es.emit('progress', { jobId, stage: 'parsing', progress: 42, message: '解析 8/18 文件' }),
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText('解析 8/18 文件')).toBeTruthy();
    act(() => es.emit('stage_error', { jobId, stage: 'parsing', message: 'tree-sitter 崩溃' }));
    act(() => es.emit('done', { jobId, status: 'failed' }));
    expect(screen.getByRole('alert').textContent).toContain('tree-sitter 崩溃');
    expect(screen.getByText('分析失败')).toBeTruthy();
    expect(screen.queryByText('示例数据')).toBeNull();
    expect(es.closed).toBe(true);
    expect(api.getGraph).not.toHaveBeenCalled();
  });

  it('graph_ready 后才开始取根层图', async () => {
    const api = fakeApi();
    render(
      <AnalysisWorkspace repoId={1} jobId={jobId} api={api} eventSource={(u) => new FakeES(u)} />,
    );
    act(() =>
      FakeES.last!.emit('graph_ready', { jobId, repoId: 1, graphUrl: '/api/repos/1/graph' }),
    );
    await waitFor(() => expect(api.getGraph).toHaveBeenCalledWith(1, null));
  });

  it('T-224c:进行中横幅渲染进图左上的提示栏容器(与截断提示同一纵向容器),不拦截点击', async () => {
    const api = fakeApi();
    render(
      <AnalysisWorkspace repoId={1} jobId={jobId} api={api} eventSource={(u) => new FakeES(u)} />,
    );
    act(() =>
      FakeES.last!.emit('graph_ready', { jobId, repoId: 1, graphUrl: '/api/repos/1/graph' }),
    );
    act(() => FakeES.last!.emit('progress', { jobId, stage: 'summarizing', progress: 61.6 }));
    const banner = await screen.findByTestId('progress-banner');
    expect(banner).toHaveTextContent('后续阶段进行中(62%)');
    const box = screen.getByTestId('graph-top-notices');
    expect(banner.parentElement).toBe(box);
    expect(box.className).toContain('flex-col');
    expect(banner.className).toContain('pointer-events-none');
    expect(banner.className).not.toContain('absolute');
    act(() => FakeES.last!.emit('done', { jobId, status: 'done' }));
    expect(screen.queryByTestId('progress-banner')).toBeNull();
  });

  it('非正整数 repo id → 后端 400 BAD_REQUEST → 中文提示', async () => {
    const api = fakeApi({
      getRepoStatus: vi.fn(async () => {
        throw new ApiRequestError('BAD_REQUEST', 'invalid repo id', 400);
      }),
    });
    render(<AnalysisWorkspace repoId={0} api={api} />);
    expect(await screen.findByText(/请求参数不合法/)).toBeTruthy();
  });
});
