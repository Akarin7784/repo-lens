import { Worker } from 'bullmq';
import { ANALYZE_QUEUE, processAnalyzeJob, type AnalyzeJobData } from './queue.js';

const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  maxRetriesPerRequest: null,
};

const worker = new Worker<AnalyzeJobData>(
  ANALYZE_QUEUE,
  (job) =>
    processAnalyzeJob(job.data, (stage, progress) => job.updateProgress({ stage, progress })),
  { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2) },
);

worker.on('ready', () => console.log(`[worker] listening on queue "${ANALYZE_QUEUE}"`));
worker.on('failed', (job, err) => console.error(`[worker] job ${job?.id} failed`, err));

const shutdown = async () => {
  await worker.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
