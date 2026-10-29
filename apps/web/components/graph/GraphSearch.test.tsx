import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GraphNode } from '@repolens/shared';
import { GraphSearch } from './GraphSearch';

const n = (path: string): GraphNode =>
  ({ id: `f:${path}`, type: 'file', parentId: 'd:a', label: path, path }) as GraphNode;
const FIVE = ['a/util1.ts', 'a/util2.ts', 'a/util3.ts', 'a/util4.ts', 'a/util5.ts'].map(n);
const key = (el: Element, k: string) => fireEvent.keyDown(el, { key: k });

function setup(nodes: GraphNode[]) {
  const onPick = vi.fn();
  const r = render(<GraphSearch nodes={nodes} onPick={onPick} />);
  const box = screen.getByRole('combobox', { name: '按路径搜索节点' });
  box.focus();
  fireEvent.change(box, { target: { value: 'util' } });
  return { ...r, box, onPick };
}

describe('<GraphSearch> 序号钳制与读屏(T-224b)', () => {
  it('结果从 5 条变成 2 条:选中序号钳到最后一项,回车仍选中最后一项', () => {
    const { box, onPick, rerender } = setup(FIVE);
    for (let i = 0; i < 4; i++) key(box, 'ArrowDown');
    expect(screen.getAllByRole('option')[4]).toHaveAttribute('aria-selected', 'true');
    rerender(<GraphSearch nodes={FIVE.slice(0, 2)} onPick={onPick} />);
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(2);
    expect(opts[1]).toHaveAttribute('aria-selected', 'true');
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[1]!.id);
    key(box, 'Enter');
    expect(onPick).toHaveBeenCalledWith(FIVE[1]!.id);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('结果变空:不指向任何 option,回车不回调;结果恢复后回车可用', () => {
    const { box, onPick, rerender } = setup(FIVE);
    key(box, 'ArrowDown');
    rerender(<GraphSearch nodes={[]} onPick={onPick} />);
    expect(box).not.toHaveAttribute('aria-activedescendant');
    key(box, 'Enter');
    expect(onPick).not.toHaveBeenCalled();
    rerender(<GraphSearch nodes={FIVE.slice(0, 1)} onPick={onPick} />);
    key(box, 'Enter');
    expect(onPick).toHaveBeenCalledWith(FIVE[0]!.id);
  });

  it('无匹配:aria-expanded=false,live 区播报「没有匹配的节点」;有匹配时播报数量', () => {
    const { box } = setup(FIVE);
    const live = screen.getByTestId('search-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(live).toHaveTextContent('5 个匹配的节点');
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(box).not.toHaveAttribute('aria-activedescendant');
    expect(live).toHaveTextContent('没有匹配的节点');
    fireEvent.blur(box);
    expect(live).toHaveTextContent('');
  });
});
