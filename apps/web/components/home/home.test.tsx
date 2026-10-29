import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROVIDER_DISCLOSURE, THIRD_PARTY_DISCLOSURE } from '../../lib/privacy/disclosure';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { DemoRepoList } from './DemoRepoList';
import { RepoUrlInput } from './RepoUrlInput';
import { analysisHref, parseRepoInput } from './useSubmitRepo';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const SHA = '382d29c485e67018c06e75ec7235130d0968522c';

describe('首页提交', () => {
  it('parseRepoInput / analysisHref', () => {
    expect(parseRepoInput('https://github.com/pmndrs/zustand.git')).toEqual({
      owner: 'pmndrs',
      repo: 'zustand',
    });
    expect(parseRepoInput(' honojs/hono ')).toEqual({ owner: 'honojs', repo: 'hono' });
    expect(parseRepoInput('https://gitlab.com/a/b')).toBeNull();
    expect(analysisHref(1, `1:${SHA}`, 'pmndrs/zustand')).toBe(
      `/a/1?job=1%3A${SHA}&repo=pmndrs%2Fzustand`,
    );
  });

  it('点击演示仓库 → POST /api/repos → 跳转到分析页', async () => {
    const createRepo = vi.fn(async () => ({
      repoId: 1,
      jobId: `1:${SHA}`,
      status: 'queued' as const,
      repo: 'pmndrs/zustand',
      commitSha: SHA,
    }));
    render(<DemoRepoList api={{ createRepo } as unknown as ApiClient} />);
    fireEvent.click(screen.getByRole('button', { name: 'pmndrs/zustand' }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/a/1?job=1%3A${SHA}&repo=pmndrs%2Fzustand`),
    );
    expect(createRepo).toHaveBeenCalledWith({ repoUrl: 'https://github.com/pmndrs/zustand' });
  });

  it('RATE_LIMITED → 中文提示', async () => {
    const createRepo = vi.fn(async () => {
      throw new ApiRequestError('RATE_LIMITED', '每个 IP 每小时最多提交 5 次', 429);
    });
    render(<DemoRepoList api={{ createRepo } as unknown as ApiClient} />);
    fireEvent.click(screen.getByRole('button', { name: 'honojs/hono' }));
    expect((await screen.findByRole('status')).textContent).toContain('提交太频繁了');
  });

  it('输入框下方显示公开仓库提示与第三方数据流披露(次要文字,关联到输入框)', () => {
    render(<RepoUrlInput api={{} as unknown as ApiClient} />);
    const notice = screen.getByText('只支持公开仓库。');
    const disclosure = screen.getByTestId('third-party-disclosure');
    expect(disclosure.textContent).toBe(THIRD_PARTY_DISCLOSURE);
    expect(disclosure.textContent).toContain('启用外部向量服务时');
    expect(disclosure.textContent).toContain('你输入的问题也会发送给阿里云百炼和大模型服务');
    expect(disclosure.textContent).toContain('不保证覆盖所有敏感内容');
    for (const el of [notice, disclosure]) expect(el).toHaveClass('text-muted');
    expect(screen.getByLabelText('GitHub 仓库地址')).toHaveAttribute(
      'aria-describedby',
      `${notice.id} ${disclosure.id}`,
    );
  });

  it('README 隐私与数据流一节与提交页披露文案逐字一致', () => {
    const readme = readFileSync(resolve(__dirname, '../../../../README.md'), 'utf8');
    // 只在「隐私与数据流」这一节内比对:文案出现在 README 别处(如 FAQ)不算通过
    const start = readme.indexOf('## 隐私与数据流');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = readme.slice(start + '## 隐私与数据流'.length);
    const next = rest.search(/^## /m);
    const section = next === -1 ? rest : rest.slice(0, next);
    expect(section).toContain(THIRD_PARTY_DISCLOSURE);
    // T-234:问答面板按提供方显示的三段文案也须逐字出现在本节
    for (const t of Object.values(PROVIDER_DISCLOSURE)) expect(section).toContain(t);
  });

  it('提交返回 422 REPO_NOT_PUBLIC → 表单下显示「只支持公开仓库」,不跳转、不当作网络错误', async () => {
    push.mockClear();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'REPO_NOT_PUBLIC', message: '只支持公开仓库' } }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
    );
    const api = createApiClient('http://api.test', fetchImpl as unknown as typeof fetch);
    render(<RepoUrlInput api={api} />);
    fireEvent.change(screen.getByLabelText('GitHub 仓库地址'), {
      target: { value: 'https://github.com/someone/private-repo' },
    });
    fireEvent.click(screen.getByRole('button', { name: '分析' }));
    const status = screen.getByRole('status');
    await waitFor(() => expect(status.textContent).toBe('只支持公开仓库。'));
    expect(status.textContent).not.toContain('无法连接分析服务');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '分析' })).not.toBeDisabled();
  });
});
