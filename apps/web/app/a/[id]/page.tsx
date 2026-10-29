import { AnalysisWorkspace } from './AnalysisWorkspace';

/** /a/:repoId?job=<jobId>&repo=<owner/repo>。repoId 来自 POST /api/repos 的响应 */
export default async function AnalysisPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const q = await searchParams;
  const repoId = Number(id);
  // 不在前端拦截非法 id:交给后端校验(非正整数 → 400 BAD_REQUEST),页面显示对应中文提示
  const one = (v: string | string[] | undefined) => (typeof v === 'string' && v ? v : undefined);
  return <AnalysisWorkspace repoId={repoId} jobId={one(q.job)} repoLabel={one(q.repo)} />;
}
