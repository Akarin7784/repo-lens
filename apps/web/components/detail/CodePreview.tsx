'use client';
import type { FileContent } from '@repolens/shared';
import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../lib/api/client';
import { EXCLUDED_FALLBACK, EXCLUDED_TEXT, previewErrorOf } from '../../lib/api/errors';
import {
  PREVIEW_MAX_LINE_CHARS,
  PREVIEW_MAX_LINES,
  langOf,
  shikiHighlight,
  type Highlighter,
  type Tok,
} from '../../lib/preview/highlight';

type Props = {
  repoId: number;
  path: string;
  api: Pick<ApiClient, 'getFile'>;
  /** 可注入,方便单测;默认按需加载 Shiki */
  highlighter?: Highlighter;
};

type Load =
  | { state: 'loading' }
  | { state: 'error'; text: string; retry: boolean }
  | { state: 'ok'; data: FileContent };

/**
 * T-223 节点详情里的代码预览。由父组件在展开「查看代码」后挂载;切换节点时父组件以 key 重新挂载。
 * 请求用 AbortController + 序号,旧响应不会覆盖新节点。
 */
export function CodePreview({ repoId, path, api, highlighter = shikiHighlight }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setLoad({ state: 'loading' });
    api
      .getFile(repoId, path, ctl.signal)
      .then((data) => {
        if (!ctl.signal.aborted) setLoad({ state: 'ok', data });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setLoad({ state: 'error', ...previewErrorOf(e) });
      });
    return () => ctl.abort();
  }, [api, repoId, path, retry]);

  return (
    <div data-testid="code-preview" className="flex min-w-0 flex-col gap-2">
      <div aria-live="polite" className="text-[13px]">
        {load.state === 'loading' && (
          <p data-testid="preview-loading" className="text-muted">
            正在加载源码…
          </p>
        )}
        {load.state === 'error' && (
          <div data-testid="preview-error" className="flex flex-col items-start gap-2">
            <p className="text-fg">{load.text}</p>
            {load.retry && (
              <button
                type="button"
                onClick={() => setRetry((r) => r + 1)}
                className="rounded-control border border-line bg-panel px-3 py-1 text-[13px] text-fg hover:border-accent-strong"
              >
                重试
              </button>
            )}
          </div>
        )}
        {load.state === 'ok' && load.data.excluded && (
          <div
            data-testid="preview-excluded"
            data-reason={load.data.excluded.reason}
            className="rounded-control border border-line bg-cite px-3 py-2"
          >
            <p className="font-semibold text-fg">已排除</p>
            <p className="text-muted">
              {Object.hasOwn(EXCLUDED_TEXT, load.data.excluded.reason)
                ? EXCLUDED_TEXT[load.data.excluded.reason]
                : EXCLUDED_FALLBACK}
            </p>
          </div>
        )}
      </div>
      {load.state === 'ok' && !load.data.excluded && (
        <CodeBody data={load.data} path={path} highlighter={highlighter} />
      )}
    </div>
  );
}

/** 前端兜底:行数和单行长度限制(纯函数,便于单测) */
export function prepareLines(content: string) {
  const all = content === '' ? [] : content.split('\n');
  const lines = all.slice(0, PREVIEW_MAX_LINES);
  const linesCut = all.length > PREVIEW_MAX_LINES;
  const longLine = lines.some((l) => l.length > PREVIEW_MAX_LINE_CHARS);
  const shown = longLine
    ? lines.map((l) => (l.length > PREVIEW_MAX_LINE_CHARS ? l.slice(0, PREVIEW_MAX_LINE_CHARS) : l))
    : lines;
  return { lines: shown, linesCut, longLine };
}

function CodeBody({
  data,
  path,
  highlighter,
}: {
  data: FileContent;
  path: string;
  highlighter: Highlighter;
}) {
  const content = data.content ?? '';
  const { lines, linesCut, longLine } = useMemo(() => prepareLines(content), [content]);
  const lang = langOf(path);
  const [tokens, setTokens] = useState<Tok[][] | null>(null);
  const [hlFailed, setHlFailed] = useState(false);

  useEffect(() => {
    setTokens(null);
    setHlFailed(false);
    // 超长行不做高亮:避免正则引擎在单行上卡住页面
    if (!lang || longLine || lines.length === 0) return;
    let alive = true;
    highlighter(lines.join('\n'), lang)
      .then((t) => alive && setTokens(t))
      .catch(() => alive && setHlFailed(true));
    return () => {
      alive = false;
    };
  }, [highlighter, lang, longLine, lines]);

  const startLine = data.start ?? 1;
  // 接口截断(hasMore,未给 end 时最多 FILE_MAX_LINES 行)与前端行数限制合并成一条提示
  const cut = data.hasMore || linesCut;
  const notes: string[] = [];
  if (cut)
    notes.push(
      `仅显示前 ${lines.length} 行${data.totalLines !== null ? `(共 ${data.totalLines} 行)` : ''}。`,
    );
  if (longLine)
    notes.push(
      `存在超过 ${PREVIEW_MAX_LINE_CHARS} 字符的超长行:已截断显示,且整份文件不做语法高亮。`,
    );
  if (hlFailed) notes.push('语法高亮加载失败,已按纯文本显示。');

  if (lines.length === 0)
    return (
      <p className="text-[13px] text-muted" data-testid="preview-empty">
        空文件。
      </p>
    );

  return (
    <>
      {notes.length > 0 && (
        <div data-testid="preview-notes" aria-live="polite" className="text-[12px] text-muted">
          {notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
      <div
        data-testid="preview-scroll"
        tabIndex={0}
        aria-label={`${path} 源码`}
        className="max-h-[60vh] overflow-auto rounded-control border border-line bg-panel max-[767px]:max-h-[40dvh]"
      >
        <pre
          data-testid="preview-code"
          data-highlighted={tokens ? 'true' : 'false'}
          className="m-0 w-max min-w-full py-2 font-mono text-[12px] leading-5 whitespace-pre"
        >
          {lines.map((l, i) => (
            <div key={i} className="flex">
              <span
                aria-hidden
                className="sticky left-0 inline-block w-12 shrink-0 select-none bg-panel pr-3 text-right text-muted"
              >
                {startLine + i}
              </span>
              <code className="pr-4">
                {tokens?.[i]
                  ? tokens[i]!.map((t, j) => (
                      <span
                        key={j}
                        className="shiki-tok"
                        style={{ color: t.color, '--shiki-dark': t.dark } as React.CSSProperties}
                      >
                        {t.content}
                      </span>
                    ))
                  : l}
              </code>
            </div>
          ))}
        </pre>
      </div>
    </>
  );
}
