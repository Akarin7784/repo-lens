import type { ProgressStage } from '@repolens/shared';

export const ANALYZE_QUEUE = 'analyze';

export type AnalyzeJobData = { repoId: number; repoUrl: string; commitSha: string };

/** 流水线阶段顺序(§4.1)。各阶段实现在 pipeline/ 下,T-003 起逐个落地。 */
export const PIPELINE: ProgressStage[] = ['cloning', 'scanning', 'parsing', 'graph_ready'];

/** 骨架处理器:只按阶段上报进度,不做真实工作。 */
export async function processAnalyzeJob(
  _data: AnalyzeJobData,
  report: (stage: ProgressStage, progress: number) => Promise<void>,
): Promise<void> {
  for (const [i, stage] of PIPELINE.entries()) {
    await report(stage, Math.round(((i + 1) / PIPELINE.length) * 100));
  }
}
