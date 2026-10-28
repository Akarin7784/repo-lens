import { z } from 'zod';
import { CommitShaSchema, NodeIdSchema } from './ids.js';

/** 单次图接口返回的节点上限(ARCHITECTURE.md §5.2) */
export const MAX_NODES_PER_RESPONSE = 300;

export const GraphNodeSchema = z.object({
  id: NodeIdSchema,
  type: z.enum(['module', 'file', 'external']),
  label: z.string().min(1),
  parentId: NodeIdSchema.optional(),
  path: z.string().optional(),
  weight: z.number().nonnegative().optional(),
  loc: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
});

export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: NodeIdSchema,
  target: NodeIdSchema,
  kind: z.enum(['import', 'type-import', 'dynamic-import', 're-export', 'aggregated']),
  weight: z.number().int().positive(),
});

export const GraphMetaSchema = z.object({
  repoId: z.number().int().positive(),
  commitSha: CommitShaSchema,
  parentId: NodeIdSchema.nullable(),
  language: z.literal('typescript'),
  cycles: z.array(z.array(NodeIdSchema)).optional(),
});

/** 注意:不含 x/y 与 meta.layout,布局由前端 elkjs 计算 */
export const GraphDataSchema = z
  .object({
    nodes: z.array(GraphNodeSchema).max(MAX_NODES_PER_RESPONSE),
    edges: z.array(GraphEdgeSchema),
    meta: GraphMetaSchema,
  })
  .strict()
  .superRefine((g, ctx) => {
    const ids = new Set<string>();
    for (const n of g.nodes) {
      if (ids.has(n.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `重复节点 ${n.id}` });
      ids.add(n.id);
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
export type GraphMeta = z.infer<typeof GraphMetaSchema>;
export type GraphData = z.infer<typeof GraphDataSchema>;
