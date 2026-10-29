'use client';
import type { ApiClient } from '../../lib/api/client';
import { useSubmitRepo } from './useSubmitRepo';

/** 演示仓库:点击即提交真实分析(与输入框同一条链路) */
export const DEMO_REPOS = [
  { repo: 'honojs/hono', blurb: '主演示:中等规模的 Web 框架' },
  { repo: 'pmndrs/zustand', blurb: '小规模:快速出图' },
  { repo: 'colinhacks/zod', blurb: '中等规模的校验库' },
] as const;

export function DemoRepoList({ api }: { api?: ApiClient }) {
  const { submit, pending, hint } = useSubmitRepo(api);
  return (
    <div className="flex flex-col items-center gap-2">
      <ul className="flex flex-wrap justify-center gap-2">
        {DEMO_REPOS.map((d) => (
          <li key={d.repo}>
            <button
              type="button"
              title={d.blurb}
              disabled={pending}
              onClick={() => void submit(d.repo)}
              className="inline-flex items-center rounded-full border border-line bg-panel px-3 py-1 font-mono text-[13px] text-fg transition-colors duration-200 ease-out hover:border-accent hover:text-accent-strong-hover disabled:opacity-70"
            >
              {d.repo}
            </button>
          </li>
        ))}
      </ul>
      {hint && (
        <p role="status" className="text-[13px] text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
