'use client';
import { useState } from 'react';
import { THIRD_PARTY_DISCLOSURE } from '../../lib/privacy/disclosure';
import type { ApiClient } from '../../lib/api/client';
import { useSubmitRepo } from './useSubmitRepo';

export { parseRepoInput } from './useSubmitRepo';

/** 首页输入框:提交到 POST /api/repos,成功后进入进度页 */
export function RepoUrlInput({ api }: { api?: ApiClient }) {
  const [value, setValue] = useState('https://github.com/honojs/hono');
  const { submit, pending, hint, setHint } = useSubmitRepo(api);
  return (
    <form
      className="w-full"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(value);
      }}
    >
      <div className="flex items-center gap-2 rounded-hero border border-line bg-panel p-2 shadow-soft transition-shadow duration-200 ease-out focus-within:border-accent focus-within:shadow-pop">
        <input
          aria-label="GitHub 仓库地址"
          aria-describedby="repo-url-notice third-party-disclosure"
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
          disabled={pending}
          className="rounded-control bg-accent-strong px-4 py-2 text-[14px] font-medium text-on-accent transition-colors duration-200 ease-out hover:bg-accent-strong-hover disabled:opacity-70"
        >
          {pending ? '提交中…' : '分析'}
        </button>
      </div>
      <p id="repo-url-notice" className="mt-2 px-1 text-[12px] text-muted">
        只支持公开仓库。
      </p>
      <p
        id="third-party-disclosure"
        data-testid="third-party-disclosure"
        className="mt-1 px-1 text-[12px] leading-5 text-muted"
      >
        {THIRD_PARTY_DISCLOSURE}
      </p>
      <p role="status" className="mt-1 min-h-5 text-[13px] text-muted">
        {hint}
      </p>
    </form>
  );
}
