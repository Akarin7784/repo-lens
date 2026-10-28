import { describe, expect, it } from 'vitest';
import { processAnalyzeJob } from './queue.js';

describe('processAnalyzeJob 骨架', () => {
  it('按阶段顺序上报进度', async () => {
    const seen: string[] = [];
    await processAnalyzeJob(
      { repoId: 1, repoUrl: 'https://github.com/a/b', commitSha: 'a1b2c3d' },
      async (s, p) => {
        seen.push(`${s}:${p}`);
      },
    );
    expect(seen).toEqual(['cloning:25', 'scanning:50', 'parsing:75', 'graph_ready:100']);
  });
});
