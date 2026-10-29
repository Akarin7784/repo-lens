import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NodeDetail as NodeDetailData } from '@repolens/shared';
import { NodeDetailSchema } from '@repolens/shared';
import { NodeDetail, breadcrumbs } from './NodeDetail';
import { ApiRequestError } from '../../lib/api/errors';

/** 仅测试用 fixture:形状与 shared NodeDetailSchema 一致(下方先过 schema) */
const detail = (over: Partial<NodeDetailData> = {}): NodeDetailData =>
  NodeDetailSchema.parse({
    id: 'f:src/compose.ts',
    kind: 'file',
    path: 'src/compose.ts',
    summary: '按洋葱模型串联中间件。',
    exports: ['compose'],
    loc: 72,
    inDegree: 5,
    outDegree: 2,
    topDependents: ['f:src/hono-base.ts'],
    ...over,
  });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

describe('<NodeDetail>', () => {
  it('加载中 → 显示摘要、类型、指标、导出与 topDependents;点击列表触发跳转', async () => {
    const onJump = vi.fn();
    const api = { getNodeDetail: vi.fn(async () => detail()) };
    render(
      <NodeDetail
        repoId={1}
        nodeId="f:src/compose.ts"
        api={api}
        neighbors={{ deps: ['f:src/utils/url.ts'], dependents: [] }}
        onJump={onJump}
      />,
    );
    expect(screen.getByLabelText('加载中')).toBeTruthy();
    expect(await screen.findByText('按洋葱模型串联中间件。')).toBeTruthy();
    expect(api.getNodeDetail).toHaveBeenCalledWith(1, 'f:src/compose.ts', expect.any(AbortSignal));
    expect(screen.getByText('文件')).toBeTruthy();
    expect(screen.getByText('72')).toBeTruthy();
    expect(screen.getByText('compose')).toBeTruthy();
    fireEvent.click(screen.getByText('src/hono-base.ts'));
    expect(onJump).toHaveBeenCalledWith('f:src/hono-base.ts');
    fireEvent.click(screen.getByText('src/utils/url.ts'));
    expect(onJump).toHaveBeenCalledWith('f:src/utils/url.ts');
    // 面包屑父级可点
    fireEvent.click(screen.getByRole('button', { name: 'src' }));
    expect(onJump).toHaveBeenCalledWith('d:src');
  });

  it('失败显示错误与重试,重试成功后显示内容', async () => {
    const api = {
      getNodeDetail: vi
        .fn()
        .mockRejectedValueOnce(new ApiRequestError('INTERNAL', 'boom', 500))
        .mockResolvedValueOnce(detail()),
    };
    render(<NodeDetail repoId={1} nodeId="f:src/compose.ts" api={api} onJump={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toContain('服务内部错误');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('按洋葱模型串联中间件。')).toBeTruthy();
    expect(api.getNodeDetail).toHaveBeenCalledTimes(2);
  });

  it('summary 为 null 显示骨架屏,doneTick 变化后重取;空字符串显示空状态', async () => {
    const api = {
      getNodeDetail: vi
        .fn()
        .mockResolvedValueOnce(detail({ summary: null }))
        .mockResolvedValueOnce(detail({ summary: '' })),
    };
    const { rerender } = render(
      <NodeDetail repoId={1} nodeId="f:src/compose.ts" api={api} doneTick={0} onJump={() => {}} />,
    );
    expect(await screen.findByText(/摘要生成中/)).toBeTruthy();
    expect(screen.getByTestId('summary-skeleton')).toBeTruthy();
    rerender(
      <NodeDetail repoId={1} nodeId="f:src/compose.ts" api={api} doneTick={1} onJump={() => {}} />,
    );
    expect(await screen.findByText('暂无摘要。')).toBeTruthy();
    expect(api.getNodeDetail).toHaveBeenCalledTimes(2);
  });

  it('切换节点:取消旧请求,过期响应不覆盖新节点', async () => {
    const a = deferred<NodeDetailData>();
    const b = deferred<NodeDetailData>();
    const signals: AbortSignal[] = [];
    const api = {
      getNodeDetail: vi.fn((_r: number, id: string, s?: AbortSignal) => {
        signals.push(s!);
        return id === 'f:a.ts' ? a.promise : b.promise;
      }),
    };
    const { rerender } = render(
      <NodeDetail repoId={1} nodeId="f:a.ts" api={api} onJump={() => {}} />,
    );
    rerender(<NodeDetail repoId={1} nodeId="f:b.ts" api={api} onJump={() => {}} />);
    expect(signals[0]!.aborted).toBe(true);
    b.resolve(detail({ id: 'f:b.ts', path: 'b.ts', summary: 'B 的摘要' }));
    expect(await screen.findByText('B 的摘要')).toBeTruthy();
    a.resolve(detail({ id: 'f:a.ts', path: 'a.ts', summary: 'A 的摘要' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('A 的摘要')).toBeNull();
    expect(screen.getByText('B 的摘要')).toBeTruthy();
  });

  it('breadcrumbs:父级给 d: id,自身不可点;根与外部包不拆分', () => {
    expect(breadcrumbs('f:src/a/b.ts', 'src/a/b.ts')).toEqual([
      { label: 'src', id: 'd:src' },
      { label: 'a', id: 'd:src/a' },
      { label: 'b.ts', id: null },
    ]);
    expect(breadcrumbs('m:.', '.')).toEqual([{ label: '.', id: null }]);
    expect(breadcrumbs('x:react', 'react')).toEqual([{ label: 'react', id: null }]);
  });
});

describe('ApiClient.getNodeDetail', () => {
  it('nodeId 整体编码并过 NodeDetailSchema', async () => {
    const { createApiClient } = await import('../../lib/api/client');
    const f = vi.fn<(url: string) => Promise<Response>>(
      async () => new Response(JSON.stringify(detail()), { status: 200 }),
    );
    const api = createApiClient('', f as unknown as typeof fetch);
    await waitFor(async () =>
      expect((await api.getNodeDetail(3, 'f:src/compose.ts')).loc).toBe(72),
    );
    expect(f.mock.calls[0]![0]).toBe('/api/repos/3/nodes/f%3Asrc%2Fcompose.ts');
  });
});
