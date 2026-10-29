/**
 * T-239:展开/收起时保持视图。记录被点击节点展开前的屏幕位置,布局完成后保持缩放不变,
 * 只平移使该节点回到原屏幕位置(而不是整图 fitView 重置缩放/平移)。
 */
export type Viewport = { x: number; y: number; zoom: number };
export type Anchor = { id: string; sx: number; sy: number; zoom: number };
type PosNode = { id: string; position: { x: number; y: number }; parentId?: string };

/** React Flow 子流程里 position 相对父容器:沿 parentId 累加得到绝对坐标;找不到返回 null */
export function absolutePosition(
  nodes: readonly PosNode[],
  id: string,
): { x: number; y: number } | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let n = byId.get(id);
  if (!n) return null;
  let x = 0;
  let y = 0;
  for (let guard = 0; n && guard < 64; guard++) {
    x += n.position.x;
    y += n.position.y;
    n = n.parentId ? byId.get(n.parentId) : undefined;
  }
  return { x, y };
}

/** 展开/收起前:由当前视口和节点绝对坐标记下锚点的屏幕位置 */
export function makeAnchor(id: string, abs: { x: number; y: number }, vp: Viewport): Anchor {
  return { id, sx: abs.x * vp.zoom + vp.x, sy: abs.y * vp.zoom + vp.y, zoom: vp.zoom };
}

/** 布局完成后:缩放保持,平移使锚点节点回到原屏幕位置 */
export function anchoredViewport(a: Anchor, abs: { x: number; y: number }): Viewport {
  return { x: a.sx - abs.x * a.zoom, y: a.sy - abs.y * a.zoom, zoom: a.zoom };
}

/**
 * 布局完成后的视图动作:有锚点且锚点节点仍在新图中 → 保持缩放的锚定视口;
 * 否则(初次加载、切换仓库、自动下探、全部收起、锚点已消失)→ 'fit' 整图适配。
 */
export function viewportAfterLayout(
  anchor: Anchor | null,
  nodes: readonly PosNode[],
): Viewport | 'fit' {
  if (!anchor) return 'fit';
  const abs = absolutePosition(nodes, anchor.id);
  return abs ? anchoredViewport(anchor, abs) : 'fit';
}
