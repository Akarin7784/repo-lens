import type { GraphNode } from '@repolens/shared';

/** `m:a/b` / `d:a/b` → `a/b`;`m:.` → `.` */
const pathOf = (id: string) => id.slice(2);

/** 容器 c 是否是 focus 的祖先(或就是它)。`m:.` 是单根仓库的根模块,包含一切 */
function covers(container: GraphNode, focusPath: string): boolean {
  const p = container.path ?? pathOf(container.id);
  return p === '.' || p === focusPath || focusPath.startsWith(`${p}/`);
}

/**
 * suggestedFocus 自动下探的下一步(纯函数,便于测试)。
 * - focus 已在已加载节点里:未展开就返回它本身,已展开返回 null(完成)。
 * - 否则在「未展开的 module/dir」中找路径覆盖 focus 的最深那个,先展开它,
 *   拿到下一层再继续(沿 parentId 链逐层请求)。
 * - 找不到(focus 不在这棵树上)返回 null,停止,不做兜底。
 */
export function nextFocusStep(
  nodes: readonly GraphNode[],
  expanded: ReadonlySet<string>,
  focus: string,
): string | null {
  const hit = nodes.find((n) => n.id === focus);
  if (hit) return expanded.has(focus) ? null : focus;
  const fp = pathOf(focus);
  let best: GraphNode | null = null;
  for (const n of nodes) {
    if ((n.type !== 'module' && n.type !== 'dir') || expanded.has(n.id)) continue;
    if (!covers(n, fp)) continue;
    const len = (n.path ?? pathOf(n.id)).length;
    if (!best || len > (best.path ?? pathOf(best.id)).length) best = n;
  }
  return best?.id ?? null;
}
