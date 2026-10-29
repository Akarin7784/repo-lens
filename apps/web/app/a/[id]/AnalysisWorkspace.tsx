'use client';
import Link from 'next/link';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { ProgressPanel } from '../../../components/analysis/ProgressPanel';
import { GraphView } from '../../../components/graph/GraphView';
import { ThemeToggle } from '../../../components/theme/ThemeToggle';
import { createApiClient, type ApiClient } from '../../../lib/api/client';
import { userMessageOf } from '../../../lib/api/errors';
import {
  initialJobProgress,
  jobProgressReducer,
  stageIndex,
  subscribeJobEvents,
  type EventSourceFactory,
} from '../../../lib/api/jobEvents';
import { createApiSource } from '../../../lib/graph/source';

type Props = {
  repoId: number;
  /** 刚提交时由首页带上;直接打开链接时为空,先查 GET /api/repos/:id */
  jobId?: string;
  repoLabel?: string;
  /** 测试注入 */
  api?: ApiClient;
  eventSource?: EventSourceFactory;
};

type Init = { jobId: string | null; error: string | null };

export function AnalysisWorkspace({ repoId, jobId, repoLabel, api: apiProp, eventSource }: Props) {
  const api = useMemo(() => apiProp ?? createApiClient(), [apiProp]);
  const [progress, dispatch] = useReducer(jobProgressReducer, initialJobProgress);
  const [init, setInit] = useState<Init>({ jobId: jobId ?? null, error: null });
  const [reconnecting, setReconnecting] = useState(false);
  const [rootInfo, setRootInfo] = useState<{ commitSha: string; nodes: number; ms: number } | null>(
    null,
  );

  // 没有 jobId:用 GET /api/repos/:id 判断已完成、进行中还是失败
  useEffect(() => {
    if (jobId) return;
    let alive = true;
    api
      .getRepoStatus(repoId)
      .then((s) => {
        if (!alive) return;
        if (s.status === 'failed') {
          dispatch({
            event: 'stage_error',
            data: { jobId: s.jobId, stage: s.stage, message: s.error ?? '未知错误' },
          });
          dispatch({ event: 'done', data: { jobId: s.jobId, status: 'failed' } });
          return setInit({ jobId: null, error: null });
        }
        if (s.status === 'done' || stageIndex(s.stage) >= stageIndex('graph_ready'))
          dispatch({ event: 'graph_ready', data: { jobId: s.jobId, repoId, graphUrl: '' } });
        if (s.status === 'done')
          dispatch({ event: 'done', data: { jobId: s.jobId, status: 'done' } });
        else
          dispatch({
            event: 'progress',
            data: { jobId: s.jobId, stage: s.stage, progress: s.progress },
          });
        setInit({ jobId: s.status === 'done' ? null : s.jobId, error: null });
      })
      .catch((e: unknown) => alive && setInit({ jobId: null, error: userMessageOf(e) }));
    return () => {
      alive = false;
    };
  }, [api, repoId, jobId]);

  // 订阅进度流,直到 done
  useEffect(() => {
    if (!init.jobId) return;
    return subscribeJobEvents(
      api.jobEventsUrl(init.jobId),
      {
        onEvent: (e) => {
          setReconnecting(false);
          dispatch(e);
        },
        onConnectionError: () => setReconnecting(true),
      },
      eventSource,
    );
  }, [api, init.jobId, eventSource]);

  const source = useMemo(
    () => createApiSource(api, repoId, repoLabel ?? `仓库 #${repoId}`),
    [api, repoId, repoLabel],
  );
  const [owner = '', repo = ''] = (repoLabel ?? '').split('/');
  const showGraph = progress.graphReady && progress.status !== 'failed';

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-line bg-bg px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="font-serif text-[17px] font-semibold text-fg">
            RepoLens
          </Link>
          <span className="truncate font-mono text-[13px] text-fg">{source.repoLabel}</span>
          {rootInfo && (
            <span className="font-mono text-[12px] text-muted" title={rootInfo.commitSha}>
              @{rootInfo.commitSha.slice(0, 7)}
            </span>
          )}
        </div>
        <ThemeToggle />
      </header>
      {init.error ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p role="alert" className="text-[14px] text-accent-strong">
            {init.error}
          </p>
        </div>
      ) : showGraph ? (
        <div className="relative min-h-0 flex-1">
          {progress.status === 'running' && (
            <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full border border-line bg-panel px-3 py-1 text-[12px] text-muted shadow-soft">
              依赖图已生成,后续阶段进行中({Math.round(progress.progress)}%)
            </div>
          )}
          <GraphView source={source} owner={owner} repo={repo} onRootLoaded={setRootInfo} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <ProgressPanel p={progress} reconnecting={reconnecting} />
        </div>
      )}
    </main>
  );
}
