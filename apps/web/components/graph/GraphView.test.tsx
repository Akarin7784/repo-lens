import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { GraphView } from './GraphView';
import { createFixtureSource } from '../../lib/graph/source';
import { SAMPLE_REPOS } from '../../lib/fixtures';
import { createInlineEngine } from '../../lib/layout/elk';

describe('<GraphView> 展开/收起', () => {
  it('点击 module 的展开按钮显示其文件,再点收起', async () => {
    const s = SAMPLE_REPOS.zustand;
    const engine = await createInlineEngine();
    const { container } = render(
      <div style={{ width: 1000, height: 700 }}>
        <GraphView
          source={createFixtureSource('pmndrs/zustand', s.data)}
          owner={s.owner}
          repo={s.repo}
          engine={engine}
        />
      </div>,
    );
    const btn = await screen.findByRole('button', { name: '展开 middleware' });
    expect(container.querySelector('[data-testid^="node-f:src/middleware/"]')).toBeNull();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(container.querySelector('[data-testid^="node-f:src/middleware/"]')).not.toBeNull(),
    );
    fireEvent.click(await screen.findByRole('button', { name: '收起 middleware' }));
    await waitFor(() =>
      expect(container.querySelector('[data-testid^="node-f:src/middleware/"]')).toBeNull(),
    );
  });
});
