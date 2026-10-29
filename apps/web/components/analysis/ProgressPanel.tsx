import { STAGE_LABEL, stageIndex, type JobProgress } from '../../lib/api/jobEvents';

/** W1 实际会出现的阶段(summarizing/embedding 为 W2,后端目前直接跳过) */
const SHOWN = ['queued', 'cloning', 'scanning', 'parsing', 'graph_ready'] as const;

/** 分析进度:阶段条 + 百分比 + 后端 message;stage_error 显示在对应阶段下 */
export function ProgressPanel({ p, reconnecting }: { p: JobProgress; reconnecting?: boolean }) {
  const cur = stageIndex(p.stage);
  return (
    <section
      aria-label="分析进度"
      className="w-full max-w-[560px] rounded-hero border border-line bg-panel p-5 shadow-soft"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-[18px] font-semibold text-fg">
          {p.status === 'failed' ? '分析失败' : STAGE_LABEL[p.stage]}
        </h2>
        <span className="font-mono text-[13px] text-muted">{Math.round(p.progress)}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(p.progress)}
        className="h-2 w-full overflow-hidden rounded-full bg-canvas"
      >
        <div
          className="h-full rounded-full bg-accent-strong transition-[width] duration-300 ease-out"
          style={{ width: `${p.progress}%` }}
        />
      </div>
      <ol className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        {SHOWN.map((s) => {
          const i = stageIndex(s);
          const failed = p.stageError?.stage === s;
          const state = failed
            ? 'failed'
            : i < cur || p.status === 'done'
              ? 'done'
              : i === cur
                ? 'current'
                : 'todo';
          return (
            <li
              key={s}
              data-state={state}
              className={
                state === 'failed'
                  ? 'font-medium text-accent-strong'
                  : state === 'current'
                    ? 'font-medium text-fg'
                    : state === 'done'
                      ? 'text-fg'
                      : 'text-muted'
              }
            >
              {state === 'done'
                ? '✓ '
                : state === 'failed'
                  ? '✕ '
                  : state === 'current'
                    ? '● '
                    : '○ '}
              {STAGE_LABEL[s]}
            </li>
          );
        })}
      </ol>
      <p role="status" className="mt-3 min-h-5 text-[13px] text-muted">
        {reconnecting ? '进度连接中断,正在重连…' : (p.message ?? '')}
      </p>
      {p.stageError && (
        <p role="alert" className="mt-1 text-[13px] text-accent-strong">
          {STAGE_LABEL[p.stageError.stage]}阶段出错:{p.stageError.message}
        </p>
      )}
    </section>
  );
}
