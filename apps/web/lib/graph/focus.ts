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
 * - focus 已在已加载节点里:它和它的 parentId 链上若有未展开的,返回最外层那个(T-224:
 *   祖先被折叠时先展开祖先);全部已展开返回 null(完成)。
 * - 否则在「未展开的 module/dir」中找路径覆盖 focus 的最深那个,先展开它,
 *   拿到下一层再继续(沿 parentId 链逐层请求)。
 * - focus 不是 m:/d: 节点(文件、外部等):直接忽略,返回 null。
 * - 找不到(focus 不在这棵树上)返回 null,停止,不做兜底。
 */
export function nextFocusStep(
  nodes: readonly GraphNode[],
  expanded: ReadonlySet<string>,
  focus: string,
): string | null {
  // 只处理 module(m:)/dir(d:);文件、外部等其它类型直接忽略
  if (!focus.startsWith('m:') && !focus.startsWith('d:')) return null;
  const hit = nodes.find((n) => n.id === focus);
  if (hit && hit.type !== 'module' && hit.type !== 'dir') return null;
  let target: GraphNode | null = hit ?? null;
  if (!target) {
    const fp = pathOf(focus);
    for (const n of nodes) {
      if ((n.type !== 'module' && n.type !== 'dir') || expanded.has(n.id)) continue;
      if (!covers(n, fp)) continue;
      const len = (n.path ?? pathOf(n.id)).length;
      if (!target || len > (target.path ?? pathOf(target.id)).length) target = n;
    }
    if (!target) return null;
  }
  return outermostCollapsed(nodes, expanded, target);
}

/**
 * T-224:沿 parentId 链向上,返回 target 及其已加载祖先里最外层未展开的那个(都展开了返回 null)。
 * 节点已在图数据里但祖先被折叠(例如展开过后「全部收起」)时,先展开外层,保证逐层可见;
 * 只展开 target 本身而祖先仍折叠,目标永远不会出现在图上。
 */
function outermostCollapsed(
  nodes: readonly GraphNode[],
  expanded: ReadonlySet<string>,
  target: GraphNode,
): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let out: string | null = null;
  const seen = new Set<string>();
  for (
    let n: GraphNode | undefined = target;
    n && !seen.has(n.id);
    n = byId.get(n.parentId ?? '')
  ) {
    seen.add(n.id);
    if (!expanded.has(n.id)) out = n.id;
  }
  return out;
}
