import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FILE_MAX_LINES, FileContentSchema, type FileContent } from '@repolens/shared';
import { CodePreview, prepareLines } from './CodePreview';
import { NodeDetail } from './NodeDetail';
import { ApiRequestError, toApiError } from '../../lib/api/errors';
import {
  PREVIEW_MAX_LINES,
  PREVIEW_MAX_LINE_CHARS,
  langOf,
  shikiHighlight,
  type Highlighter,
} from '../../lib/preview/highlight';

const SHA = 'a'.repeat(40);
const file = (over: Partial<FileContent> = {}): FileContent => {
  const content = over.content === undefined ? 'const a = 1;\nexport { a };' : over.content;
  const n = content ? content.split('\n').length : 0;
  return FileContentSchema.parse({
    path: 'src/a.ts',
    commitSha: SHA,
    totalLines: n,
    start: n ? 1 : null,
    end: n ? n : null,
    hasMore: false,
    content,
    excluded: null,
    ...over,
  });
};
const plain = vi.fn(async () => {
  throw new Error('no shiki in this test');
});
const okHl = async (code: string) =>
  code.split('\n').map((l) => [{ content: l, color: '#123456' }]);
const notReady = (reason?: unknown) =>
  toApiError(409, {
    error: {
      code: 'REPO_NOT_READY',
      message: 'x',
      ...(reason !== undefined ? { details: { reason } } : {}),
    },
  });
const renderP = (getFile: () => Promise<FileContent>, highlighter: Highlighter = okHl) =>
  render(
    <CodePreview
      repoId={2}
      path="src/a.ts"
      api={{ getFile: vi.fn(getFile) }}
      highlighter={highlighter}
    />,
  );

describe('<CodePreview> 状态(T-223)', () => {
  it('正常:加载中 → 高亮代码 + 行号', async () => {
    renderP(async () => file());
    expect(screen.getByTestId('preview-loading')).toBeTruthy();
    const code = await screen.findByTestId('preview-code');
    await waitFor(() => expect(code.dataset.highlighted).toBe('true'));
    expect(code.textContent).toContain('const a = 1;');
    expect(code.textContent).toMatch(/^1const a = 1;2export/);
    expect(code.querySelector('.shiki-tok')).toBeTruthy();
  });

  it.each([
    ['sensitive', '疑似敏感文件(密钥、凭据等),为安全起见不展示内容,也不会发送给模型服务。'],
    ['too-large', '文件过大,不展示内容。'],
    ['binary', '二进制文件,无法预览。'],
  ] as const)('已排除 %s:显示「已排除」和原因,不是错误', async (reason, text) => {
    renderP(async () =>
      file({
        content: null,
        totalLines: null,
        start: null,
        end: null,
        excluded: { reason, notice: 'n' },
      }),
    );
    const box = await screen.findByTestId('preview-excluded');
    expect(box.textContent).toContain('已排除');
    expect(box.textContent).toContain(text);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('preview-code')).toBeNull();
  });

  it('已排除未知 reason(绕过 schema 构造):回退通用文案', async () => {
    renderP(
      async () =>
        ({ ...file({ content: null }), excluded: { reason: 'weird', notice: 'n' } }) as never,
    );
    expect((await screen.findByTestId('preview-excluded')).textContent).toContain(
      '该文件已被排除。',
    );
  });

  it('404 FILE_NOT_FOUND 与 REPO_NOT_FOUND 文案不同,且不给重试', async () => {
    renderP(async () => {
      throw toApiError(404, { error: { code: 'FILE_NOT_FOUND', message: 'm' } });
    });
    const e = await screen.findByTestId('preview-error');
    expect(e.textContent).toBe('文件在这个提交里不存在。');
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('REPO_NOT_FOUND 显示仓库不存在文案', async () => {
    renderP(async () => {
      throw toApiError(404, { error: { code: 'REPO_NOT_FOUND', message: '仓库不存在' } });
    });
    expect((await screen.findByTestId('preview-error')).textContent).toContain(
      '仓库不存在、不可访问',
    );
  });

  it.each([
    ['GRAPH_NOT_READY', '分析还没完成,完成后可预览。'],
    ['SNAPSHOT_MISSING', '源码快照已被清理,需要重新分析才能预览。'],
    ['REPOS_DIR_NOT_CONFIGURED', '服务端未配置源码目录,暂时无法预览。'],
    [undefined, '源码暂时不可预览(服务端尚未就绪),请稍后再试。'],
    ['FUTURE_REASON', '源码暂时不可预览(服务端尚未就绪),请稍后再试。'],
    [42, '源码暂时不可预览(服务端尚未就绪),请稍后再试。'],
  ])('409 details.reason=%s', async (reason, text) => {
    renderP(async () => {
      throw notReady(reason);
    });
    expect((await screen.findByTestId('preview-error')).textContent).toContain(text);
  });

  it('未知 details.reason 仍识别为 REPO_NOT_READY(不是 INVALID_RESPONSE)', () => {
    const e = notReady('FUTURE_REASON');
    expect(e.code).toBe('REPO_NOT_READY');
    expect(e.reason).toBe('FUTURE_REASON');
    expect(notReady(42).reason).toBeUndefined();
  });

  it('网络错误:显示重试,重试成功', async () => {
    const getFile = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError('NETWORK', 'down'))
      .mockResolvedValueOnce(file());
    render(<CodePreview repoId={2} path="src/a.ts" api={{ getFile }} highlighter={okHl} />);
    await screen.findByTestId('preview-error');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('preview-code')).toBeTruthy();
    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it('切换文件:abort 旧请求,旧响应不覆盖新文件', async () => {
    const pend: { resolve: (f: FileContent) => void; signal: AbortSignal }[] = [];
    const getFile = vi.fn(
      (_r: number, _p: string, signal?: AbortSignal) =>
        new Promise<FileContent>((resolve) => pend.push({ resolve, signal: signal! })),
    );
    const { rerender } = render(
      <CodePreview repoId={2} path="src/a.ts" api={{ getFile }} highlighter={okHl} />,
    );
    rerender(<CodePreview repoId={2} path="src/b.ts" api={{ getFile }} highlighter={okHl} />);
    expect(pend[0]!.signal.aborted).toBe(true);
    await act(async () => pend[1]!.resolve(file({ path: 'src/b.ts', content: 'NEW' })));
    await act(async () => pend[0]!.resolve(file({ content: 'OLD' })));
    expect(screen.getByTestId('preview-code').textContent).toContain('NEW');
    expect(screen.getByTestId('preview-code').textContent).not.toContain('OLD');
  });

  it('Shiki 加载失败:降级为纯文本 <pre> 并提示', async () => {
    renderP(async () => file(), plain);
    const code = await screen.findByTestId('preview-code');
    expect(await screen.findByText('语法高亮加载失败,已按纯文本显示。')).toBeTruthy();
    expect(code.tagName).toBe('PRE');
    expect(code.dataset.highlighted).toBe('false');
    expect(code.textContent).toContain('const a = 1;');
  });

  it('未知后缀按纯文本,不调用高亮器', async () => {
    const hl = vi.fn(okHl);
    render(
      <CodePreview
        repoId={2}
        path="LICENSE"
        api={{ getFile: async () => file() }}
        highlighter={hl}
      />,
    );
    await screen.findByTestId('preview-code');
    expect(hl).not.toHaveBeenCalled();
    expect(langOf('a/b.tsx')).toBe('tsx');
    expect(langOf('Makefile')).toBeNull();
  });
});

describe('安全渲染(T-223)', () => {
  const EVIL =
    '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n</pre><script>x()</script>';
  it.each([
    ['注入高亮器', okHl],
    ['纯文本', plain],
  ])('%s:恶意内容只作文本显示,DOM 中无 script/img', async (_n, hl) => {
    const { container } = render(
      <CodePreview
        repoId={2}
        path="evil.html"
        api={{ getFile: async () => file({ content: EVIL }) }}
        highlighter={hl}
      />,
    );
    const code = await screen.findByTestId('preview-code');
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(code.textContent).toContain('<script>alert(1)</script>');
    expect(code.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(code.textContent).toContain('</pre><script>x()</script>');
  });

  it('真实 Shiki(html/markdown):token 以文本节点渲染,无 script/img', async () => {
    for (const path of ['evil.html', 'evil.md']) {
      const { container, unmount } = render(
        <CodePreview
          repoId={2}
          path={path}
          api={{ getFile: async () => file({ content: EVIL }) }}
          highlighter={shikiHighlight}
        />,
      );
      const code = await screen.findByTestId('preview-code');
      await waitFor(() => expect(code.dataset.highlighted).toBe('true'), { timeout: 10000 });
      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
      expect(code.textContent).toContain('<img src=x onerror=alert(1)>');
      unmount();
    }
  }, 20000);
});

describe('大文件与长行(T-223)', () => {
  it('前端行数上限 = 2000,与接口 FILE_MAX_LINES 一致', () => {
    expect(PREVIEW_MAX_LINES).toBe(2000);
    expect(PREVIEW_MAX_LINES).toBe(FILE_MAX_LINES);
    expect(PREVIEW_MAX_LINE_CHARS).toBe(2000);
  });

  it('prepareLines:超过行数上限截到 N 行;超长行截断并标记', () => {
    const big = Array.from({ length: PREVIEW_MAX_LINES + 5 }, (_, i) => `l${i}`).join('\n');
    const r = prepareLines(big);
    expect(r.lines).toHaveLength(PREVIEW_MAX_LINES);
    expect(r.linesCut).toBe(true);
    const long = prepareLines('a\n' + 'x'.repeat(PREVIEW_MAX_LINE_CHARS + 10));
    expect(long.longLine).toBe(true);
    expect(long.lines[1]).toHaveLength(PREVIEW_MAX_LINE_CHARS);
  });

  it('接口 hasMore + 总行数:顶部合并为一条「仅显示前 N 行」提示', async () => {
    const content = Array.from({ length: 2000 }, (_, i) => `l${i}`).join('\n');
    renderP(async () => file({ content, hasMore: true, totalLines: 5000, start: 1, end: 2000 }));
    const notes = await screen.findByTestId('preview-notes');
    expect(notes.textContent).toBe('仅显示前 2000 行(共 5000 行)。');
  });

  it('前端行数上限兜底(接口未截断也生效)', async () => {
    const content = Array.from({ length: PREVIEW_MAX_LINES + 1 }, (_, i) => `l${i}`).join('\n');
    renderP(async () => file({ content }));
    expect((await screen.findByTestId('preview-notes')).textContent).toContain(
      `仅显示前 ${PREVIEW_MAX_LINES} 行`,
    );
    expect(screen.getByTestId('preview-code').textContent).not.toContain(`l${PREVIEW_MAX_LINES}`);
  });

  it('超长行:不调用高亮器,截断显示并提示', async () => {
    const hl = vi.fn(okHl);
    render(
      <CodePreview
        repoId={2}
        path="src/a.ts"
        api={{
          getFile: async () => file({ content: 'ok\n' + 'y'.repeat(PREVIEW_MAX_LINE_CHARS + 500) }),
        }}
        highlighter={hl}
      />,
    );
    expect((await screen.findByTestId('preview-notes')).textContent).toContain('超长行');
    expect(hl).not.toHaveBeenCalled();
    expect(screen.getByTestId('preview-code').textContent).not.toContain(
      'y'.repeat(PREVIEW_MAX_LINE_CHARS + 1),
    );
  });

  it('行号从接口 start 起算', async () => {
    renderP(async () => file({ content: 'a\nb', start: 41, end: 42, totalLines: 100 }));
    expect((await screen.findByTestId('preview-code')).textContent).toMatch(/^41a42b/);
  });
});

describe('NodeDetail 里的「查看代码」入口(T-223)', () => {
  const detail = (id: string, kind: 'file' | 'dir' | 'module' | 'external', path: string) => ({
    id,
    kind,
    path,
    summary: 's',
    exports: [],
    loc: 1,
    inDegree: 0,
    outDegree: 0,
    topDependents: [],
    summarySource: null,
    inCycle: false,
  });
  it('文件节点可展开/收起,aria-expanded 正确;切换节点后收起重置', async () => {
    const api = {
      getNodeDetail: vi.fn(
        async (_r: number, id: string) => detail(id, 'file', id.slice(2)) as never,
      ),
      getFile: vi.fn(async () => file()),
    };
    const { rerender } = render(
      <NodeDetail repoId={2} nodeId="f:src/a.ts" api={api} onJump={() => {}} />,
    );
    const btn = await screen.findByRole('button', { name: '查看代码' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(api.getFile).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: '收起代码' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await screen.findByTestId('preview-code');
    rerender(<NodeDetail repoId={2} nodeId="f:src/b.ts" api={api} onJump={() => {}} />);
    expect(await screen.findByRole('button', { name: '查看代码' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByTestId('code-preview')).toBeNull();
  });

  it.each([
    ['d:src', 'dir'],
    ['m:core', 'module'],
    ['x:react', 'external'],
  ] as const)('%s(%s)不显示入口', async (id, kind) => {
    const api = {
      getNodeDetail: vi.fn(async () => detail(id, kind, id.slice(2)) as never),
      getFile: vi.fn(),
    };
    render(<NodeDetail repoId={2} nodeId={id} api={api} onJump={() => {}} />);
    await screen.findByText('s');
    expect(screen.queryByRole('button', { name: '查看代码' })).toBeNull();
  });
});
