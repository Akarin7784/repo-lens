import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface RepoInfo {
  sizeKb: number | null;
  language: string | null;
}

/** 远端仓库访问;测试注入假实现 */
export interface GitHost {
  /** 解析 ref(缺省 HEAD)到 40 位 commit;不存在返回 null */
  lsRemote(url: string, ref?: string): Promise<string | null>;
  /** 尽力而为的仓库元信息(GitHub API),失败返回 null,不阻塞提交 */
  repoInfo(owner: string, name: string): Promise<RepoInfo | null>;
}

const SHA = /^[0-9a-f]{40}$/;

export function parseLsRemote(out: string, ref?: string): string | null {
  const refs = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name && SHA.test(sha)) refs.set(name, sha);
  }
  if (!ref) return refs.get('HEAD') ?? null;
  for (const n of [`refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`, ref])
    if (refs.has(n)) return refs.get(n)!;
  return null;
}

export function createGitHost(opts: { timeoutMs?: number; githubToken?: string } = {}): GitHost {
  const timeout = opts.timeoutMs ?? 15_000;
  return {
    async lsRemote(url, ref) {
      if (ref && SHA.test(ref)) return ref; // 直接给 commit 时由 worker 按 SHA fetch 校验
      try {
        const { stdout } = await run('git', ['ls-remote', '--', url, ...(ref ? [] : ['HEAD'])], {
          timeout,
          maxBuffer: 32 * 1024 * 1024,
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: '/nonexistent',
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_ASKPASS: '/bin/false',
          },
        });
        return parseLsRemote(stdout, ref);
      } catch {
        return null;
      }
    },
    async repoInfo(owner, name) {
      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'repo-lens',
            ...(opts.githubToken ? { authorization: `Bearer ${opts.githubToken}` } : {}),
          },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const j = (await res.json()) as { size?: number; language?: string | null };
        return { sizeKb: j.size ?? null, language: j.language ?? null };
      } catch {
        return null;
      }
    },
  };
}
