import { z } from 'zod';

/**
 * nodeId 约定(ARCHITECTURE.md §5.2,群内架构师决定):三层 module → dir → file。
 * id = 前缀 + 相对仓库根的 POSIX 路径,同一 commit 内确定、稳定。
 * - module:`m:<path>`,如 `m:src/core`;根模块固定为 `m:.`
 * - dir:   `d:<path>`,如 `d:src/core/utils`
 * - file:  `f:<path>`,如 `f:src/core/a.ts`
 * - external:`x:<包名>`,如 `x:react`。**派生数据**:分析器不产出、不入库,仅 API 层在 includeExternal=true 时现算。
 */
const POSIX_REL = String.raw`(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!\/)(?!.*\/\/)(?!.*\\)[^\s]+(?<!\/)`;
export const ModuleIdSchema = z
  .string()
  .regex(new RegExp(`^m:(\\.|${POSIX_REL})$`), 'module id 须形如 m:<path> 或 m:.');
export const DirIdSchema = z
  .string()
  .regex(new RegExp(`^d:${POSIX_REL}$`), 'dir id 须形如 d:<path>');
export const FileIdSchema = z
  .string()
  .regex(new RegExp(`^f:${POSIX_REL}$`), 'file id 须形如 f:<path>');
export const ExternalIdSchema = z
  .string()
  .regex(/^x:(@[\w.-]+\/)?[\w.-]+$/, 'external id 须形如 x:<包名>');
export const NodeIdSchema = z.union([ModuleIdSchema, DirIdSchema, FileIdSchema, ExternalIdSchema]);
export type NodeId = z.infer<typeof NodeIdSchema>;

/** git commit SHA(7-40 位小写十六进制) */
export const CommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, 'commitSha 必须是 7-40 位小写十六进制');
export type CommitSha = z.infer<typeof CommitShaSchema>;

/** 规范化为相对仓库根的 POSIX 路径;空路径 / "." 表示仓库根 */
export function toPosixRel(p: string): string {
  const s = p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+|\/+$/g, '');
  return s === '' ? '.' : s;
}

export const ROOT_MODULE_ID = 'm:.';
export const moduleId = (path: string): string => `m:${toPosixRel(path)}`;
export const dirId = (path: string): string => `d:${toPosixRel(path)}`;
export const fileId = (path: string): string => `f:${toPosixRel(path)}`;
export const externalId = (pkg: string): string => `x:${pkg}`;
