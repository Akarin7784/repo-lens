import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { PipelineError } from './errors.js';

const run = promisify(execFile);

/** 不读取用户/系统 git 配置,不弹交互、不跑 hook、不拉 LFS 大文件 */
const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_LFS_SKIP_SMUDGE: '1',
  GIT_ASKPASS: '/bin/false',
};
/** 只允许 https(生产);测试用本地 bare 仓库时放开 file 协议 */
const safeArgs = (allowFile: boolean) => [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
  ...(allowFile ? ['-c', 'protocol.file.allow=always'] : []),
];

async function git(args: string[], cwd: string | undefined, timeoutMs: number, allowFile = false) {
  try {
    return await run('git', [...safeArgs(allowFile), ...args], {
      cwd,
      env: GIT_ENV,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; stderr?: string; message: string };
    if (e.killed || e.signal === 'SIGKILL')
      throw new PipelineError(
        'CLONE_TIMEOUT',
        'cloning',
        `git ${args[0]} 超时(${timeoutMs}ms)`,
        true,
      );
    throw new PipelineError(
      'CLONE_FAILED',
      'cloning',
      `git ${args[0]} 失败: ${(e.stderr || e.message).trim().slice(0, 400)}`,
      true,
    );
  }
}

export async function headOf(dir: string): Promise<string | null> {
  if (!existsSync(`${dir}/.git`)) return null;
  try {
    const { stdout } = await run('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      env: GIT_ENV,
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * 浅克隆到指定 commit:等价于 `git clone --depth 1 --single-branch --no-recurse-submodules`,
 * 但直接按 SHA fetch(GitHub 支持),保证与 API 侧 ls-remote 得到的 commit 一致。
 * 先克隆到临时目录,成功后原子 rename,中途失败不会留下半成品(断点续跑依赖这一点)。
 */
export async function cloneAtCommit(opts: {
  url: string;
  commitSha: string;
  dest: string;
  timeoutMs: number;
  /** 仅测试:允许 file:// 源 */
  allowFileProtocol?: boolean;
}): Promise<{ skipped: boolean }> {
  const { url, commitSha, dest, timeoutMs } = opts;
  const af = opts.allowFileProtocol ?? false;
  if ((await headOf(dest)) === commitSha) return { skipped: true };
  rmSync(dest, { recursive: true, force: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1000, deadline - Date.now());
  try {
    await git(['init', '-q'], tmp, left(), af);
    await git(['remote', 'add', 'origin', url], tmp, left(), af);
    await git(
      ['fetch', '-q', '--depth', '1', '--no-tags', '--no-recurse-submodules', 'origin', commitSha],
      tmp,
      left(),
      af,
    );
    await git(['checkout', '-q', '--detach', 'FETCH_HEAD'], tmp, left(), af);
    const head = await headOf(tmp);
    if (head !== commitSha)
      throw new PipelineError('COMMIT_MISMATCH', 'cloning', `HEAD ${head} ≠ ${commitSha}`, false);
    renameSync(tmp, dest);
    return { skipped: false };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}
