'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ChatPanel } from '../../../components/chat/ChatPanel';
import { NodeDetail, type GraphNeighbors } from '../../../components/detail/NodeDetail';
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
import { createFetchTransport, type ChatTransport } from '../../../lib/chat/transport';
import type { EmbeddingProvider } from '../../../lib/privacy/disclosure';

type Props = {
  repoId: number;
  /** 刚提交时由首页带上;直接打开链接时为空,先查 GET /api/repos/:id */
  jobId?: string;
  repoLabel?: string;
  /** 测试注入 */
  api?: ApiClient;
  eventSource?: EventSourceFactory;
  /** T-230:问答传输;默认 fetch POST /api/repos/:id/chat(后端未实现时显示「问答服务暂未上线」),测试注入假流 */
  chatTransport?: ChatTransport;
};

type Init = { jobId: string | null; error: string | null };

export function AnalysisWorkspace({
  repoId,
  jobId,
  repoLabel,
  api: apiProp,
  eventSource,
  chatTransport,
}: Props) {
  const transport = useMemo(() => chatTransport ?? createFetchTransport(), [chatTransport]);
  // T-230:右栏分「详情 / 问答」两个标签;点引用会切回详情显示文件预览
  const [tab, setTab] = useState<'detail' | 'chat'>('detail');
  const api = useMemo(() => apiProp ?? createApiClient(), [apiProp]);
  const [progress, dispatch] = useReducer(jobProgressReducer, initialJobProgress);
  const [init, setInit] = useState<Init>({ jobId: jobId ?? null, error: null });
  const [reconnecting, setReconnecting] = useState(false);
  // T-234:问答面板的披露按提供方显示;未取到(或字段缺省)= 未知
  const [embeddingProvider, setEmbeddingProvider] = useState<EmbeddingProvider | undefined>();
  const [rootInfo, setRootInfo] = useState<{ commitSha: string; nodes: number; ms: number } | null>(
    null,
  );

  // 没有 jobId:用 GET /api/repos/:id 判断已完成、进行中还是失败
  useEffect(() => {
    // 换仓库先清掉上一个仓库的提供方:新请求返回前或失败时显示「未知」,不沿用旧值
    setEmbeddingProvider(undefined);
    if (jobId) return;
    let alive = true;
    api
      .getRepoStatus(repoId)
      .then((s) => {
        if (!alive) return;
        setEmbeddingProvider(s.embeddingProvider);
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

  // 刚提交(带 jobId)时提供方要等任务完成后才写入 stats:done 后补查一次状态;失败保持「未知」
  const doneNow = progress.status === 'done';
  useEffect(() => {
    if (!jobId || !doneNow) return;
    let alive = true;
    Promise.resolve()
      .then(() => api.getRepoStatus(repoId))
      .then((s) => alive && setEmbeddingProvider(s?.embeddingProvider))
      // 补查失败 → 未知(不设 local、不留旧值);alive 防止旧 repoId 的晚到结果覆盖新仓库
      .catch(() => alive && setEmbeddingProvider(undefined));
    return () => {
      alive = false;
    };
  }, [api, repoId, jobId, doneNow]);

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

  // T-222:右栏详情。选中来自 GraphView;?node= 写入 URL,打开链接时据此跳转
  const [sel, setSel] = useState<({ id: string } & GraphNeighbors) | null>(null);
  const [jump, setJump] = useState<{ id: string; n: number } | null>(null);
  // T-222d:抽屉「关闭」= 取消选中(与 Esc / 点空白一致),计数变化即触发
  const [closeTick, setCloseTick] = useState(0);
  const jumpTo = useCallback((id: string) => setJump((j) => ({ id, n: (j?.n ?? 0) + 1 })), []);
  const urlRead = useRef(false);
  useEffect(() => {
    if (urlRead.current) return;
    urlRead.current = true;
    const id = new URLSearchParams(window.location.search).get('node');
    if (id) jumpTo(id);
  }, [jumpTo]);
  // 打开带 ?node= 的链接时,跳转完成前 sel 为 null:此时不清掉 URL
  const hadSel = useRef(false);
  useEffect(() => {
    if (!sel && !hadSel.current) return;
    hadSel.current = true;
    const url = new URL(window.location.href);
    if (sel) url.searchParams.set('node', sel.id);
    else url.searchParams.delete('node');
    window.history.replaceState(window.history.state, '', url);
  }, [sel]);
  const [doneTick, setDoneTick] = useState(0);
  useEffect(() => {
    if (progress.status === 'done') setDoneTick((t) => t + 1);
  }, [progress.status]);

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
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="relative min-h-0 min-w-0 flex-1">
            <GraphView
              source={source}
              owner={owner}
              repo={repo}
              onRootLoaded={setRootInfo}
              onSelectionChange={setSel}
              jumpRequest={jump}
              clearRequest={closeTick}
              topNotice={
                progress.status === 'running' ? (
                  <div
                    data-testid="progress-banner"
                    className="pointer-events-none max-w-full truncate rounded-full border border-line bg-panel px-3 py-1 text-[12px] text-muted shadow-soft"
                  >
                    依赖图已生成,后续阶段进行中({Math.round(progress.progress)}%)
                  </div>
                ) : undefined
              }
            />
          </div>
          {/* T-222d:≥768px 为右栏;<768px 未选中时隐藏,选中后为占下方 55dvh 的底部抽屉(在文档流里,图区随之缩到上方,不被遮挡),可关闭 */}
          <aside
            aria-label="详情"
            data-testid="detail-aside"
            data-drawer={sel || tab === 'chat' ? 'open' : 'closed'}
            className={
              'shrink-0 overflow-y-auto border-line bg-bg ' +
              'md:block md:max-h-none md:w-[360px] md:rounded-none md:border-l md:border-t-0 md:shadow-none ' +
              (sel || tab === 'chat'
                ? 'h-[55dvh] max-h-[55dvh] shrink-0 rounded-t-[12px] border-t shadow-soft md:h-auto'
                : 'hidden')
            }
          >
            <div
              role="tablist"
              aria-label="右栏"
              className="sticky top-0 z-10 flex gap-1 border-b border-line bg-bg px-3 py-1.5"
            >
              {(['detail', 'chat'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={
                    'rounded-control px-3 py-1 text-[13px] ' +
                    (tab === t ? 'bg-panel text-fg' : 'text-muted')
                  }
                >
                  {t === 'detail' ? '详情' : '问答'}
                </button>
              ))}
              {(sel || tab === 'chat') && (
                <button
                  type="button"
                  aria-label="关闭详情"
                  onClick={() => {
                    setTab('detail');
                    setCloseTick((t) => t + 1);
                  }}
                  className="ml-auto rounded-control border border-line bg-panel px-3 py-1 text-[13px] text-fg md:hidden"
                >
                  关闭
                </button>
              )}
            </div>
            {/* 问答面板常驻挂载(切到详情不丢对话、不中断流);离开工作区时卸载并 abort */}
            <div className={tab === 'chat' ? 'h-[calc(100%-45px)]' : 'hidden'}>
              <ChatPanel
                repoId={repoId}
                transport={transport}
                embeddingProvider={embeddingProvider}
                onCitationClick={(c) => {
                  // 只跳到文件:选中文件节点 → 图上逐层展开到可见层并高亮节点与一跳边,右栏显示文件预览。
                  // 行号高亮依赖 FRONTEND_DESIGN 9.1.2 的 line/endLine,W3 后端 PR 前未实现。
                  setTab('detail');
                  jumpTo(c.nodeId);
                }}
              />
            </div>
            <div className={tab === 'detail' ? '' : 'hidden'}>
              {sel ? (
                <NodeDetail
                  repoId={repoId}
                  nodeId={sel.id}
                  api={api}
                  neighbors={sel}
                  doneTick={doneTick}
                  analysisDone={progress.status === 'done'}
                  onJump={jumpTo}
                />
              ) : (
                <p className="p-5 text-[13px] text-muted">单击图中节点查看详情。</p>
              )}
            </div>
          </aside>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <ProgressPanel p={progress} reconnecting={reconnecting} />
        </div>
      )}
    </main>
  );
}
