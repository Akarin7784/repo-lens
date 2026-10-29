import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  FILE_MAX_LINES,
  MAX_SEND_BYTES,
  excludedNotice,
  excludedReasonOf,
  exclusionRule,
  safeRelPath,
  type FileContent,
} from '@repolens/shared';
import { HttpError } from './errors.js';

export interface ReadFileOpts {
  /** worker 快照根目录(REPOS_DIR),快照在 {reposDir}/{repoId}/{commitSha} */
  reposDir: string;
  repoId: number;
  commitSha: string;
  path: string;
  start?: number;
  end?: number;
}

const isNoEnt = (e: unknown) =>
  (e as NodeJS.ErrnoException)?.code === 'ENOENT' ||
  (e as NodeJS.ErrnoException)?.code === 'ENOTDIR';

/**
 * T-213:从 worker 保留的快照读文件片段。只读快照内的普通文件:
 * 路径先过 safeRelPath(拒绝 ..、绝对路径、反斜杠、非规范化),逐段 lstat 拒绝符号链接,
 * 再用 realpath 兜底确认仍在快照目录内;以 O_NOFOLLOW 打开。命中共享排除规则只返回提示、不返回内容。
 */
export async function readRepoFile(o: ReadFileOpts): Promise<FileContent> {
  const rel = safeRelPath(o.path);
  if (!rel) throw new HttpError('BAD_REQUEST', '路径无效:须为仓库内规范化相对路径');
  if (rel.split('/').includes('.git')) throw new HttpError('BAD_REQUEST', '不允许读取 .git 目录');
  if (o.start !== undefined && o.end !== undefined) {
    if (o.end < o.start) throw new HttpError('BAD_REQUEST', 'end 不能小于 start');
    if (o.end - o.start + 1 > FILE_MAX_LINES)
      throw new HttpError('BAD_REQUEST', `单次最多 ${FILE_MAX_LINES} 行`);
  }

  const root = join(o.reposDir, String(o.repoId), o.commitSha);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (e) {
    if (isNoEnt(e))
      throw new HttpError('REPO_NOT_READY', '该 commit 的源码快照不可用(未保留或已清理)', {
        reason: 'SNAPSHOT_MISSING',
      });
    throw e;
  }

  // 逐段 lstat:任何一段是符号链接都拒绝(不跟随)
  const segs = rel.split('/');
  let cur = realRoot;
  for (let i = 0; i < segs.length; i++) {
    cur = join(cur, segs[i]!);
    let st;
    try {
      st = await lstat(cur);
    } catch (e) {
      if (isNoEnt(e)) throw new HttpError('FILE_NOT_FOUND', '文件不存在');
      throw e;
    }
    if (st.isSymbolicLink()) throw new HttpError('BAD_REQUEST', '不跟随符号链接');
    const last = i === segs.length - 1;
    if (!last && !st.isDirectory()) throw new HttpError('FILE_NOT_FOUND', '文件不存在');
    if (last && !st.isFile()) throw new HttpError('BAD_REQUEST', '不是普通文件');
  }
  const real = await realpath(cur);
  if (!real.startsWith(realRoot + sep)) throw new HttpError('BAD_REQUEST', '路径越界');

  const base = { path: rel, commitSha: o.commitSha };
  const excluded = (rule: string): FileContent => {
    const reason = excludedReasonOf(rule);
    return {
      ...base,
      totalLines: null,
      start: null,
      end: null,
      hasMore: false,
      content: null,
      excluded: { reason, notice: excludedNotice(reason) },
    };
  };
  // 先只看路径(.env、*.pem 等):命中直接返回,不读内容
  const byPath = exclusionRule(rel, null);
  if (byPath) return excluded(byPath);

  const fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    const st = await fh.stat();
    // 体积上限与切块/摘要一致(MAX_SEND_BYTES);超限不读入内存
    if (st.size > MAX_SEND_BYTES) return excluded('too-large');
    text = (await fh.readFile()).toString('utf8');
  } finally {
    await fh.close();
  }
  const rule = exclusionRule(rel, text);
  if (rule) return excluded(rule);

  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  const total = lines.length;
  const start = o.start ?? 1;
  if (total === 0) {
    if (o.start !== undefined && o.start > 1)
      throw new HttpError('BAD_REQUEST', 'start 超出文件行数');
    return {
      ...base,
      totalLines: 0,
      start: null,
      end: null,
      hasMore: false,
      content: '',
      excluded: null,
    };
  }
  if (start > total) throw new HttpError('BAD_REQUEST', `start 超出文件行数(共 ${total} 行)`);
  const want = o.end ?? start + FILE_MAX_LINES - 1;
  const end = Math.min(want, total);
  return {
    ...base,
    totalLines: total,
    start,
    end,
    hasMore: o.end === undefined && end < total,
    content: lines.slice(start - 1, end).join('\n'),
    excluded: null,
  };
}
