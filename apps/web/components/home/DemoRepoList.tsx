import Link from 'next/link';
import { SAMPLE_REPOS } from '../../lib/fixtures';

const COMING_SOON = ['colinhacks/zod', 'trpc/trpc'];

export function DemoRepoList() {
  return (
    <ul className="flex flex-wrap justify-center gap-2">
      {Object.entries(SAMPLE_REPOS).map(([id, s]) => (
        <li key={id}>
          <Link
            href={`/a/${id}`}
            title={s.blurb}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1 text-[13px] text-fg transition-colors duration-200 ease-out hover:border-accent hover:text-accent-strong-hover"
          >
            <span className="font-mono">
              {s.owner}/{s.repo}
            </span>
            <span className="text-muted">示例</span>
          </Link>
        </li>
      ))}
      {COMING_SOON.map((r) => (
        <li key={r}>
          <span
            aria-disabled
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-line px-3 py-1 text-[13px] text-muted"
          >
            <span className="font-mono">{r}</span>即将支持
          </span>
        </li>
      ))}
    </ul>
  );
}
