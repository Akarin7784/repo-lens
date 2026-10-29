import type { GraphData } from '@repolens/shared';
import { GraphDataSchema } from '@repolens/shared';
import type { ApiClient } from '../api/client';
import { sliceGraph, type GraphSlice } from './hierarchy';

/**
 * 图数据来源。页面用 `createApiSource`(GET /api/repos/:id/graph?parentId=);
 * `createFixtureSource` 只用于测试和离线兜底(示例数据,见 fixtures/README.md)。
 */
export interface GraphSource {
  readonly repoLabel: string;
  /** 按层懒加载:parentId=null 为 module 层。返回值已用 shared 的 GraphDataSchema 校验 */
  loadChildren(parentId: string | null): Promise<GraphSlice>;
  /**
   * 仅 fixture:一次给出全部 file→file 原始边,由前端上卷聚合。
   * 真实接口没有这个方法,边随每次切片返回,前端累积各层切片里的边。
   */
  rawEdges?(): GraphData['edges'];
  /** 仅 fixture:任意节点(含未加载)的 parentId,用于把原始边上卷到可见祖先 */
  parentOf?(id: string): string | null | undefined;
}

export function createApiSource(api: ApiClient, repoId: number, repoLabel: string): GraphSource {
  return { repoLabel, loadChildren: (parentId) => api.getGraph(repoId, parentId) };
}

/** 示例数据来源(测试 / 离线兜底)。不会出现在线上页面 */
export function createFixtureSource(repoLabel: string, data: unknown): GraphSource {
  const full = GraphDataSchema.parse(data);
  const parents = new Map<string, string | null>(full.nodes.map((n) => [n.id, n.parentId]));
  return {
    repoLabel,
    rawEdges: () => full.edges,
    loadChildren: async (parentId) => sliceGraph(full, parentId),
    parentOf: (id) => parents.get(id),
  };
}
