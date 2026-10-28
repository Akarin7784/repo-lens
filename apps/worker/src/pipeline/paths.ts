import { posix } from 'node:path';

/**
 * 仓库内相对路径的安全校验:拒绝 NUL、绝对路径、反斜杠、`..` 段;返回规范化的 POSIX 路径。
 * 扫描阶段本身不跟随符号链接,这里再对进入分析/入库的每条路径兜一层。
 */
export function safeRelPath(p: string): string | null {
  if (!p || p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p))
    return null;
  const n = posix.normalize(p);
  if (n === '.' || n.startsWith('../') || n === '..' || n.split('/').includes('..')) return null;
  if (n !== p) return null;
  return n;
}
