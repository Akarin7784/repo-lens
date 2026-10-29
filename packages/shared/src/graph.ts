import { z } from 'zod';
import {
  CommitShaSchema,
  DirIdSchema,
  ExternalIdSchema,
  FileIdSchema,
  ModuleIdSchema,
  NodeIdSchema,
} from './ids.js';

/** 单次图接口返回的节点上限(ARCHITECTURE.md §5.2) */
export const MAX_NODES_PER_RESPONSE = 300;

/**
 * module 判定规则(群内架构师决定,ARCHITECTURE.md §5.2):
 * 1. 仓库有 workspace(pnpm-workspace.yaml / package.json workspaces 等)时,每个 workspace 包的根目录是一个 module;
 *    嵌套在 workspace 包内部的目录不再往下拆 module(作为 dir)。
 * 2. 没有 workspace 时,取 `src/` 下一级目录为 module;没有 `src/` 则取仓库根下一级目录。
 * 3. 不属于任何 module 的其余文件(如根目录下的文件)归入根模块 `m:.`。
 * module 的 parentId 为 null;dir/file 的 parentId 是其直接上一层(dir 或 module)。
 */
const base = {
  label: z.string().min(1),
  path: z.string().min(1),
  weight: z.number().nonnegative().optional(),
  loc: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
};

/** 节点字段平铺,不放 data;不含 x/y(布局由前端 elkjs 计算) */
export const ModuleNodeSchema = z.object({
  id: ModuleIdSchema,
  type: z.literal('module'),
  parentId: z.null(),
  ...base,
});
export const DirNodeSchema = z.object({
  id: DirIdSchema,
  type: z.literal('dir'),
  parentId: z.union([ModuleIdSchema, DirIdSchema]),
  ...base,
});
/** externalDeps:该文件 import 的外部包名(去重),由分析器产出并入库;x: 节点据此派生 */
export const FileNodeSchema = z.object({
  id: FileIdSchema,
  type: z.literal('file'),
  parentId: z.union([ModuleIdSchema, DirIdSchema]),
  externalDeps: z.array(z.string().min(1)).optional(),
  ...base,
});
/** 派生节点:API 层仅在 includeExternal=true 时由 file.externalDeps 现算,不入库;path 为包名 */
export const ExternalNodeSchema = z.object({
  id: ExternalIdSchema,
  type: z.literal('external'),
  parentId: z.null(),
  label: z.string().min(1),
  path: z.string().min(1),
  weight: z.number().nonnegative().optional(),
});
export const GraphNodeSchema = z.discriminatedUnion('type', [
  ModuleNodeSchema,
  DirNodeSchema,
  FileNodeSchema,
  ExternalNodeSchema,
]);

export const IMPORT_KINDS = ['static', 'dynamic', 'type-only', 're-export', 'require'] as const;

/**
 * 边:type 固定为 'imports';kind 为 import 方式;srcFileId 为产生这条依赖的源文件。
 * 入库的只有 file→file 的原始 import 边(weight=1)。以下两类是 API 层返回图时现算的**派生数据,不入库**:
 * - aggregated 边(aggregated=true):端点落在返回范围外时上卷到范围内最近祖先,weight 为被聚合的 import 次数,
 *   kind 取被聚合边中最多的一种,srcFileId 保留一个代表性源文件;
 * - 指向 x:<包名> 的边:仅 includeExternal=true 时由 file.externalDeps 生成。
 */
export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: NodeIdSchema,
  target: NodeIdSchema,
  type: z.literal('imports'),
  kind: z.enum(IMPORT_KINDS),
  srcFileId: FileIdSchema,
  weight: z.number().int().positive(),
  aggregated: z.boolean().optional(),
});

export const GraphMetaSchema = z.object({
  repoId: z.number().int().positive(),
  commitSha: CommitShaSchema,
  parentId: NodeIdSchema.nullable(),
  language: z.literal('typescript'),
  cycles: z.array(z.array(NodeIdSchema)).optional(),
  /**
   * 仅根层请求(无 parentId)可能返回:建议前端直接展示其子节点的节点(module/dir)。
   * 根层子节点之间的边太少(<3)时,API 沿子树 loc 最大的可展开节点最多下探 3 层;边够用时不返回。
   */
  suggestedFocus: NodeIdSchema.optional(),
});

export const GraphDataSchema = z
  .object({
    nodes: z.array(GraphNodeSchema).max(MAX_NODES_PER_RESPONSE),
    edges: z.array(GraphEdgeSchema),
    meta: GraphMetaSchema,
  })
  .strict()
  .superRefine((g, ctx) => {
    const f = g.meta.suggestedFocus;
    if (f !== undefined && (g.meta.parentId !== null || !/^[md]:/.test(f)))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'suggestedFocus 只出现在根层响应中,且必须是 module/dir 节点',
      });
    const ids = new Set<string>();
    for (const n of g.nodes) {
      if (ids.has(n.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `重复节点 ${n.id}` });
      ids.add(n.id);
      if (n.type !== 'external' && n.id.slice(2) !== n.path)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `节点 ${n.id} 的 path 与 id 不一致` });
    }
    for (const e of g.edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `边 ${e.id} 指向不在本次返回中的节点`,
        });
      }
    }
  });

export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export type GraphMeta = z.infer<typeof GraphMetaSchema>;
export type GraphData = z.infer<typeof GraphDataSchema>;
