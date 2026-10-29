'use client';
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { createHoverStore, type HoverStore } from '../../lib/graph/hover';

const fallback = createHoverStore();
export const HoverContext = createContext<HoverStore>(fallback);

/** 布尔订阅:只有「是否与悬停节点相连」翻转时才重渲染这条边 */
export function useHoverTouches(source: string, target: string): boolean {
  const store = useContext(HoverContext);
  const get = useCallback(() => {
    const h = store.get();
    return h !== null && (h === source || h === target);
  }, [store, source, target]);
  return useSyncExternalStore(store.subscribe, get, get);
}
