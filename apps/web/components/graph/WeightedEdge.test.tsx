import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { Position, ReactFlowProvider } from '@xyflow/react';
import type { ComponentProps } from 'react';

import { WeightedEdge } from './WeightedEdge';
import { HoverContext } from './HoverContext';
import { createHoverStore } from '../../lib/graph/hover';
import { AGG_EDGE_OPACITY } from '../../lib/graph/toFlow';

type P = ComponentProps<typeof WeightedEdge>;
const edge = (id: string, source: string, target: string, highlight?: 'on' | 'dim'): P =>
  ({
    id,
    source,
    target,
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 100,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    data: { weight: 6, aggregated: true, kind: 'import', ...(highlight ? { highlight } : {}) },
  }) as unknown as P;

function setup(hl?: 'on' | 'dim', hl2?: 'on' | 'dim') {
  const store = createHoverStore();
  const r = render(
    <ReactFlowProvider>
      <HoverContext.Provider value={store}>
        <svg>
          <WeightedEdge {...edge('e1', 'a', 'b', hl)} />
          <WeightedEdge {...edge('e2', 'c', 'd', hl2)} />
        </svg>
      </HoverContext.Provider>
    </ReactFlowProvider>,
  );
  const g = (id: string) => r.container.querySelector(`[data-testid="edge-${id}"]`)!;
  const op = (id: string) =>
    Number(
      (g(id).querySelector('path.react-flow__edge-path') as SVGPathElement).style.strokeOpacity,
    );
  return { store, g, op, r };
}

describe('<WeightedEdge> 悬停预览(T-221)', () => {
  it('悬停相连节点:聚合边恢复 0.9 不透明并显示 ×N;不相连的边保持原样', () => {
    const { store, g, op } = setup();
    expect(op('e1')).toBe(AGG_EDGE_OPACITY);
    act(() => store.set('a'));
    expect(g('e1').getAttribute('data-hl')).toBe('on');
    expect(g('e1').getAttribute('data-hover')).toBe('on');
    expect(op('e1')).toBe(0.9);
    expect(g('e2').getAttribute('data-hl')).toBe('none');
    expect(g('e2').hasAttribute('data-hover')).toBe(false);
    expect(op('e2')).toBe(AGG_EDGE_OPACITY);
  });

  it('移开恢复原样', () => {
    const { store, g, op } = setup();
    act(() => store.set('b'));
    expect(op('e1')).toBe(0.9);
    act(() => store.set(null));
    expect(g('e1').getAttribute('data-hl')).toBe('none');
    expect(g('e1').hasAttribute('data-hover')).toBe(false);
    expect(op('e1')).toBe(AGG_EDGE_OPACITY);
  });

  it('选中状态下悬停不叠加:dim 的边即使与悬停节点相连也保持 dim', () => {
    const { store, g, op } = setup('dim', 'on');
    act(() => store.set('a'));
    expect(g('e1').getAttribute('data-hl')).toBe('dim');
    expect(g('e1').hasAttribute('data-hover')).toBe(false);
    expect(op('e1')).toBe(0.15);
    expect(g('e2').getAttribute('data-hl')).toBe('on');
  });
});
