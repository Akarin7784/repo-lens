import { posix } from 'node:path';
import { dirId, fileId, findCycles, moduleId, type GraphNode } from '@repolens/shared';
import type { StoredGraph } from './store.js';

/** 由 file 行重建 module → dir → file 全量树(与 analyzer buildGraph 同规则) */
export class GraphIndex {
  readonly nodes = new Map<string, GraphNode>();
  readonly children = new Map<string | null, string[]>();
  readonly pathById = new Map<number, string>();
  readonly fileCount = new Map<string, number>();
  readonly fanIn = new Map<string, number>();

  constructor(readonly g: StoredGraph) {
    const files = [...g.files].sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const e of g.edges) this.fanIn.set(e.dstId, (this.fanIn.get(e.dstId) ?? 0) + 1);
    for (const f of files) {
      this.pathById.set(f.id, f.path);
      const mRoot = f.moduleId.slice(2);
      const mId = moduleId(mRoot);
      this.add({
        id: mId,
        type: 'module',
        parentId: null,
        label: mRoot === '.' ? '.' : posix.basename(mRoot),
        path: mRoot,
      });
      let parent = mId;
      const chain = [mId];
      const dir = f.dirPath;
      const rel = mRoot === '.' ? dir : dir === mRoot ? '.' : dir.slice(mRoot.length + 1);
      if (rel !== '.') {
        let acc = mRoot === '.' ? '' : mRoot;
        for (const seg of rel.split('/')) {
          acc = acc ? `${acc}/${seg}` : seg;
          const dId = dirId(acc);
          this.add({ id: dId, type: 'dir', parentId: parent as never, label: seg, path: acc });
          chain.push(dId);
          parent = dId;
        }
      }
      for (const c of chain) this.fileCount.set(c, (this.fileCount.get(c) ?? 0) + 1);
      const fid = fileId(f.path);
      this.add({
        id: fid,
        type: 'file',
        parentId: parent as never,
        label: posix.basename(f.path),
        path: f.path,
        loc: f.loc,
        weight: this.fanIn.get(fid) ?? 0,
        ...(f.externalDeps.length ? { externalDeps: f.externalDeps } : {}),
      });
    }
    for (const n of this.nodes.values())
      if (n.type !== 'file') n.weight = this.fileCount.get(n.id) ?? 0;
  }

  private _cycles?: string[][];
  /**
   * 文件级强连通分量(≥2 个文件或自引用;type-only 边不参与),由已存储的边现场计算,
   * 与分析器 graph.cycles 同口径。/graph 投影与 /nodes inCycle 都用它,不依赖 task.stats
   * (stats 只做展示统计,重跑/复用已入库图时可能为空)。
   */
  get cycles(): string[][] {
    if (!this._cycles) {
      const adj = new Map<string, Set<string>>();
      for (const e of this.g.edges) {
        if (e.kind === 'type-only') continue;
        if (!this.nodes.has(e.srcId) || !this.nodes.has(e.dstId)) continue;
        if (!adj.has(e.srcId)) adj.set(e.srcId, new Set());
        adj.get(e.srcId)!.add(e.dstId);
      }
      const files = [...this.nodes.values()].filter((n) => n.type === 'file').map((n) => n.id);
      this._cycles = findCycles(files, adj);
    }
    return this._cycles;
  }

  private add(n: GraphNode) {
    if (this.nodes.has(n.id)) return;
    this.nodes.set(n.id, n);
    const k = n.parentId ?? null;
    if (!this.children.has(k)) this.children.set(k, []);
    this.children.get(k)!.push(n.id);
  }

  /** 祖先链(含自身),自底向上 */
  ancestors(id: string): string[] {
    const out: string[] = [];
    let cur = this.nodes.get(id);
    while (cur) {
      out.push(cur.id);
      cur = cur.parentId ? this.nodes.get(cur.parentId) : undefined;
    }
    return out;
  }

  filesUnder(id: string): GraphNode[] {
    const n = this.nodes.get(id);
    if (!n) return [];
    if (n.type === 'file') return [n];
    return (this.children.get(id) ?? []).flatMap((c) => this.filesUnder(c));
  }
}
