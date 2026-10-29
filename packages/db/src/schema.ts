/**
 * MySQL schema(drizzle),对应 BACKEND_AI_DESIGN.md §2.1 DDL。
 * 与文档的差异(已同步到文档):
 * - file.external_deps JSON:file 节点的 externalDeps(x: 节点由 API 现算,需要它)
 * - analysis_task.stats JSON:{files,modules,edges,cycles,assetImports,...,failedStage}
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  datetime,
  decimal,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  text,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

const id = () => bigint('id', { mode: 'number' }).primaryKey().autoincrement();
const ref = (name: string) => bigint(name, { mode: 'number' });
const createdAt = () => datetime('created_at').default(sql`CURRENT_TIMESTAMP`);

export const TASK_STAGES = [
  'queued',
  'cloning',
  'scanning',
  'parsing',
  'graph_ready',
  'summarizing',
  'embedding',
  'done',
  'failed',
] as const;
export const IMPORT_KIND_ENUM = ['static', 'dynamic', 'type-only', 're-export', 'require'] as const;
export const SYMBOL_KIND_ENUM = [
  'function',
  'class',
  'method',
  'interface',
  'type',
  'var',
] as const;

export const repo = mysqlTable(
  'repo',
  {
    id: id(),
    url: varchar('url', { length: 512 }).notNull(),
    owner: varchar('owner', { length: 128 }),
    name: varchar('name', { length: 128 }),
    defaultRef: varchar('default_ref', { length: 128 }),
    lastCommit: char('last_commit', { length: 40 }),
    langMain: varchar('lang_main', { length: 32 }),
    status: mysqlEnum('status', ['new', 'ready', 'failed']).default('new'),
    isDemo: tinyint('is_demo').default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uk_url').on(t.url)],
);

export const analysisTask = mysqlTable(
  'analysis_task',
  {
    id: id(),
    jobId: varchar('job_id', { length: 64 }).notNull(),
    repoId: ref('repo_id').notNull(),
    commitSha: char('commit_sha', { length: 40 }),
    stage: mysqlEnum('stage', TASK_STAGES).default('queued'),
    progress: tinyint('progress').default(0),
    errorCode: varchar('error_code', { length: 64 }),
    errorMsg: varchar('error_msg', { length: 1024 }),
    attempts: int('attempts').default(0),
    stats: json('stats').$type<Record<string, unknown>>(),
    startedAt: datetime('started_at'),
    finishedAt: datetime('finished_at'),
  },
  (t) => [
    uniqueIndex('uk_job').on(t.jobId),
    uniqueIndex('uk_repo_commit').on(t.repoId, t.commitSha),
    index('idx_repo').on(t.repoId, t.id),
  ],
);

export const file = mysqlTable(
  'file',
  {
    id: id(),
    repoId: ref('repo_id').notNull(),
    commitSha: char('commit_sha', { length: 40 }).notNull(),
    path: varchar('path', { length: 1024 }).notNull(),
    pathHash: char('path_hash', { length: 40 }).notNull(),
    lang: varchar('lang', { length: 16 }),
    loc: int('loc'),
    contentHash: char('content_hash', { length: 64 }),
    moduleId: varchar('module_id', { length: 255 }),
    dirPath: varchar('dir_path', { length: 1024 }),
    externalDeps: json('external_deps').$type<string[]>(),
  },
  (t) => [
    uniqueIndex('uk_path').on(t.repoId, t.commitSha, t.pathHash),
    index('idx_hash').on(t.contentHash),
  ],
);

export const symbol = mysqlTable(
  'symbol',
  {
    id: id(),
    repoId: ref('repo_id').notNull(),
    fileId: ref('file_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    kind: mysqlEnum('kind', SYMBOL_KIND_ENUM),
    startLine: int('start_line'),
    endLine: int('end_line'),
    exported: tinyint('exported'),
    signature: varchar('signature', { length: 1024 }),
    parentSymbolId: ref('parent_symbol_id'),
  },
  (t) => [index('idx_file').on(t.fileId), index('idx_name').on(t.repoId, t.name)],
);

export const edge = mysqlTable(
  'edge',
  {
    id: id(),
    repoId: ref('repo_id').notNull(),
    commitSha: char('commit_sha', { length: 40 }).notNull(),
    level: mysqlEnum('level', ['file', 'module', 'dir', 'symbol']).notNull(),
    type: mysqlEnum('type', ['imports', 'calls', 'contains']).notNull(),
    /** 仅 type='imports' 时有值 */
    kind: mysqlEnum('kind', IMPORT_KIND_ENUM),
    /** 图 nodeId(m:/d:/f: + POSIX 路径) */
    srcId: varchar('src_id', { length: 255 }).notNull(),
    dstId: varchar('dst_id', { length: 255 }).notNull(),
    /** 源文件 file.id(整数);接口层映射回 f:<path> */
    srcFileId: ref('src_file_id'),
    weight: int('weight').default(1),
    confidence: decimal('confidence', { precision: 3, scale: 2 }).default('1.00'),
  },
  (t) => [
    index('idx_src').on(t.repoId, t.commitSha, t.level, t.srcId),
    index('idx_dst').on(t.repoId, t.commitSha, t.level, t.dstId),
    index('idx_srcfile').on(t.srcFileId),
  ],
);

export const summary = mysqlTable(
  'summary',
  {
    id: id(),
    repoId: ref('repo_id').notNull(),
    level: mysqlEnum('level', ['function', 'file', 'dir', 'repo']).notNull(),
    targetId: varchar('target_id', { length: 255 }).notNull(),
    // T-211c:摘要按 commit 存;迁移 0001 对旧行回填为仓库 last_commit
    commitSha: char('commit_sha', { length: 40 }).notNull().default(''),
    inputHash: char('input_hash', { length: 64 }).notNull(),
    model: varchar('model', { length: 64 }),
    source: mysqlEnum('source', ['llm', 'rule']).notNull().default('llm'),
    content: text('content'),
    tokensIn: int('tokens_in'),
    tokensOut: int('tokens_out'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uk_target_commit').on(t.repoId, t.level, t.targetId, t.commitSha),
    index('idx_input').on(t.inputHash),
    // 摘要复用逐节点查询(findSummaryByInput)用;迁移 0002
    index('idx_reuse').on(t.repoId, t.level, t.targetId, t.inputHash),
  ],
);

export const chatSession = mysqlTable(
  'chat_session',
  {
    id: id(),
    repoId: ref('repo_id').notNull(),
    userKey: varchar('user_key', { length: 64 }),
    title: varchar('title', { length: 255 }),
    createdAt: createdAt(),
  },
  (t) => [index('idx_user').on(t.userKey, t.id)],
);

export const chatMessage = mysqlTable(
  'chat_message',
  {
    id: id(),
    sessionId: ref('session_id').notNull(),
    role: mysqlEnum('role', ['user', 'assistant']).notNull(),
    content: mediumtext('content'),
    citations: json('citations'),
    droppedCitations: int('dropped_citations').default(0),
    retrievalIds: json('retrieval_ids'),
    latencyMs: int('latency_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_session').on(t.sessionId, t.id)],
);

export const llmUsage = mysqlTable(
  'llm_usage',
  {
    id: id(),
    repoId: ref('repo_id'),
    taskId: ref('task_id'),
    sessionId: ref('session_id'),
    purpose: mysqlEnum('purpose', ['summary', 'embed', 'chat', 'rerank', 'verify']).notNull(),
    model: varchar('model', { length: 64 }),
    tokensIn: int('tokens_in'),
    tokensOut: int('tokens_out'),
    costMicroUsd: int('cost_micro_usd'),
    cacheHit: tinyint('cache_hit').default(0),
    ok: tinyint('ok').default(1),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_repo_time').on(t.repoId, t.createdAt),
    index('idx_day').on(t.createdAt, t.purpose),
  ],
);
