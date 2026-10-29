import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** execFile 的可注入替身(测试用假 spawn):成功返回 stdout,失败按 child_process 语义抛错 */
export type GitExec = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

/**
 * git 本身不可用:二进制不存在(ENOENT)或 ls-remote 超时被杀。这不是「仓库不存在」,
 * API 映射为 503 GIT_UNAVAILABLE 并记日志,不再吞成 404。
 */
export class GitUnavailableError extends Error {
  constructor(
    readonly reason: 'GIT_MISSING' | 'GIT_TIMEOUT' | 'GIT_OUTPUT_TOO_LARGE',
    readonly errno?: string,
  ) {
    super(
      reason === 'GIT_MISSING'
        ? 'git 未安装或不在 PATH 中'
        : reason === 'GIT_TIMEOUT'
          ? 'git ls-remote 超时'
          : 'git ls-remote 输出超过上限',
    );
    this.name = 'GitUnavailableError';
  }
}

/** child_process 错误分类:ENOENT → GIT_MISSING;超 maxBuffer → GIT_OUTPUT_TOO_LARGE;超时(被 timeout 杀掉 / ETIMEDOUT)→ GIT_TIMEOUT;其他(退出码非 0 等)→ null */
export function classifyGitError(err: unknown): GitUnavailableError | null {
  const e = (err ?? {}) as { code?: unknown; killed?: boolean; signal?: string | null };
  if (e.code === 'ENOENT') return new GitUnavailableError('GIT_MISSING', 'ENOENT');
  // 超 maxBuffer 时 Node 也会以 killed+SIGTERM 杀掉子进程,必须先于超时判断,否则被误报为 GIT_TIMEOUT
  if (
    e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    (typeof e.code === 'string' && /MAXBUFFER/i.test(e.code))
  )
    return new GitUnavailableError('GIT_OUTPUT_TOO_LARGE', e.code);
  if (e.code === 'ETIMEDOUT' || (e.killed === true && e.signal))
    return new GitUnavailableError('GIT_TIMEOUT', typeof e.code === 'string' ? e.code : e.signal!);
  return null;
}

export interface RepoInfo {
  sizeKb: number | null;
  language: string | null;
  /** GitHub `private` 字段;拿不到时为 null */
  private: boolean | null;
}

/** 远端仓库访问;测试注入假实现 */
export interface GitHost {
  /**
   * 解析 ref(缺省 HEAD)到 40 位 commit;仓库/ref 不存在(git 正常退出但无匹配,或非 0 退出)返回 null。
   * git 未安装或超时抛 GitUnavailableError,调用方不得当成 404。
   */
  lsRemote(url: string, ref?: string): Promise<string | null>;
  /**
   * 尽力而为的仓库元信息(GitHub API)。GitHub 明确返回 404 时为 'not-found'
   * (无 token 时私有仓库也是 404);403 限流、5xx、网络错误、超时等一律返回 null,不阻塞提交。
   */
  repoInfo(owner: string, name: string): Promise<RepoInfo | 'not-found' | null>;
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

export function createGitHost(
  opts: { timeoutMs?: number; githubToken?: string; fetch?: typeof fetch; exec?: GitExec } = {},
): GitHost {
  const timeout = opts.timeoutMs ?? 15_000;
  const run: GitExec = opts.exec ?? execFileP;
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
      } catch (err) {
        const unavailable = classifyGitError(err);
        if (unavailable) throw unavailable;
        return null;
      }
    },
    async repoInfo(owner, name) {
      try {
        const res = await (opts.fetch ?? fetch)(`https://api.github.com/repos/${owner}/${name}`, {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'repo-lens',
            ...(opts.githubToken ? { authorization: `Bearer ${opts.githubToken}` } : {}),
          },
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 404) return 'not-found';
        if (!res.ok) return null;
        const j = (await res.json()) as {
          size?: number;
          language?: string | null;
          private?: boolean;
        };
        return {
          sizeKb: j.size ?? null,
          language: j.language ?? null,
          private: typeof j.private === 'boolean' ? j.private : null,
        };
      } catch {
        return null;
      }
    },
  };
}
