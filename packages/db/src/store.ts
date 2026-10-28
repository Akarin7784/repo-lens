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
