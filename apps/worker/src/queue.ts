import { UnrecoverableError, type JobsOptions } from 'bullmq';
import { runPipeline, type AnalyzeJobData, type PipelineDeps } from './pipeline/run.js';
import { PipelineError } from './pipeline/errors.js';

export const ANALYZE_QUEUE = 'analyze';
export type { AnalyzeJobData };

/** API 入队时使用;jobId 由调用方给(queueJobId(publicJobId)) */
export const ANALYZE_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const satisfies JobsOptions;

/** BullMQ 处理器:不可重试的错误包成 UnrecoverableError,BullMQ 不再重试 */
export async function processAnalyzeJob(
  job: { data: AnalyzeJobData; attemptsMade: number; opts: { attempts?: number } },
  deps: PipelineDeps,
) {
  try {
    return await runPipeline(job.data, deps, {
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
    });
  } catch (err) {
    if (err instanceof PipelineError && !err.retryable)
      throw new UnrecoverableError(`${err.code}: ${err.message}`);
    throw err;
  }
}
