import { posix } from 'node:path';
import {
  findCycles,
  dirId,
  fileId,
  moduleId,
  type GraphEdge,
  type GraphNode,
  type ImportKind,
} from '@repolens/shared';
import type { ParsedFile, ResolvedImport } from '../types.js';
import { moduleRootOf, type ModuleLayout } from './modules.js';

export interface FileAnalysis {
  parsed: ParsedFile;
  /** 与 parsed.imports 一一对应 */
  resolved: ResolvedImport[];
}

export interface FullGraph {
  /** 全量节点(module/dir/file,不含派生的 external);API 层(T-003)按 parentId 投影成 ≤300 的 GraphData */
  nodes: GraphNode[];
  /** 入库的 file→file 原始 import 边(weight=1,同一对文件同一 kind 去重) */
  edges: GraphEdge[];
  /** 文件级强连通分量(≥2 个文件,或自引用);type-only 边不参与 */
  cycles: string[][];
  unresolved: Array<{ from: string; spec: string; line: number }>;
}

const lastSeg = (p: string) => (p === '.' ? '.' : (p.split('/').pop() ?? p));

// Tarjan SCC 移到 @repolens/shared,API 侧按已存储的边现场计算环时复用同一实现
export { findCycles } from '@repolens/shared';

/**
 * 组装 module → dir → file 三层图。纯函数:同样的输入(文件内容 + 布局)一定得到同样的 id 和顺序。
 */
export function buildGraph(files: FileAnalysis[], layout: ModuleLayout): FullGraph {
  const sorted = [...files].sort((a, b) => (a.parsed.path < b.parsed.path ? -1 : 1));
  const modules = new Map<string, GraphNode>();
  const dirs = new Map<string, GraphNode>();
  const fileNodes: GraphNode[] = [];
  const count = new Map<string, number>(); // 下属文件数 → module/dir 的 weight
  const bump = (id: string) => count.set(id, (count.get(id) ?? 0) + 1);

  for (const { parsed, resolved } of sorted) {
    const p = parsed.path;
    const mRoot = moduleRootOf(layout, p);
    const mId = moduleId(mRoot);
    if (!modules.has(mId))
      modules.set(mId, {
        id: mId,
        type: 'module',
        parentId: null,
        label: lastSeg(mRoot),
        path: mRoot,
      });
    bump(mId);
    // module 根到文件所在目录之间的每一级都是 dir
    let parent = mId;
    const dir = posix.dirname(p);
    const rel = mRoot === '.' ? dir : dir === mRoot ? '.' : dir.slice(mRoot.length + 1);
    if (rel !== '.') {
      let acc = mRoot === '.' ? '' : mRoot;
      for (const seg of rel.split('/')) {
        acc = acc ? `${acc}/${seg}` : seg;
        const dId = dirId(acc);
        if (!dirs.has(dId))
          dirs.set(dId, { id: dId, type: 'dir', parentId: parent as never, label: seg, path: acc });
        bump(dId);
        parent = dId;
      }
    }
    const ext = new Set<string>();
    for (const r of resolved) if (r.type === 'external') ext.add(r.pkg);
    fileNodes.push({
      id: fileId(p),
      type: 'file',
      parentId: parent as never,
      label: posix.basename(p),
      path: p,
      loc: parsed.loc,
      ...(ext.size ? { externalDeps: [...ext].sort() } : {}),
    });
  }

  const edgeMap = new Map<string, GraphEdge>();
  const unresolved: FullGraph['unresolved'] = [];
  const adj = new Map<string, Set<string>>();
  const fanIn = new Map<string, number>();
  for (const { parsed, resolved } of sorted) {
    const src = fileId(parsed.path);
    parsed.imports.forEach((imp, i) => {
      const r = resolved[i];
      if (!r || r.type === 'external' || r.type === 'asset') return;
      if (r.type === 'unresolved') {
        unresolved.push({ from: parsed.path, spec: imp.spec, line: imp.line });
        return;
      }
      const tgt = fileId(r.path);
      const kind: ImportKind = imp.kind;
      const id = `e:${src}->${tgt}:${kind}`;
      if (edgeMap.has(id)) return;
      edgeMap.set(id, {
        id,
        source: src as never,
        target: tgt as never,
        type: 'imports',
        kind,
        srcFileId: src as never,
        weight: 1,
      });
      fanIn.set(tgt, (fanIn.get(tgt) ?? 0) + 1);
      if (kind !== 'type-only') {
        if (!adj.has(src)) adj.set(src, new Set());
        adj.get(src)!.add(tgt);
      }
    });
  }

  for (const n of [...modules.values(), ...dirs.values()]) n.weight = count.get(n.id) ?? 0;
  for (const n of fileNodes) n.weight = fanIn.get(n.id) ?? 0;

  const byId = (a: GraphNode, b: GraphNode) => (a.id < b.id ? -1 : 1);
  return {
    nodes: [...[...modules.values()].sort(byId), ...[...dirs.values()].sort(byId), ...fileNodes],
    edges: [...edgeMap.values()],
    cycles: findCycles(
      fileNodes.map((n) => n.id),
      adj,
    ),
    unresolved,
  };
}
