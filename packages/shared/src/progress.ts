import { z } from 'zod';

/** 进度阶段,顺序固定(ARCHITECTURE.md §5.1) */
export const PROGRESS_STAGES = [
  'queued',
  'cloning',
  'scanning',
  'parsing',
  'graph_ready',
  'summarizing',
  'embedding',
  'done',
] as const;
export const ProgressStageSchema = z.enum(PROGRESS_STAGES);
export type ProgressStage = z.infer<typeof ProgressStageSchema>;

const jobId = z.string().min(1);

export const ProgressEventSchema = z.object({
  event: z.literal('progress'),
  data: z.object({
    jobId,
    stage: ProgressStageSchema,
    progress: z.number().min(0).max(100),
    message: z.string().optional(),
  }),
});
export const GraphReadyEventSchema = z.object({
  event: z.literal('graph_ready'),
  data: z.object({ jobId, repoId: z.number().int().positive(), graphUrl: z.string() }),
});
export const StageErrorEventSchema = z.object({
  event: z.literal('stage_error'),
  data: z.object({ jobId, stage: ProgressStageSchema, message: z.string() }),
});
export const JobDoneEventSchema = z.object({
  event: z.literal('done'),
  data: z.object({
    jobId,
    status: z.enum(['done', 'failed']),
    stats: z.record(z.string(), z.number()).optional(),
  }),
});

/** GET /api/jobs/:id/events 的事件 */
export const JobEventSchema = z.discriminatedUnion('event', [
  ProgressEventSchema,
  GraphReadyEventSchema,
  StageErrorEventSchema,
  JobDoneEventSchema,
]);
export type JobEvent = z.infer<typeof JobEventSchema>;
