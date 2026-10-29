'use client';
import type { NodeDetail as NodeDetailData } from '@repolens/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../lib/api/client';
import { userMessageOf } from '../../lib/api/errors';

/** 图中当前可见层级的一跳邻居(来自 GraphView,不发请求) */
export type GraphNeighbors = { deps: string[]; dependents: string[] };

type Props = {
  repoId: number;
  nodeId: string;
  api: Pick<ApiClient, 'getNodeDetail'>;
  neighbors?: GraphNeighbors;
  /** 进度流收到 done 时递增:summary 为 null 时据此重取 */
  doneTick?: number;
  onJump(nodeId: string): void;
};

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ok'; data: NodeDetailData };

const KIND_TEXT: Record<NodeDetailData['kind'], string> = {
  module: '模块',
  dir: '目录',
  file: '文件',
  external: '外部包',
};

/** `f:src/a/b.ts` → 面包屑 [src → d:src] [a → d:src/a] [b.ts → 自身] */
export function breadcrumbs(id: string, path: string): { label: string; id: string | null }[] {
  if (id.startsWith('x:') || path === '.' || !path) return [{ label: path || id, id: null }];
  const parts = path.split('/');
  return parts.map((label, i) =>
    i === parts.length - 1
      ? { label, id: null }
      : { label, id: `d:${parts.slice(0, i + 1).join('/')}` },
  );
}

const short = (id: string) => id.replace(/^[a-z]:/, '');

/**
 * 右栏节点详情(T-222)。数据只来自 GET /api/repos/:id/nodes/:nodeId,不造数据。
 * 切换节点时 abort 旧请求,并用请求序号丢弃过期响应。
 */
export function NodeDetail({ repoId, nodeId, api, neighbors, doneTick = 0, onJump }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [retry, setRetry] = useState(0);
  const seq = useRef(0);
  const lastSummaryNull = useRef(false);

  useEffect(() => {
    const my = ++seq.current;
    const ctl = new AbortController();
    setLoad({ state: 'loading' });
    api
      .getNodeDetail(repoId, nodeId, ctl.signal)
      .then((data) => {
        if (seq.current !== my) return;
        lastSummaryNull.current = data.summary === null;
        setLoad({ state: 'ok', data });
      })
      .catch((e: unknown) => {
        if (seq.current !== my || ctl.signal.aborted) return;
        setLoad({ state: 'error', message: userMessageOf(e) });
      });
    return () => ctl.abort();
  }, [api, repoId, nodeId, retry]);

  // 摘要还没生成:收到 done 后静默重取一次(不清空已显示的内容)
  useEffect(() => {
    if (doneTick === 0 || !lastSummaryNull.current) return;
    const my = ++seq.current;
    const ctl = new AbortController();
    api
      .getNodeDetail(repoId, nodeId, ctl.signal)
      .then((data) => {
        if (seq.current !== my) return;
        lastSummaryNull.current = data.summary === null;
        setLoad({ state: 'ok', data });
      })
      .catch(() => {});
    return () => ctl.abort();
    // 只由 doneTick 触发
  }, [doneTick]);

  const doRetry = useCallback(() => setRetry((r) => r + 1), []);

  return (
    <section aria-label="节点详情" data-testid="node-detail" className="flex flex-col gap-5 p-5">
      {load.state === 'error' ? (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-[14px] text-fg">加载节点详情失败:{load.message}</p>
          <button
            type="button"
            onClick={doRetry}
            className="rounded-control border border-line bg-panel px-3 py-1.5 text-[13px] text-fg hover:border-accent-strong"
          >
            重试
          </button>
        </div>
      ) : load.state === 'loading' ? (
        <div aria-busy="true" aria-label="加载中" className="flex flex-col gap-3">
          <p className="font-mono text-[13px] text-muted">{short(nodeId)}</p>
          <Skeleton />
        </div>
      ) : (
        <Body d={load.data} neighbors={neighbors} onJump={onJump} />
      )}
    </section>
  );
}

function Skeleton() {
  return (
    <div data-testid="summary-skeleton" className="flex flex-col gap-2">
      {[100, 92, 64].map((w) => (
        <div
          key={w}
          className="h-3 animate-pulse rounded-full bg-line"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}

function Body({
  d,
  neighbors,
  onJump,
}: {
  d: NodeDetailData;
  neighbors?: GraphNeighbors;
  onJump(id: string): void;
}) {
  const crumbs = breadcrumbs(d.id, d.path);
  return (
    <>
      <header className="flex flex-col gap-2">
        <nav aria-label="路径" className="flex flex-wrap items-center gap-1 font-mono text-[13px]">
          {crumbs.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              {i > 0 && <span className="text-muted">/</span>}
              {c.id ? (
                <button
                  type="button"
                  className="text-muted hover:text-accent-strong hover:underline"
                  onClick={() => onJump(c.id!)}
                >
                  {c.label}
                </button>
              ) : (
                <span className="font-semibold text-fg">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
        <span className="w-fit rounded-full border border-line px-2 py-0.5 text-[12px] text-muted">
          {KIND_TEXT[d.kind]}
        </span>
      </header>

      <div>
        <h3 className="mb-2 font-serif text-[15px] font-semibold text-fg">摘要</h3>
        {d.summary === null ? (
          <>
            <Skeleton />
            <p className="mt-2 text-[12px] text-muted">摘要生成中,分析完成后自动刷新。</p>
          </>
        ) : d.summary.trim() === '' ? (
          <p className="text-[14px] text-muted">暂无摘要。</p>
        ) : (
          <p className="whitespace-pre-wrap text-[14px] leading-6 text-fg">{d.summary}</p>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center">
        {[
          ['LOC', d.loc],
          ['入度', d.inDegree],
          ['出度', d.outDegree],
        ].map(([k, v]) => (
          <div key={k} className="rounded-control border border-line bg-panel px-2 py-2">
            <dt className="text-[12px] text-muted">{k}</dt>
            <dd className="font-mono text-[15px] text-fg">{v}</dd>
          </div>
        ))}
      </dl>

      {d.exports.length > 0 && (
        <div>
          <h3 className="mb-2 font-serif text-[15px] font-semibold text-fg">导出符号</h3>
          <ul className="flex flex-wrap gap-1.5">
            {d.exports.map((x) => (
              <li
                key={x}
                className="rounded-full border border-line bg-panel px-2 py-0.5 font-mono text-[12px] text-fg"
              >
                {x}
              </li>
            ))}
          </ul>
        </div>
      )}

      <IdList
        title="被依赖最多"
        ids={d.topDependents}
        empty="没有其它节点依赖它。"
        onJump={onJump}
      />
      {neighbors && (
        <>
          <IdList
            title="依赖于(图中可见层级)"
            ids={neighbors.deps}
            empty="当前可见层级中没有出边。"
            onJump={onJump}
          />
          <IdList
            title="被依赖(图中可见层级)"
            ids={neighbors.dependents}
            empty="当前可见层级中没有入边。"
            onJump={onJump}
          />
        </>
      )}
    </>
  );
}

function IdList({
  title,
  ids,
  empty,
  onJump,
}: {
  title: string;
  ids: string[];
  empty: string;
  onJump(id: string): void;
}) {
  return (
    <div>
      <h3 className="mb-2 font-serif text-[15px] font-semibold text-fg">
        {title} <span className="font-sans text-[12px] font-normal text-muted">{ids.length}</span>
      </h3>
      {ids.length === 0 ? (
        <p className="text-[13px] text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {ids.map((id) => (
            <li key={id}>
              <button
                type="button"
                title={id}
                onClick={() => onJump(id)}
                className="w-full truncate rounded-control px-2 py-1 text-left font-mono text-[13px] text-fg hover:bg-cite hover:text-accent-strong"
              >
                {short(id)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
