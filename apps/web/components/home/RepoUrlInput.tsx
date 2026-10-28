'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SAMPLE_REPOS, type SampleId } from '../../lib/fixtures';

/** 解析 https://github.com/owner/repo 或 owner/repo */
export function parseRepoInput(input: string): { owner: string; repo: string } | null {
  const m = input
    .trim()
    .match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export function sampleIdFor(owner: string, repo: string): SampleId | null {
  for (const [id, s] of Object.entries(SAMPLE_REPOS))
    if (
      s.owner.toLowerCase() === owner.toLowerCase() &&
      s.repo.toLowerCase() === repo.toLowerCase()
    )
      return id as SampleId;
  return null;
}

/**
 * 首页输入框。真实分析接口(T-003)接入前不调用后端:
 * 识别为示例仓库则跳转到 fixture 图页,其它仓库提示暂只支持示例。
 */
export function RepoUrlInput() {
  const router = useRouter();
  const [value, setValue] = useState('https://github.com/honojs/hono');
  const [hint, setHint] = useState<string | null>(null);
  return (
    <form
      className="w-full"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = parseRepoInput(value);
        if (!parsed) return setHint('请输入 GitHub 仓库地址,例如 https://github.com/honojs/hono');
        const id = sampleIdFor(parsed.owner, parsed.repo);
        if (!id) return setHint('分析接口尚未接入,目前只能打开下面的示例仓库(示例数据)。');
        router.push(`/a/${id}`);
      }}
    >
      <div className="flex items-center gap-2 rounded-hero border border-line bg-panel p-2 shadow-soft transition-shadow duration-200 ease-out focus-within:border-accent focus-within:shadow-pop">
        <input
          aria-label="GitHub 仓库地址"
          className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-[14px] text-fg outline-none placeholder:text-muted"
          placeholder="https://github.com/owner/repo"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setHint(null);
          }}
        />
        <button
          type="submit"
          className="rounded-control bg-accent px-4 py-2 text-[14px] font-medium text-white transition-colors duration-200 ease-out hover:bg-accent-hover"
        >
          分析
        </button>
      </div>
      <p role="status" className="mt-2 min-h-5 text-[13px] text-muted">
        {hint}
      </p>
    </form>
  );
}
