import { posix } from 'node:path';
import {
  MAX_NODES_PER_RESPONSE,
  dirId,
  externalId,
  fileId,
  moduleId,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type ImportKind,
  type NodeDetail,
} from '@repolens/shared';
import type { StoredGraph } from '@repolens/db';

/** 外部包节点最多占用的名额(从 300 里扣) */
export const MAX_EXTERNAL_NODES = 50;

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

export interface ProjectOptions {
  repoId: number;
  commitSha: string;
  parentId: string | null;
  includeExternal: boolean;
  cycles?: string[][];
  maxNodes?: number;
}

const byWeight = (a: GraphNode, b: GraphNode) =>
  (b.weight ?? 0) - (a.weight ?? 0) || (a.id < b.id ? -1 : 1);

function topKind(kinds: Map<ImportKind, number>): ImportKind {
  return [...kinds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
}

/**
 * 按 parentId 投影成一层 GraphData:
 * - parentId 为空返回所有 module,否则返回其直接子节点;按 weight 截断到 ≤300(x: 节点占用名额);
 * - 每条原始 file→file 边的两端上卷到本层可见的最近祖先;两端都是可见原文件时原样返回,
 *   否则聚合为 a:<src>-><tgt>(aggregated=true,weight=次数,kind 取最多的一种,srcFileId 取路径最小的源文件);
 * - 跨出 parentId 子树的边:子树内一端上卷到可见子节点,子树外一端写成它在同一展开层级上的祖先
 *   (父节点在 parentId 祖先链上的那个节点,如展开 m:packages/core 时 f:packages/utils/src/a.ts → m:packages/utils),
 *   方向保持原边方向(出边/入边都返回),按 (source,target) 去重聚合为 a:<s>-><t>,aggregated=true;
 *   两端都在子树外的边不返回;子树内但因 300 截断不可见的端点也不返回;
 * - 自环(上卷后两端相同)不返回;
 * - includeExternal=true 时按 file.externalDeps 派生 x: 节点与边。
 */
export function projectGraph(ix: GraphIndex, o: ProjectOptions): GraphData | null {
  return projectGraphWithInfo(ix, o)?.graph ?? null;
}

export interface ProjectionInfo {
  graph: GraphData;
  /** P 的直接子节点(或根层 module)因 300 上限被截掉了一部分 */
  truncated: boolean;
  /** 因名额不足被丢弃的边界节点数 */
  droppedBoundary: number;
}

/**
 * 名额顺序:x: 外部包(includeExternal 时,≤50)→ P 的子节点按 weight 截断 → 剩余名额按 weight 给边界节点。
 * 即边界节点永远排在 P 的子节点之后;子节点自身超 300 时照旧截断并标记 truncated。
 */
export function projectGraphWithInfo(ix: GraphIndex, o: ProjectOptions): ProjectionInfo | null {
  if (o.parentId && !ix.nodes.has(o.parentId)) return null;
  if (o.parentId && ix.nodes.get(o.parentId)!.type === 'file') return null;
  const max = o.maxNodes ?? MAX_NODES_PER_RESPONSE;

  // 外部包:按引用文件数排序
  const pkgFiles = new Map<string, string[]>();
  if (o.includeExternal)
    for (const f of o.parentId
      ? ix.filesUnder(o.parentId)
      : [...ix.nodes.values()].filter((n) => n.type === 'file'))
      if (f.type === 'file')
        for (const p of f.externalDeps ?? []) {
          if (!pkgFiles.has(p)) pkgFiles.set(p, []);
          pkgFiles.get(p)!.push(f.id);
        }
  const pkgs = [...pkgFiles]
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.min(MAX_EXTERNAL_NODES, max));

  const kids = (ix.children.get(o.parentId) ?? []).map((id) => ix.nodes.get(id)!);
  const shown = kids.sort(byWeight).slice(0, max - pkgs.length);
  const visible = new Set(shown.map((n) => n.id));
  const visOf = (id: string) => ix.ancestors(id).find((a) => visible.has(a)) ?? null;
  // parentId 的祖先链(含 null 根),用于给子树外端点找"同一展开层级上的祖先"
  const parentChain = new Set<string | null>([
    null,
    ...(o.parentId ? ix.ancestors(o.parentId) : []),
  ]);
  /** 子树外的端点:取它的祖先中、父节点落在 parentId 祖先链上的那一个(即前端画布上已存在的兄弟层节点) */
  const outsideOf = (id: string): string | null => {
    if (!o.parentId) return null;
    const chain = ix.ancestors(id);
    if (chain.includes(o.parentId)) return null; // 在子树内(可能被 300 截断),不算范围外
    return chain.find((a) => parentChain.has(ix.nodes.get(a)!.parentId ?? null)) ?? null;
  };

  const edges: GraphEdge[] = [];
  const agg = new Map<
    string,
    { s: string; t: string; n: number; kinds: Map<ImportKind, number>; src: string }
  >();
  const pushAgg = (s: string, t: string, kind: ImportKind, srcPath: string, n = 1) => {
    const k = `${s}->${t}`;
    const a = agg.get(k) ?? { s, t, n: 0, kinds: new Map(), src: srcPath };
    a.n += n;
    a.kinds.set(kind, (a.kinds.get(kind) ?? 0) + n);
    if (srcPath < a.src) a.src = srcPath;
    agg.set(k, a);
  };
  for (const e of ix.g.edges) {
    const vs = visOf(e.srcId);
    const vt = visOf(e.dstId);
    // 至多一端在范围外:范围外一端替换成同层祖先;两端都在范围外的边不属于本层
    const s = vs ?? (vt ? outsideOf(e.srcId) : null);
    const t = vt ?? (vs ? outsideOf(e.dstId) : null);
    if (!s || !t || s === t) continue;
    const srcPath = ix.pathById.get(e.srcFileId) ?? e.srcId.slice(2);
    if (vs && vt && s === e.srcId && t === e.dstId)
      edges.push({
        id: `e:${s}->${t}:${e.kind}`,
        source: s as never,
        target: t as never,
        type: 'imports',
        kind: e.kind,
        srcFileId: fileId(srcPath) as never,
        weight: e.weight,
      });
    else pushAgg(s, t, e.kind, srcPath, e.weight);
  }

  const extNodes: GraphNode[] = [];
  for (const [pkg, files] of pkgs) {
    const xid = externalId(pkg);
    extNodes.push({
      id: xid as never,
      type: 'external',
      parentId: null,
      label: pkg,
      path: pkg,
      weight: files.length,
    });
    for (const f of files) {
      const s = visOf(f);
      if (s) pushAgg(s, xid, 'static', f.slice(2));
    }
  }
  // 范围外端点(同层祖先节点)也放进 nodes:shared 的 GraphDataSchema 要求边两端都在本次返回中。
  // 它们与前端画布上已有的节点 id/内容一致,按 id 合并即可;名额不够时按 weight 取前若干,其余边丢弃。
  const boundaryIds = new Set<string>();
  for (const a of agg.values())
    for (const id of [a.s, a.t]) if (!visible.has(id) && !id.startsWith('x:')) boundaryIds.add(id);
  const boundary = [...boundaryIds]
    .map((id) => ix.nodes.get(id)!)
    .sort(byWeight)
    .slice(0, Math.max(0, max - shown.length - pkgs.length));
  const kept = new Set(boundary.map((n) => n.id));
  for (const [k, a] of agg) {
    if ((boundaryIds.has(a.s) && !kept.has(a.s)) || (boundaryIds.has(a.t) && !kept.has(a.t)))
      continue;
    const raw = a.t.startsWith('x:') && a.s.startsWith('f:') && a.n === 1;
    edges.push({
      id: `${a.t.startsWith('x:') ? 'x' : 'a'}:${k}`,
      source: a.s as never,
      target: a.t as never,
      type: 'imports',
      kind: topKind(a.kinds),
      srcFileId: fileId(a.src) as never,
      weight: a.n,
      ...(raw ? {} : { aggregated: true }),
    });
  }

  // 环投影到可见节点,去掉连续重复,至少两个不同节点才保留
  const cycles: string[][] = [];
  const seen = new Set<string>();
  for (const c of o.cycles ?? []) {
    const p: string[] = [];
    for (const id of c) {
      const v = visOf(id);
      if (v && p.at(-1) !== v) p.push(v);
    }
    if (p.length > 1 && p[0] === p.at(-1)) p.pop();
    if (new Set(p).size < 2 || new Set(p).size !== p.length) continue;
    const key = p.join('|');
    if (!seen.has(key)) {
      seen.add(key);
      cycles.push(p);
    }
  }

  const graph: GraphData = {
    nodes: [...shown, ...boundary, ...extNodes],
    edges,
    meta: {
      repoId: o.repoId,
      commitSha: o.commitSha,
      parentId: (o.parentId ?? null) as never,
      language: 'typescript',
      ...(cycles.length ? { cycles: cycles as never } : {}),
    },
  };
  return {
    graph,
    truncated: shown.length < kids.length,
    droppedBoundary: boundaryIds.size - boundary.length,
  };
}

/** 节点详情(不含 exports,由调用方补) */
export function nodeDetail(ix: GraphIndex, id: string): Omit<NodeDetail, 'exports'> | null {
  if (id.startsWith('x:')) {
    const pkg = id.slice(2);
    const users = [...ix.nodes.values()]
      .filter((n) => n.type === 'file' && n.externalDeps?.includes(pkg))
      .map((n) => n.id)
      .sort();
    if (!users.length) return null;
    return {
      id: id as never,
      kind: 'external',
      path: pkg,
      summary: null,
      loc: 0,
      inDegree: users.length,
      outDegree: 0,
      topDependents: users.slice(0, 10) as never,
    };
  }
  const n = ix.nodes.get(id);
  if (!n) return null;
  const inside = new Set(ix.filesUnder(id).map((f) => f.id));
  const inFrom = new Map<string, number>();
  const outTo = new Set<string>();
  for (const e of ix.g.edges) {
    const si = inside.has(e.srcId);
    const ti = inside.has(e.dstId);
    if (si && !ti) outTo.add(e.dstId);
    if (ti && !si) inFrom.set(e.srcId, (inFrom.get(e.srcId) ?? 0) + 1);
  }
  const top = [...inFrom]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 10)
    .map(([k]) => k);
  return {
    id: id as never,
    kind: n.type,
    path: n.path,
    summary: null,
    loc: [...inside].reduce((s, f) => s + ((ix.nodes.get(f) as { loc?: number }).loc ?? 0), 0),
    inDegree: inFrom.size,
    outDegree: outTo.size,
    topDependents: top as never,
  };
}
