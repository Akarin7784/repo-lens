import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';
import type {
  GraphInput,
  LlmUsageInput,
  LlmUsageRow,
  SummaryLevel,
  SummaryRow,
  RepoRow,
  Store,
  StoredGraph,
  TaskPatch,
  TaskRow,
  TaskStage,
} from './store.js';

const BATCH = 500;
const GRAPH_STAGES: TaskStage[] = ['graph_ready', 'summarizing', 'embedding', 'done'];
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

type TaskSel = typeof schema.analysisTask.$inferSelect;
const toTask = (r: TaskSel): TaskRow => ({
  id: r.id,
  jobId: r.jobId,
  repoId: r.repoId,
  commitSha: r.commitSha ?? '',
  stage: r.stage ?? 'queued',
  progress: r.progress ?? 0,
  errorCode: r.errorCode,
  errorMsg: r.errorMsg,
  attempts: r.attempts ?? 0,
  stats: (r.stats as TaskRow['stats'] | null) ?? {},
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
});
type RepoSel = typeof schema.repo.$inferSelect;
const toRepo = (r: RepoSel): RepoRow => ({
  id: r.id,
  url: r.url,
  owner: r.owner ?? '',
  name: r.name ?? '',
  defaultRef: r.defaultRef,
  lastCommit: r.lastCommit,
  langMain: r.langMain,
  status: r.status ?? 'new',
});

function chunks<T>(xs: T[], n = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** MySQL 8 / MariaDB 实现(drizzle + mysql2 连接池) */
export class MysqlStore implements Store {
  readonly db: MySql2Database<typeof schema>;
  private constructor(private readonly pool: mysql.Pool) {
    this.db = drizzle(pool, { schema, mode: 'default' });
  }

  static create(url: string): MysqlStore {
    return new MysqlStore(mysql.createPool({ uri: url, connectionLimit: 10, timezone: 'Z' }));
  }

  async upsertRepo(input: { url: string; owner: string; name: string }): Promise<RepoRow> {
    await this.db
      .insert(schema.repo)
      .values(input)
      .onDuplicateKeyUpdate({ set: { owner: input.owner } });
    const [r] = await this.db.select().from(schema.repo).where(eq(schema.repo.url, input.url));
    return toRepo(r!);
  }
  async getRepo(id: number) {
    const [r] = await this.db.select().from(schema.repo).where(eq(schema.repo.id, id));
    return r ? toRepo(r) : null;
  }
  async updateRepo(id: number, patch: Partial<RepoRow>) {
    const { lastCommit, status, langMain, defaultRef } = patch;
    const set = Object.fromEntries(
      Object.entries({ lastCommit, status, langMain, defaultRef }).filter(
        ([, v]) => v !== undefined,
      ),
    );
    if (Object.keys(set).length)
      await this.db.update(schema.repo).set(set).where(eq(schema.repo.id, id));
  }
  async listSummaries(repoId: number): Promise<SummaryRow[]> {
    const rows = await this.db
      .select()
      .from(schema.summary)
      .where(eq(schema.summary.repoId, repoId));
    return rows.map((r) => ({
      level: r.level,
      targetId: r.targetId,
      inputHash: r.inputHash,
      model: r.model ?? '',
      content: r.content ?? '',
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
    }));
  }

  async upsertSummary(repoId: number, row: SummaryRow) {
    const v = {
      inputHash: row.inputHash,
      model: row.model,
      content: row.content,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
    };
    await this.db
      .insert(schema.summary)
      .values({ repoId, level: row.level, targetId: row.targetId, ...v })
      .onDuplicateKeyUpdate({ set: v });
  }

  async getSummary(repoId: number, level: SummaryLevel, targetId: string) {
    const [r] = await this.db
      .select({ content: schema.summary.content })
      .from(schema.summary)
      .where(
        and(
          eq(schema.summary.repoId, repoId),
          eq(schema.summary.level, level),
          eq(schema.summary.targetId, targetId),
        ),
      )
      .limit(1);
    return r?.content ?? null;
  }

  async insertLlmUsage(row: LlmUsageInput) {
    await this.db.insert(schema.llmUsage).values({
      repoId: row.repoId ?? null,
      taskId: row.taskId ?? null,
      sessionId: row.sessionId ?? null,
      purpose: row.purpose,
      model: row.model,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      costMicroUsd: row.costMicroUsd,
      cacheHit: row.cacheHit ? 1 : 0,
      ok: row.ok ? 1 : 0,
    });
  }

  async llmUsageByTask(taskId: number): Promise<LlmUsageRow[]> {
    const rows = await this.db
      .select()
      .from(schema.llmUsage)
      .where(eq(schema.llmUsage.taskId, taskId))
      .orderBy(schema.llmUsage.id);
    return rows.map((r) => ({
      id: r.id,
      repoId: r.repoId,
      taskId: r.taskId,
      sessionId: r.sessionId,
      purpose: r.purpose,
      model: r.model ?? '',
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
      costMicroUsd: r.costMicroUsd ?? 0,
      cacheHit: r.cacheHit === 1,
      ok: r.ok === 1,
    }));
  }

  async createTask(input: { jobId: string; repoId: number; commitSha: string }) {
    const res = await this.db
      .insert(schema.analysisTask)
      .ignore()
      .values({ ...input, stage: 'queued', progress: 0, stats: {} });
    // INSERT IGNORE:affectedRows=1 表示新插入,0 表示 uk_job / uk_repo_commit 已存在
    const created = res[0].affectedRows === 1;
    return { task: (await this.getTask(input.jobId))!, created };
  }
  async getTask(jobId: string) {
    const [r] = await this.db
      .select()
      .from(schema.analysisTask)
      .where(eq(schema.analysisTask.jobId, jobId));
    return r ? toTask(r) : null;
  }
  async latestTask(repoId: number) {
    const [r] = await this.db
      .select()
      .from(schema.analysisTask)
      .where(eq(schema.analysisTask.repoId, repoId))
      .orderBy(desc(schema.analysisTask.id))
      .limit(1);
    return r ? toTask(r) : null;
  }
  async latestDoneTask(repoId: number) {
    const [r] = await this.db
      .select()
      .from(schema.analysisTask)
      .where(and(eq(schema.analysisTask.repoId, repoId), eq(schema.analysisTask.stage, 'done')))
      .orderBy(desc(schema.analysisTask.id))
      .limit(1);
    return r ? toTask(r) : null;
  }
  async latestGraphTask(repoId: number) {
    const [r] = await this.db
      .select()
      .from(schema.analysisTask)
      .where(
        and(
          eq(schema.analysisTask.repoId, repoId),
          inArray(schema.analysisTask.stage, GRAPH_STAGES),
        ),
      )
      .orderBy(desc(schema.analysisTask.id))
      .limit(1);
    return r ? toTask(r) : null;
  }
  async updateTask(jobId: string, patch: TaskPatch) {
    if (!Object.keys(patch).length) return;
    await this.db
      .update(schema.analysisTask)
      .set({ ...patch, errorMsg: patch.errorMsg?.slice(0, 1024) ?? patch.errorMsg })
      .where(eq(schema.analysisTask.jobId, jobId));
  }
  async hasGraph(repoId: number, commitSha: string) {
    const [r] = await this.db
      .select({ id: schema.file.id })
      .from(schema.file)
      .where(and(eq(schema.file.repoId, repoId), eq(schema.file.commitSha, commitSha)))
      .limit(1);
    return Boolean(r);
  }

  async saveGraph(repoId: number, commitSha: string, g: GraphInput) {
    return this.db.transaction(async (tx) => {
      const scope = (t: typeof schema.file | typeof schema.edge) =>
        and(eq(t.repoId, repoId), eq(t.commitSha, commitSha));
      const old = await tx
        .select({ id: schema.file.id })
        .from(schema.file)
        .where(scope(schema.file));
      for (const c of chunks(old.map((o) => o.id)))
        await tx.delete(schema.symbol).where(inArray(schema.symbol.fileId, c));
      await tx.delete(schema.edge).where(scope(schema.edge));
      await tx.delete(schema.file).where(scope(schema.file));

      for (const c of chunks(g.files))
        await tx.insert(schema.file).values(
          c.map((f) => ({
            repoId,
            commitSha,
            path: f.path,
            pathHash: sha1(f.path),
            lang: f.lang,
            loc: f.loc,
            contentHash: f.contentHash,
            moduleId: f.moduleId,
            dirPath: f.dirPath,
            externalDeps: f.externalDeps,
          })),
        );
      const rows = await tx
        .select({ id: schema.file.id, path: schema.file.path })
        .from(schema.file)
        .where(scope(schema.file));
      const ids = new Map(rows.map((r) => [r.path, r.id]));

      const syms = g.symbols.filter((s) => ids.has(s.path));
      for (const c of chunks(syms))
        await tx.insert(schema.symbol).values(
          c.map((s) => ({
            repoId,
            fileId: ids.get(s.path)!,
            name: s.name.slice(0, 255),
            kind: s.kind,
            startLine: s.startLine,
            endLine: s.endLine,
            exported: s.exported ? 1 : 0,
          })),
        );
      for (const c of chunks(g.edges))
        await tx.insert(schema.edge).values(
          c.map((e) => ({
            repoId,
            commitSha,
            level: 'file' as const,
            type: 'imports' as const,
            kind: e.kind,
            srcId: e.srcId,
            dstId: e.dstId,
            srcFileId: ids.get(e.srcPath) ?? null,
            weight: 1,
          })),
        );
      return ids;
    });
  }

  async loadGraph(repoId: number, commitSha: string): Promise<StoredGraph> {
    const files = await this.db
      .select()
      .from(schema.file)
      .where(and(eq(schema.file.repoId, repoId), eq(schema.file.commitSha, commitSha)));
    const edges = await this.db
      .select()
      .from(schema.edge)
      .where(
        and(
          eq(schema.edge.repoId, repoId),
          eq(schema.edge.commitSha, commitSha),
          eq(schema.edge.level, 'file'),
          eq(schema.edge.type, 'imports'),
        ),
      );
    return {
      files: files.map((f) => ({
        id: f.id,
        path: f.path,
        lang: f.lang,
        loc: f.loc ?? 0,
        moduleId: f.moduleId ?? 'm:.',
        dirPath: f.dirPath ?? '.',
        externalDeps: f.externalDeps ?? [],
      })),
      edges: edges.map((e) => ({
        srcId: e.srcId,
        dstId: e.dstId,
        kind: e.kind ?? 'static',
        srcFileId: e.srcFileId ?? 0,
        weight: e.weight ?? 1,
      })),
    };
  }
  async exportsOf(fileRowId: number) {
    const rows = await this.db
      .select({ name: schema.symbol.name })
      .from(schema.symbol)
      .where(and(eq(schema.symbol.fileId, fileRowId), eq(schema.symbol.exported, 1)));
    return rows.map((r) => r.name);
  }
  async close() {
    await this.pool.end();
  }
}
