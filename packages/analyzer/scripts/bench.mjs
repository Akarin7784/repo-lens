/* global process, performance, console */
// 用法:pnpm --filter @repolens/analyzer build && node scripts/bench.mjs <repoRoot>
import { execFileSync } from 'node:child_process';
import { GraphEdgeSchema, GraphNodeSchema } from '@repolens/shared';
import { analyzeRepo, scanSourceFiles } from '../dist/index.js';

const root = process.argv[2];
if (!root) throw new Error('usage: node scripts/bench.mjs <repoRoot>');
let commit = 'unknown';
try {
  commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  /* 非 git 目录 */
}
const t0 = performance.now();
const files = scanSourceFiles(root);
const scanMs = performance.now() - t0;
const r = await analyzeRepo({ root, files });
// >300 节点无法组成单个 GraphData 响应(投影是 T-003 的事),逐个校验节点与边
r.graph.nodes.forEach((n) => GraphNodeSchema.parse(n));
r.graph.edges.forEach((e) => GraphEdgeSchema.parse(e));
const byType = (t) => r.graph.nodes.filter((n) => n.type === t).length;
const kinds = {};
for (const e of r.graph.edges) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
console.log(
  JSON.stringify(
    {
      node: process.version,
      commit,
      resolverMode: r.resolverMode,
      layout: r.layout,
      files: r.stats.files,
      nodes: {
        total: r.stats.nodes,
        module: byType('module'),
        dir: byType('dir'),
        file: byType('file'),
      },
      edges: r.stats.edges,
      edgeKinds: kinds,
      cycles: r.graph.cycles.length,
      externalPackages: r.stats.externalPackages,
      unresolved: r.stats.unresolved,
      unresolvedSample: r.graph.unresolved.slice(0, 5),
      syntaxErrorFiles: r.stats.syntaxErrorFiles,
      resolver: r.stats.resolver,
      ms: {
        scan: Math.round(scanMs),
        ...Object.fromEntries(Object.entries(r.stats.ms).map(([k, v]) => [k, Math.round(v)])),
      },
    },
    null,
    2,
  ),
);
