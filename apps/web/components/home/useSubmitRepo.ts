'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreateRepoRequestSchema } from '@repolens/shared';
import { createApiClient, type ApiClient } from '../../lib/api/client';
import { ERROR_TEXT, userMessageOf } from '../../lib/api/errors';

/** 解析 https://github.com/owner/repo 或 owner/repo */
export function parseRepoInput(input: string): { owner: string; repo: string } | null {
  const m = input
    .trim()
    .match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export const analysisHref = (repoId: number, jobId: string, repo: string) =>
  `/a/${repoId}?job=${encodeURIComponent(jobId)}&repo=${encodeURIComponent(repo)}`;

/**
 * 提交分析任务(POST /api/repos):先用 shared 的 CreateRepoRequestSchema 在本地校验,
 * 成功后跳到 /a/:repoId?job=…;失败显示错误码对应的中文提示。
 */
export function useSubmitRepo(api?: ApiClient) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  async function submit(input: string) {
    const parsed = parseRepoInput(input);
    const req = parsed && { repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}` };
    if (!req || !CreateRepoRequestSchema.safeParse(req).success)
      return setHint(ERROR_TEXT.INVALID_REPO_URL);
    setPending(true);
    setHint(null);
    try {
      const res = await (api ?? createApiClient()).createRepo(req);
      router.push(analysisHref(res.repoId, res.jobId, res.repo));
    } catch (e) {
      setHint(userMessageOf(e));
      setPending(false);
    }
  }
  return { submit, pending, hint, setHint };
}
