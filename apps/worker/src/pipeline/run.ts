import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import {
  AnalyzerError,
  analyzeRepo,
  scanRepo,
  type AnalyzeResult,
  type ScanResult,
} from '@repolens/analyzer';
import type { FileInput, GraphInput, Store, SymbolInput, TaskStats } from '@repolens/db';
import type { GraphNode, ProgressStage } from '@repolens/shared';
import type { WorkerConfig } from '../config.js';
import type { EventSink } from '../events.js';
import { cloneAtCommit } from './clone.js';
import { PipelineError } from './errors.js';
import { safeRelPath } from './paths.js';

export interface AnalyzeJobData {
  /** 对外 jobId:`${repoId}:${commitSha}` */
  jobId: string;
  repoId: number;
  repoUrl: string;
  commitSha: string;
}

export interface PipelineDeps {
  store: Store;
  events: EventSink;
  config: WorkerConfig;
  /** 图入库后回调(Redis 图缓存失效) */
  onGraphPersisted?: (repoId: number, commitSha: string) => Promise<void>;
  /** 仅测试:允许 file:// 克隆源 */
  allowFileProtocol?: boolean;
}

export interface AttemptInfo {
  /** 已经失败过的次数(BullMQ job.attemptsMade) */
  attemptsMade: number;
  maxAttempts: number;
}

/** 阶段进度区间(BACKEND_AI_DESIGN §3,架构师定稿) */
export const STAGE_RANGE = {
  queued: [0, 0],
  cloning: [0, 8],
  scanning: [8, 12],
  parsing: [12, 40],
  graph_ready: [40, 50],
  summarizing: [50, 85],
  embedding: [85, 100],
  done: [100, 100],
} as const satisfies Record<ProgressStage, readonly [number, number]>;

/** 扫描规则变更时提升版本,让旧的 scan 断点失效 */
const SCAN_RULES_VERSION = 2;

const langOf = (p: string) => posix.extname(p).slice(1) || 'unknown';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function readJson<T>(p: string): T | null {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(p: string, v: unknown) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify(v));
  renameSync(`${p}.tmp`, p); // 原子替换,半截文件不会被当成断点
}

function moduleOf(byId: Map<string, GraphNode>, n: GraphNode): string {
  let cur: GraphNode | undefined = n;
  while (cur && cur.type !== 'module') cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  return cur?.id ?? 'm:.';
}

/** 把分析结果转成入库输入(file / symbol / edge);srcFileId 在 store 内映射成 file.id */
export async function toGraphInput(root: string, r: AnalyzeResult): Promise<GraphInput> {
  const byId = new Map(r.graph.nodes.map((n) => [n.id, n]));
  const parsedByPath = new Map(r.parsed.map((p) => [p.path, p]));
  const files: FileInput[] = [];
  const symbols: SymbolInput[] = [];
  for (const n of r.graph.nodes) {
    if (n.type !== 'file') continue;
    const content = await readFile(join(root, n.path), 'utf8');
    files.push({
      path: n.path,
      lang: langOf(n.path),
      loc: n.loc ?? 0,
      contentHash: sha256(content),
      moduleId: moduleOf(byId, n),
      dirPath: posix.dirname(n.path),
      externalDeps: n.externalDeps ?? [],
    });
    for (const s of parsedByPath.get(n.path)?.symbols ?? []) symbols.push({ path: n.path, ...s });
  }
  const edges = r.graph.edges.map((e) => ({
    srcId: e.source,
    dstId: e.target,
    kind: e.kind,
    srcPath: e.srcFileId.slice(2),
  }));
  return { files, symbols, edges };
}

export function statsOf(r: AnalyzeResult): TaskStats {
  const count = (t: string) => r.graph.nodes.filter((n) => n.type === t).length;
  return {
    files: r.stats.files,
    modules: count('module'),
    dirs: count('dir'),
    nodes: r.stats.nodes,
    edges: r.stats.edges,
    cycles: r.graph.cycles,
    assetImports: r.stats.assetImports,
    unresolved: r.stats.unresolved,
    syntaxErrorFiles: r.stats.syntaxErrorFiles,
    timedOutFiles: r.stats.timedOutFiles.length,
    externalPackages: r.stats.externalPackages,
    resolverMode: r.resolverMode,
  };
}

/**
 * analyze 流水线:cloning → scanning → parsing → graph_ready →(summarizing、embedding 桩)→ done。
 * 每个阶段先查断点:快照 HEAD 已是目标 commit 则跳过 clone;scan/analysis 结果落盘复用;
 * 该 commit 的图已入库则跳过 parse 与写库。失败发 stage_error,最后一次失败再发 done{failed}。
 */
export async function runPipeline(
  data: AnalyzeJobData,
  deps: PipelineDeps,
  attempt: AttemptInfo = { attemptsMade: 0, maxAttempts: 1 },
): Promise<TaskStats> {
  const { store, events, config } = deps;
  const { jobId, repoId, commitSha } = data;
  const base = join(config.workdir, String(repoId));
  const root = join(base, commitSha);
  let stage: ProgressStage = 'cloning';

  const progress = async (s: ProgressStage, pct: number, message?: string) => {
    stage = s;
    await store.updateTask(jobId, { stage: s, progress: Math.round(pct) });
    await events.emit({
      event: 'progress',
      data: { jobId, stage: s, progress: Math.round(pct), ...(message ? { message } : {}) },
    });
  };

  try {
    await store.updateTask(jobId, {
      attempts: attempt.attemptsMade + 1,
      startedAt: new Date(),
      errorCode: null,
      errorMsg: null,
    });

    // cloning 0–8
    await progress(
      'cloning',
      0,
      attempt.attemptsMade ? `第 ${attempt.attemptsMade + 1} 次尝试` : undefined,
    );
    const c = await cloneAtCommit({
      url: data.repoUrl,
      commitSha,
      dest: root,
      timeoutMs: config.cloneTimeoutMs,
      allowFileProtocol: deps.allowFileProtocol,
    });
    await progress('cloning', 8, c.skipped ? '快照已存在,跳过克隆' : '浅克隆完成');

    // scanning 8–12
    stage = 'scanning';
    const scanPath = `${root}.scan.json`;
    let scan = readJson<ScanResult & { v: number }>(scanPath);
    if (scan?.v !== SCAN_RULES_VERSION) {
      scan = { ...scanRepo(root, { maxFiles: config.maxFiles }), v: SCAN_RULES_VERSION };
      writeJson(scanPath, scan);
    }
    if (scan.totalBytes > config.maxRepoBytes)
      throw new PipelineError(
        'REPO_TOO_LARGE',
        'scanning',
        `仓库 ${(scan.totalBytes / 1048576).toFixed(1)}MB 超过上限 ${(config.maxRepoBytes / 1048576).toFixed(0)}MB`,
        false,
      );
    if (scan.files.length > config.maxFiles)
      throw new PipelineError(
        'REPO_TOO_LARGE',
        'scanning',
        `源码文件超过上限 ${config.maxFiles}`,
        false,
      );
    const files = scan.files.filter((f) => safeRelPath(f) !== null);
    if (files.length !== scan.files.length)
      throw new PipelineError('UNSAFE_PATH', 'scanning', '扫描结果含不安全路径', false);
    await progress('scanning', 12, `扫描到 ${files.length} 个源码文件`);

    // parsing 12–40 + graph_ready 40–50
    let stats: TaskStats;
    if (await store.hasGraph(repoId, commitSha)) {
      stats = (await store.getTask(jobId))?.stats ?? {};
      await progress('parsing', 40, '图已入库,跳过解析');
    } else {
      stage = 'parsing';
      const anaPath = `${root}.analysis.json`;
      let result = readJson<AnalyzeResult>(anaPath);
      if (!result || result.stats.files !== files.length) {
        let last = 0;
        await progress('parsing', 12, `解析 0/${files.length} 文件`);
        try {
          result = await analyzeRepo(
            { root, files },
            {
              parseTimeoutMs: config.parseTimeoutMs,
              concurrency: config.parseConcurrency,
              onFileParsed: async (done, total) => {
                const pct = 12 + Math.floor((done / total) * 26); // 留 38–40 给 import 解析
                if (pct > last || done === total) {
                  last = pct;
                  await progress('parsing', pct, `解析 ${done}/${total} 文件`);
                }
              },
            },
          );
        } catch (err) {
          if (err instanceof AnalyzerError)
            throw new PipelineError(err.code, 'parsing', err.message, false);
          throw err;
        }
        writeJson(anaPath, result);
      }
      stats = statsOf(result);
      await progress('parsing', 40, `解析完成:${stats.nodes} 个节点,${stats.edges} 条边`);

      stage = 'graph_ready';
      await store.updateTask(jobId, { stage: 'graph_ready', progress: 40 });
      const input = await toGraphInput(root, result);
      await store.saveGraph(repoId, commitSha, input);
      await deps.onGraphPersisted?.(repoId, commitSha);
    }
    await store.updateTask(jobId, { stats });
    await store.updateRepo(repoId, {
      lastCommit: commitSha,
      status: 'ready',
      langMain: 'typescript',
    });
    await progress('graph_ready', 50, '依赖图已就绪');
    await events.emit({
      event: 'graph_ready',
      data: { jobId, repoId, graphUrl: `/api/repos/${repoId}/graph` },
    });

    // summarizing / embedding:W2 实现,当前为桩
    await progress('summarizing', 50, '摘要尚未实现(W2),跳过');
    await progress('embedding', 85, '向量化尚未实现(W2),跳过');

    await store.updateTask(jobId, { stage: 'done', progress: 100, finishedAt: new Date() });
    await events.emit({ event: 'progress', data: { jobId, stage: 'done', progress: 100 } });
    const numeric = Object.fromEntries(
      Object.entries(stats).filter((e): e is [string, number] => typeof e[1] === 'number'),
    );
    await events.emit({ event: 'done', data: { jobId, status: 'done', stats: numeric } });
    return stats;
  } catch (err) {
    const pe =
      err instanceof PipelineError
        ? err
        : new PipelineError(
            'INTERNAL',
            stage,
            err instanceof Error ? err.message : String(err),
            true,
          );
    const final = !pe.retryable || attempt.attemptsMade + 1 >= attempt.maxAttempts;
    await events.emit({
      event: 'stage_error',
      data: { jobId, stage: pe.stage, message: pe.message },
    });
    const prev = (await store.getTask(jobId))?.stats ?? {};
    await store.updateTask(jobId, {
      errorCode: pe.code,
      errorMsg: pe.message,
      ...(final
        ? { stage: 'failed', finishedAt: new Date(), stats: { ...prev, failedStage: pe.stage } }
        : {}),
    });
    if (final) {
      await events.emit({ event: 'done', data: { jobId, status: 'failed' } });
      const repo = await store.getRepo(repoId);
      if (repo && repo.status !== 'ready') await store.updateRepo(repoId, { status: 'failed' });
    }
    throw pe;
  }
}
