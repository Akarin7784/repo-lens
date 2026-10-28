import { z } from 'zod';

/**
 * nodeId 约定(ARCHITECTURE.md §5.2):由路径确定性生成,同一 commit 内稳定。
 * - 模块/目录:`m:<dir>`,例如 `m:src/core`
 * - 文件:`f:<path>`,例如 `f:src/compose.ts`
 * - 外部依赖:`x:<package>`(external 节点,例如 `x:react`)
 */
export const NodeIdSchema = z
  .string()
  .regex(/^[mfx]:\S+$/, 'nodeId 必须形如 m:<dir> / f:<path> / x:<pkg>');
export type NodeId = z.infer<typeof NodeIdSchema>;

/** 完整或缩写的 git commit SHA(7-40 位十六进制) */
export const CommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, 'commitSha 必须是 7-40 位小写十六进制');
export type CommitSha = z.infer<typeof CommitShaSchema>;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export const moduleId = (dir: string): string => `m:${normalizePath(dir)}`;
export const fileId = (path: string): string => `f:${normalizePath(path)}`;
export const externalId = (pkg: string): string => `x:${pkg}`;
