/**
 * T-221 悬停预览:悬停节点 ~120ms 防抖后,把与它相连的边按选中样式高亮;选中优先于悬停。
 *
 * 为避免悬停时整图重渲染,悬停状态不进 React state / node.data,而是放在一个小的外部 store 里:
 * 每条边用布尔 selector 订阅「我是否与悬停节点相连」,只有结果翻转的边才重渲染;
 * 其它边的「略压暗」由容器上的 data-hovering 属性 + CSS 完成,不触发 React 渲染。
 */
export const HOVER_DELAY_MS = 120;

export type HoverStore = {
  get(): string | null;
  set(id: string | null): void;
  subscribe(fn: () => void): () => void;
};

export function createHoverStore(): HoverStore {
  let cur: string | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => cur,
    set(id) {
      if (id === cur) return;
      cur = id;
      subs.forEach((f) => f());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/**
 * 边在悬停下的有效高亮。规则:
 * - 有选中节点(highlight 已是 on/dim):完全以选中为准,悬停不叠加;
 * - 无选中、边与悬停节点相连:按选中样式 'on'(恢复不透明、--accent-strong、显示 ×N);
 * - 其它:保持原样(视觉上的略压暗由 CSS 完成,不改数据)。
 */
export function hoverHighlight(
  selectionHighlight: 'on' | 'dim' | undefined,
  hoverTouches: boolean,
): 'on' | 'dim' | undefined {
  if (selectionHighlight !== undefined) return selectionHighlight;
  return hoverTouches ? 'on' : undefined;
}

/** 防抖控制:enter 延迟 delay 生效,leave 立即清除并取消待生效的 enter;选中时忽略悬停 */
export function createHoverController(
  store: HoverStore,
  isSelecting: () => boolean,
  delay = HOVER_DELAY_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    enter(id: string) {
      cancel();
      if (isSelecting()) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!isSelecting()) store.set(id);
      }, delay);
    },
    leave() {
      cancel();
      store.set(null);
    },
    dispose: cancel,
  };
}
