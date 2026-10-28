/**
 * 示例仓库的离线布局文件(ARCHITECTURE.md §5.2、FRONTEND_DESIGN.md §4.5):
 * `public/layouts/{owner}-{repo}-{commitSha}.json`,结构 `{ commitSha, positions: { [nodeId]: [x, y] } }`。
 * T-004 只留读取接口;生成脚本 scripts/gen-layout.ts 在示例仓库预解析(锁定 commitSha)后再做。
 */
export type LayoutFile = { commitSha: string; positions: Record<string, [number, number]> };

/** 已生成布局文件的示例仓库清单(目前为空,避免对不存在的文件发请求) */
export const AVAILABLE_LAYOUTS = new Set<string>();

export const layoutFileName = (owner: string, repo: string, commitSha: string) =>
  `${owner}-${repo}-${commitSha}.json`;
export const layoutFileUrl = (owner: string, repo: string, commitSha: string) =>
  `/layouts/${layoutFileName(owner, repo, commitSha)}`;

/** 校验 commitSha;不一致返回 null 并告警,调用方退回 elkjs 实时计算 */
export function parseLayoutFile(
  json: unknown,
  expectedSha: string,
  file = '(inline)',
): LayoutFile | null {
  if (!json || typeof json !== 'object') return null;
  const f = json as Partial<LayoutFile>;
  if (f.commitSha !== expectedSha) {
    console.warn('[layout] commitSha mismatch', { file, graph: expectedSha, layout: f.commitSha });
    return null;
  }
  if (!f.positions || typeof f.positions !== 'object') return null;
  return { commitSha: f.commitSha, positions: f.positions };
}

export async function loadLayoutFile(
  owner: string,
  repo: string,
  commitSha: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LayoutFile | null> {
  const name = layoutFileName(owner, repo, commitSha);
  if (!AVAILABLE_LAYOUTS.has(name)) return null;
  try {
    const res = await fetchImpl(layoutFileUrl(owner, repo, commitSha));
    return res.ok ? parseLayoutFile(await res.json(), commitSha, name) : null;
  } catch {
    return null;
  }
}
