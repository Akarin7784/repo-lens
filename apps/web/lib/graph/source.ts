import type { GraphData } from '@repolens/shared';
import { GraphDataSchema } from '@repolens/shared';
import { sliceGraph, type GraphSlice } from './hierarchy';

/** 图数据来源。T-004 用 fixture 实现;T-003 合并后换成调用 GET /api/repos/:id/graph?parentId= 的实现 */
export interface GraphSource {
  readonly repoLabel: string;
  readonly commitSha: string;
  /** fixture 模式下一次给出全部原始边;接真实接口后改为随切片返回 */
  rawEdges(): GraphData['edges'];
  loadChildren(parentId: string | null): Promise<GraphSlice>;
  /** fixture 模式:任意节点(含未加载)的 parentId,用于把原始边上卷到可见祖先 */
  parentOf?(id: string): string | null | undefined;
  /** meta.cycles(环上的 file id);接真实接口后来自 T-003 的响应 */
  cycles?(): readonly (readonly string[])[];
}

export function createFixtureSource(repoLabel: string, data: unknown): GraphSource {
  const full = GraphDataSchema.parse(data);
  const parents = new Map<string, string | null>(full.nodes.map((n) => [n.id, n.parentId]));
  return {
    repoLabel,
    commitSha: full.meta.commitSha,
    rawEdges: () => full.edges,
    loadChildren: async (parentId) => sliceGraph(full, parentId),
    parentOf: (id) => parents.get(id),
    cycles: () => full.meta.cycles ?? [],
  };
}
