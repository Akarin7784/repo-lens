'use client';
import type { GraphNode } from '@repolens/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { searchNodes, type SearchHit } from '../../lib/graph/search';

const KIND: Record<SearchHit['type'], { icon: string; label: string }> = {
  module: { icon: '◆', label: '模块' },
  dir: { icon: '▤', label: '目录' },
  file: { icon: '▢', label: '文件' },
  external: { icon: '◇', label: '外部' },
};

/** 编辑类元素里按 `/` 是正常输入,不抢焦点 */
function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

/**
 * T-224 路径搜索框(WAI-ARIA combobox + listbox)。只搜已加载的节点(含折叠起来看不到的);
 * 选中后交给 GraphView 按路径逐层展开并选中。`/` 聚焦,Esc 清空(空时失焦),↑↓ 选择,Enter 定位。
 */
export function GraphSearch({
  nodes,
  onPick,
  limit = 8,
}: {
  nodes: readonly GraphNode[];
  onPick: (id: string) => void;
  limit?: number;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const hits = useMemo(() => searchNodes(nodes, q, limit), [nodes, q, limit]);
  const showList = open && q.trim() !== '';
  // T-224b:nodes 在搜索框打开期间可能变化(加载/重新分析),结果变少时 active 会越界;
  // 渲染与回车都用钳过的序号,无结果时为 -1(不指向任何 option)
  const activeIdx = hits.length === 0 ? -1 : Math.min(active, hits.length - 1);
  const expanded = showList && hits.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (h: SearchHit | undefined) => {
    if (!h) return;
    onPick(h.id);
    setOpen(false);
  };

  return (
    <div className="relative w-full">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="按路径搜索节点"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && activeIdx >= 0 ? `${listId}-${activeIdx}` : undefined}
        placeholder="搜索路径  /"
        autoComplete="off"
        spellCheck={false}
        value={q}
        className="w-full rounded-control border border-line bg-panel px-3 py-1.5 font-mono text-[13px] text-fg shadow-soft placeholder:font-sans placeholder:text-muted focus:border-accent-strong focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-strong)]"
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!hits.length) return;
            setOpen(true);
            const d = e.key === 'ArrowDown' ? 1 : -1;
            setActive(() => (Math.max(activeIdx, 0) + d + hits.length) % hits.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (showList && activeIdx >= 0) pick(hits[activeIdx]);
          } else if (e.key === 'Escape') {
            // 不冒泡到 GraphView 的全局 Esc(那里是取消选中)
            e.stopPropagation();
            if (q) {
              setQ('');
              setActive(0);
            } else inputRef.current?.blur();
          }
        }}
      />
      {/* 读屏播报:无匹配 / 匹配数量;始终挂载,内容变化才会被 polite 读出。不用 role=status,避免与图状态条重名 */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="search-live">
        {showList ? (hits.length === 0 ? '没有匹配的节点' : `${hits.length} 个匹配的节点`) : ''}
      </div>
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="搜索结果"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[50dvh] overflow-y-auto rounded-control border border-line bg-panel py-1 text-[13px] shadow-soft"
        >
          {hits.length === 0 ? (
            <li role="presentation" className="px-3 py-1.5 text-muted">
              没有匹配的节点
            </li>
          ) : (
            hits.map((h, i) => (
              <li
                key={h.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === activeIdx}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${i === activeIdx ? 'bg-cite text-fg' : 'text-fg'}`}
                // mousedown 先于 input 的 blur,阻止默认避免列表在点击前就关闭
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(h)}
              >
                <span aria-hidden className="w-4 shrink-0 text-center text-muted">
                  {KIND[h.type].icon}
                </span>
                <span className="sr-only">{KIND[h.type].label} </span>
                <span className="min-w-0 truncate font-mono" title={h.path}>
                  {h.path === '.' ? '仓库根目录' : h.path}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
