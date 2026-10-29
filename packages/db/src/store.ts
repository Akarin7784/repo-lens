import type { ImportKind } from '@repolens/shared';
import type { TASK_STAGES } from './schema.js';

export type TaskStage = (typeof TASK_STAGES)[number];

export interface RepoRow {
  id: number;
  url: string;
  owner: string;
  name: string;
  defaultRef: string | null;
  lastCommit: string | null;
  langMain: string | null;
  status: 'new' | 'ready' | 'failed';
}

export interface TaskStats {
  files?: number;
  modules?: number;
  dirs?: number;
  nodes?: number;
  edges?: number;
  cycles?: string[][];
  assetImports?: number;
  unresolved?: number;
  syntaxErrorFiles?: number;
  timedOutFiles?: number;
  resolverMode?: string;
  failedStage?: TaskStage;
  /** T-214:向量化结果(ready/reused/skipped/failed);旧任务无此字段 */
  embeddingStatus?: 'ready' | 'reused' | 'skipped' | 'failed';
  embeddingChunks?: number;
  [k: string]: unknown;
}

export interface TaskRow {
  id: number;
  jobId: string;
  repoId: number;
  commitSha: string;
  stage: TaskStage;
  progress: number;
  errorCode: string | null;
  errorMsg: string | null;
  attempts: number;
  stats: TaskStats;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export type TaskPatch = Partial<
  Pick<
    TaskRow,
    | 'stage'
    | 'progress'
    | 'errorCode'
    | 'errorMsg'
    | 'attempts'
    | 'stats'
    | 'startedAt'
    | 'finishedAt'
  >
>;

export interface FileInput {
  path: string;
  lang: string;
  loc: number;
  contentHash: string;
  moduleId: string;
  dirPath: string;
  externalDeps: string[];
}
export interface SymbolInput {
  path: string;
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'var';
  startLine: number;
  endLine: number;
  exported: boolean;
}
/** file→file 原始 import 边,srcPath 在入库时映射成 src_file_id(file.id) */
export interface EdgeInput {
  srcId: string;
  dstId: string;
  kind: ImportKind;
  srcPath: string;
}
export interface GraphInput {
  files: FileInput[];
  symbols: SymbolInput[];
  edges: EdgeInput[];
}

export interface StoredFile {
  id: number;
  path: string;
  lang: string | null;
  loc: number;
  moduleId: string;
  dirPath: string;
  externalDeps: string[];
}
export interface StoredEdge {
  srcId: string;
  dstId: string;
  kind: ImportKind;
  /** file.id */
  srcFileId: number;
  weight: number;
}
export interface StoredGraph {
  files: StoredFile[];
  edges: StoredEdge[];
}

/** 持久层接口:MySQL(drizzle)实现用于生产,内存实现用于无数据库的单元测试 */
export interface Store {
  upsertRepo(input: { url: string; owner: string; name: string }): Promise<RepoRow>;
  getRepo(id: number): Promise<RepoRow | null>;
  updateRepo(
    id: number,
    patch: Partial<Pick<RepoRow, 'lastCommit' | 'status' | 'langMain' | 'defaultRef'>>,
  ): Promise<void>;
  /** 按 job_id 幂等创建;已存在返回已有行与 created=false */
  createTask(input: {
    jobId: string;
    repoId: number;
    commitSha: string;
  }): Promise<{ task: TaskRow; created: boolean }>;
  getTask(jobId: string): Promise<TaskRow | null>;
  latestTask(repoId: number): Promise<TaskRow | null>;
  /**
   * 某仓库全部 commit 的摘要(T-211c:uk = repoId + level + targetId + commitSha,各 commit 各存一份),
   * 每行带 commitSha。只用于测试与运维排查;worker 复用改走 findSummaryByInput
   */
  listSummaries(repoId: number): Promise<SummaryRow[]>;
  /**
   * 按输入哈希找可复用的摘要(worker 摘要阶段逐节点调用,走 idx_input,不再整表读所有 commit):
   * 同 (repoId, level, targetId, inputHash) 的行,优先 preferCommit,其次最新写入的一行;没有返回 null
   */
  findSummaryByInput(
    repoId: number,
    level: SummaryLevel,
    targetId: string,
    inputHash: string,
    preferCommit: string,
  ): Promise<SummaryRow | null>;
  /** 按 (repoId, level, targetId, commitSha) 插入或覆盖 */
  upsertSummary(repoId: number, commitSha: string, row: SummaryRow): Promise<void>;
  /** 读某 commit 的摘要;没有返回 null */
  getSummary(
    repoId: number,
    commitSha: string,
    level: SummaryLevel,
    targetId: string,
  ): Promise<{ content: string; source: SummarySource } | null>;
  /** 写一条 llm_usage(每次 LLM 调用一条,含缓存命中与失败;T-210) */
  insertLlmUsage(row: LlmUsageInput): Promise<void>;
  /** 某任务的 llm_usage,按 id 升序 */
  llmUsageByTask(taskId: number): Promise<LlmUsageRow[]>;
  /** 最近一个已完成(stage = done)的任务 */
  latestDoneTask(repoId: number): Promise<TaskRow | null>;
  /** 最近一个图已入库(stage ≥ graph_ready 且未失败,或 done)的任务 */
  latestGraphTask(repoId: number): Promise<TaskRow | null>;
  updateTask(jobId: string, patch: TaskPatch): Promise<void>;
  hasGraph(repoId: number, commitSha: string): Promise<boolean>;
  /** 同一事务内 DELETE 旧数据再批量插入;返回 path → file.id */
  saveGraph(repoId: number, commitSha: string, g: GraphInput): Promise<Map<string, number>>;
  loadGraph(repoId: number, commitSha: string): Promise<StoredGraph>;
  /** 文件的导出符号名 */
  exportsOf(fileRowId: number): Promise<string[]>;
  close(): Promise<void>;
}

export const LLM_PURPOSES = ['summary', 'embed', 'chat', 'rerank', 'verify'] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];
export interface LlmUsageInput {
  repoId?: number | null;
  taskId?: number | null;
  sessionId?: number | null;
  purpose: LlmPurpose;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** 费用,单位百万分之一美元(1 美分 = 10000) */
  costMicroUsd: number;
  cacheHit: boolean;
  ok: boolean;
}
export interface LlmUsageRow extends LlmUsageInput {
  id: number;
}

/** schema 的 level 枚举;module 层摘要与 dir 共用 'dir',targetId 用 m:… 区分 */
export type SummaryLevel = 'function' | 'file' | 'dir' | 'repo';
/** 摘要来源:模型生成 / 规则生成(熔断、预算降级、敏感文件等) */
export type SummarySource = 'llm' | 'rule';
export interface SummaryRow {
  level: SummaryLevel;
  /** 节点 id(f:/d:/m:)或 'repo' */
  targetId: string;
  inputHash: string;
  /** 模型名;规则摘要为 'rule' */
  model: string;
  /** T-211c:来源;复用旧行时保持原来源 */
  source: SummarySource;
  /** 所属 commit(listSummaries 读回时带上;写入时由 upsertSummary 的参数决定) */
  commitSha?: string;
  content: string;
  tokensIn: number;
  tokensOut: number;
}
