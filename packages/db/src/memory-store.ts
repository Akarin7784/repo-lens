import type {
  GraphInput,
  LlmUsageInput,
  LlmUsageRow,
  SummaryLevel,
  SummaryRow,
  RepoRow,
  Store,
  StoredEdge,
  StoredFile,
  StoredGraph,
  SymbolInput,
  TaskPatch,
  TaskRow,
} from './store.js';

const GRAPH_STAGES = new Set(['graph_ready', 'summarizing', 'embedding', 'done']);

/** 内存实现(单元测试 / 无 MySQL 时);语义与 MysqlStore 保持一致 */
export class MemoryStore implements Store {
  private repos = new Map<number, RepoRow>();
  private tasks = new Map<string, TaskRow>();
  private graphs = new Map<string, { g: StoredGraph; symbols: Map<number, SymbolInput[]> }>();
  private seq = { repo: 0, task: 0, file: 0, usage: 0 };
  private usage: LlmUsageRow[] = [];
  private summaries = new Map<number, Map<string, SummaryRow>>();

  async listSummaries(repoId: number) {
    return [...(this.summaries.get(repoId)?.values() ?? [])].map((r) => ({ ...r }));
  }
  async upsertSummary(repoId: number, commitSha: string, row: SummaryRow) {
    if (!this.summaries.has(repoId)) this.summaries.set(repoId, new Map());
    this.summaries
      .get(repoId)!
      .set(`${commitSha}|${row.level}|${row.targetId}`, { ...row, commitSha });
  }
  async findSummaryByInput(
    repoId: number,
    level: SummaryLevel,
    targetId: string,
    inputHash: string,
    preferCommit: string,
  ) {
    const all = [...(this.summaries.get(repoId)?.values() ?? [])].filter(
      (r) => r.level === level && r.targetId === targetId && r.inputHash === inputHash,
    );
    // Map 保持插入顺序;最后一个即最新写入
    const r = all.find((x) => x.commitSha === preferCommit) ?? all[all.length - 1];
    return r ? { ...r } : null;
  }
  async getSummary(repoId: number, commitSha: string, level: SummaryLevel, targetId: string) {
    const r = this.summaries.get(repoId)?.get(`${commitSha}|${level}|${targetId}`);
    return r ? { content: r.content, source: r.source } : null;
  }

  async insertLlmUsage(row: LlmUsageInput) {
    this.usage.push({
      repoId: null,
      taskId: null,
      sessionId: null,
      ...row,
      id: ++this.seq.usage,
    });
  }
  async llmUsageByTask(taskId: number) {
    return this.usage.filter((u) => u.taskId === taskId).map((u) => ({ ...u }));
  }

  async upsertRepo(input: { url: string; owner: string; name: string }): Promise<RepoRow> {
    for (const r of this.repos.values()) if (r.url === input.url) return { ...r };
    const row: RepoRow = {
      id: ++this.seq.repo,
      ...input,
      defaultRef: null,
      lastCommit: null,
      langMain: null,
      status: 'new',
    };
    this.repos.set(row.id, row);
    return { ...row };
  }
  async getRepo(id: number) {
    const r = this.repos.get(id);
    return r ? { ...r } : null;
  }
  async updateRepo(id: number, patch: Partial<RepoRow>) {
    const r = this.repos.get(id);
    if (r) Object.assign(r, patch);
  }
  async createTask(input: { jobId: string; repoId: number; commitSha: string }) {
    const ex = this.tasks.get(input.jobId);
    if (ex) return { task: { ...ex }, created: false };
    const row: TaskRow = {
      id: ++this.seq.task,
      ...input,
      stage: 'queued',
      progress: 0,
      errorCode: null,
      errorMsg: null,
      attempts: 0,
      stats: {},
      startedAt: null,
      finishedAt: null,
    };
    this.tasks.set(row.jobId, row);
    return { task: { ...row }, created: true };
  }
  async getTask(jobId: string) {
    const t = this.tasks.get(jobId);
    return t ? { ...t } : null;
  }
  private byRepo(repoId: number) {
    return [...this.tasks.values()].filter((t) => t.repoId === repoId).sort((a, b) => b.id - a.id);
  }
  async latestTask(repoId: number) {
    const t = this.byRepo(repoId)[0];
    return t ? { ...t } : null;
  }
  async latestDoneTask(repoId: number) {
    const t = this.byRepo(repoId).find((x) => x.stage === 'done');
    return t ? { ...t } : null;
  }
  async latestDoneTaskForCommit(repoId: number, commitSha: string) {
    const t = this.byRepo(repoId).find((x) => x.stage === 'done' && x.commitSha === commitSha);
    return t ? { ...t } : null;
  }
  async latestGraphTask(repoId: number) {
    const t = this.byRepo(repoId).find((x) => GRAPH_STAGES.has(x.stage));
    return t ? { ...t } : null;
  }
  async updateTask(jobId: string, patch: TaskPatch) {
    const t = this.tasks.get(jobId);
    if (t) Object.assign(t, patch);
  }
  async hasGraph(repoId: number, commitSha: string) {
    return (this.graphs.get(`${repoId}:${commitSha}`)?.g.files.length ?? 0) > 0;
  }
  async saveGraph(repoId: number, commitSha: string, g: GraphInput) {
    const ids = new Map<string, number>();
    const files: StoredFile[] = g.files.map((f) => {
      const id = ++this.seq.file;
      ids.set(f.path, id);
      return {
        id,
        path: f.path,
        lang: f.lang,
        loc: f.loc,
        moduleId: f.moduleId,
        dirPath: f.dirPath,
        externalDeps: f.externalDeps,
      };
    });
    const edges: StoredEdge[] = g.edges.map((e) => ({
      srcId: e.srcId,
      dstId: e.dstId,
      kind: e.kind,
      srcFileId: ids.get(e.srcPath)!,
      weight: 1,
    }));
    const symbols = new Map<number, SymbolInput[]>();
    for (const s of g.symbols) {
      const fid = ids.get(s.path);
      if (fid === undefined) continue;
      if (!symbols.has(fid)) symbols.set(fid, []);
      symbols.get(fid)!.push(s);
    }
    this.graphs.set(`${repoId}:${commitSha}`, { g: { files, edges }, symbols });
    return ids;
  }
  async loadGraph(repoId: number, commitSha: string) {
    return this.graphs.get(`${repoId}:${commitSha}`)?.g ?? { files: [], edges: [] };
  }
  async exportsOf(fileRowId: number) {
    for (const { symbols } of this.graphs.values()) {
      const s = symbols.get(fileRowId);
      if (s) return s.filter((x) => x.exported).map((x) => x.name);
    }
    return [];
  }
  async close() {}
}
