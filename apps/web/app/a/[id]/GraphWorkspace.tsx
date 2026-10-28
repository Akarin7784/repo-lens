'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { GraphView } from '../../../components/graph/GraphView';
import { ThemeToggle } from '../../../components/theme/ThemeToggle';
import { createFixtureSource } from '../../../lib/graph/source';
import { SAMPLE_REPOS, type SampleId } from '../../../lib/fixtures';

export function GraphWorkspace({ sampleId }: { sampleId: SampleId }) {
  const s = SAMPLE_REPOS[sampleId];
  const source = useMemo(() => createFixtureSource(`${s.owner}/${s.repo}`, s.data), [s]);
  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-line bg-bg px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="font-serif text-[17px] font-semibold text-fg">
            RepoLens
          </Link>
          <span className="truncate font-mono text-[13px] text-fg">
            {s.owner}/{s.repo}
          </span>
          <span
            className="rounded-full bg-cite px-2 py-0.5 text-[12px] text-fg"
            title="fixture,不是真实解析结果"
          >
            示例数据
          </span>
        </div>
        <ThemeToggle />
      </header>
      <div className="min-h-0 flex-1">
        <GraphView source={source} owner={s.owner} repo={s.repo} />
      </div>
    </main>
  );
}
