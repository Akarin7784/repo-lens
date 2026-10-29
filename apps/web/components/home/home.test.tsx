import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { DemoRepoList } from './DemoRepoList';
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
});
