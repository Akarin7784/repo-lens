import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import {
  AnalyzerError,
  analyzeRepo,
  scanRepo,
  type AnalyzeResult,
  type ScanResult,
} from '@repolens/analyzer';
import {
  DEFAULT_PRICES,
  LlmGateway,
  MemoryLlmKv,
  createLlmClient,
  summarizeRepo,
  type SummaryFileInput,
} from '@repolens/agent';
import {
  GraphIndex,
  type FileInput,
  type GraphInput,
  type Store,
  type SummaryLevel,
  type SymbolInput,
  type TaskStats,
} from '@repolens/db';
import {
  exclusionRule,
  MAX_SEND_BYTES,
  type GraphNode,
  type ProgressStage,
  type EmbeddingStatus,
} from '@repolens/shared';
import {
  buildChunks,
  chunksDigest,
  embedLockKey,
  indexChunks,
  pointId,
  withEmbedLock,
  type ChunkSourceFile,
  type LockKv,
  type Embedder,
  type VectorStore,
} from '@repolens/rag';
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
  /** LLM 网关;不传时按 config.llm 建一个进程内缓存的网关(测试用) */
  gateway?: LlmGateway;
  /** embedding(T-214);与 vectorStore 都给了才跑向量化,否则跳过该阶段 */
  embedder?: Embedder;
  vectorStore?: VectorStore;
  /** 同 (repo, commit) 向量化互斥锁(Redis);不传时不加锁(单测) */
  lockKv?: LockKv;
  /** 锁 key 前缀(测试隔离用) */
  lockPrefix?: string;
  lockPollMs?: number;
  lockRenewMs?: number;
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
    const parsed = parsedByPath.get(n.path);
    // 命中敏感 / 超限 / 二进制规则的文件不持久化 symbols:导出名可能就是常量名或值本身,
    // 与摘要处清空 exports 保持一致,/nodes 对这类文件返回空 exports
    if (parsed?.sensitive) continue;
    for (const s of parsed?.symbols ?? []) symbols.push({ path: n.path, ...s });
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

  let priorDigest: unknown = null;
  try {
    // 本任务行在本次运行覆盖 stats 之前记录的内容 digest(MySQL 上 (repo, commit) 唯一,重跑即同一行);
    // 放在 try 内:读库失败与其它阶段一样走任务失败处理
    priorDigest = (await store.getTask(jobId))?.stats.embeddingDigest ?? null;
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
        // 并发解析时回调交错,用 promise 链串行写入,保证进度单调
        let chain: Promise<void> = Promise.resolve();
        await progress('parsing', 12, `解析 0/${files.length} 文件`);
        try {
          result = await analyzeRepo(
            { root, files },
            {
              parseTimeoutMs: config.parseTimeoutMs,
              concurrency: config.parseConcurrency,
              onFileParsed: (done, total) => {
                const pct = 12 + Math.floor((done / total) * 26); // 留 38–40 给 import 解析
                if (pct <= last && done !== total) return;
                last = Math.max(last, pct);
                const msg = `解析 ${done}/${total} 文件`;
                chain = chain.then(() => progress('parsing', pct, msg));
              },
            },
          );
          await chain;
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

    // summarizing 50–85:失败或预算熔断只发一次 stage_error,任务仍然 done(摘要非关键路径)
    stage = 'summarizing';
    await progress('summarizing', 50, '生成分层摘要');
    try {
      const msg = await runSummaries(data, deps, root, progress);
      await progress('summarizing', 85, msg.text);
      if (msg.warn)
        await events.emit({
          event: 'stage_error',
          data: { jobId, stage: 'summarizing', message: msg.warn },
        });
    } catch (err) {
      await events.emit({
        event: 'stage_error',
        data: {
          jobId,
          stage: 'summarizing',
          message: `摘要失败,已跳过:${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
    // embedding 85–99:与摘要同样非关键路径,失败只发 stage_error,任务仍 done;图与摘要照常可用
    stage = 'embedding';
    // embeddingStatus 写进 task.stats,GET /api/repos/:id 透出;检索侧据此决定是否降级(见 ARCHITECTURE §4)
    let embeddingStatus: EmbeddingStatus = 'skipped';
    // T-214:切块元数据先写 code_chunk(关键词检索数据源),与是否配置向量库无关;失败只发 stage_error
    let prepared: PreparedChunks | null = null;
    try {
      prepared = await prepareChunks(data, deps, root);
      await store.replaceCodeChunks(
        data.repoId,
        data.commitSha,
        prepared.chunks.map((c) => ({
          path: c.path,
          symbol: c.symbol,
          startLine: c.startLine,
          endLine: c.endLine,
          content: c.text,
          contentHash: c.contentHash,
          qdrantPointId: pointId(data.repoId, data.commitSha, {
            path: c.path,
            symbol: c.symbol,
            start_line: c.startLine,
            end_line: c.endLine,
          }),
        })),
      );
      stats = { ...stats, codeChunks: prepared.chunks.length };
    } catch (err) {
      await events.emit({
        event: 'stage_error',
        data: {
          jobId,
          stage: 'embedding',
          message: `切块入库失败,关键词检索不可用:${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
    if (!deps.embedder || !deps.vectorStore) {
      await progress('embedding', 85, '未配置向量库,跳过向量化');
    } else {
      await progress('embedding', 85, '切块与向量化');
      try {
        const r = await runEmbedding(
          data,
          deps,
          root,
          progress,
          typeof stats.embeddingDigest === 'string'
            ? stats.embeddingDigest
            : typeof priorDigest === 'string'
              ? priorDigest
              : null,
          prepared,
        );
        embeddingStatus = r.reused ? 'reused' : 'ready';
        stats = { ...stats, embeddingChunks: r.chunks };
        if (r.digest) stats = { ...stats, embeddingDigest: r.digest };
        await progress('embedding', 99, r.message);
      } catch (err) {
        embeddingStatus = 'failed';
        await events.emit({
          event: 'stage_error',
          data: {
            jobId,
            stage: 'embedding',
            message: `向量化失败,已跳过:${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
    }

    stats = { ...stats, embeddingStatus };
    await store.updateTask(jobId, { stage: 'done', progress: 100, finishedAt: new Date(), stats });
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

const gatewayOf = (deps: PipelineDeps) =>
  deps.gateway ??
  new LlmGateway({
    client: createLlmClient(deps.config.llm),
    kv: new MemoryLlmKv(),
    usage: deps.store,
    prices: DEFAULT_PRICES,
    dailyBudgetCents: deps.config.llm.dailyBudgetCents,
    taskBudgetCents: deps.config.llm.taskBudgetCents,
  });

/** 分层摘要(T-211):file → dir → module → repo,写 summary 表;返回进度消息与降级告警 */
export async function runSummaries(
  data: AnalyzeJobData,
  deps: PipelineDeps,
  root: string,
  progress: (s: ProgressStage, pct: number, message?: string) => Promise<void>,
): Promise<{ text: string; warn: string | null }> {
  const { store, config } = deps;
  const { repoId, commitSha, jobId } = data;
  const g = await store.loadGraph(repoId, commitSha);
  const tree = new GraphIndex(g);
  const importsOf = new Map<string, string[]>();
  for (const e of g.edges) {
    const l = importsOf.get(e.srcId) ?? [];
    l.push(e.dstId.replace(/^[a-z]:/, ''));
    importsOf.set(e.srcId, l);
  }
  const files = new Map<string, SummaryFileInput>();
  for (const f of g.files) {
    const id = `f:${f.path}`;
    const rel = safeRelPath(f.path);
    let code: string | null = null;
    try {
      code = rel ? await readFile(join(root, rel), 'utf8') : null;
    } catch {
      code = null;
    }
    // 敏感文件(.env*、密钥/证书、内容含 key 特征)以及超限/二进制内容:只留路径/语言/行数做规则摘要
    const sensitive = exclusionRule(f.path, code);
    if (sensitive) {
      files.set(id, {
        path: f.path,
        lang: f.lang ?? langOf(f.path),
        loc: f.loc,
        exports: [],
        imports: [],
        contentHash: '',
        code: null,
        sensitive,
      });
      continue;
    }
    files.set(id, {
      path: f.path,
      lang: f.lang ?? langOf(f.path),
      loc: f.loc,
      exports: await store.exportsOf(f.id),
      imports: [...(importsOf.get(id) ?? []), ...f.externalDeps].sort(),
      contentHash: code === null ? '' : sha256(code),
      code,
    });
  }
  const readOpt = async (p: string) => {
    try {
      // 先 lstat:非普通文件(符号链接等)或超过 MAX_SEND_BYTES 的不读,避免把超大 README 整个读进内存
      const st = await lstat(join(root, p));
      if (!st.isFile() || st.size > MAX_SEND_BYTES) return null;
      const c = await readFile(join(root, p), 'utf8');
      // README / package.json 也会进 repo 提示词:含 key 特征、超限或二进制就不送
      return exclusionRule(p, c) ? null : c;
    } catch {
      return null;
    }
  };
  // 跨 commit 复用:逐节点按 (level, targetId, inputHash) 查库(复合索引 idx_reuse,迁移 0002),优先当前 commit 的行;
  // 不再把仓库所有 commit 的摘要整表读进内存。旧 commit 行的清理跟随 D5 快照保留策略(见 BACKEND_AI_DESIGN)
  const lookup = (level: SummaryLevel, targetId: string, hash: string) =>
    store.findSummaryByInput(repoId, level, targetId, hash, commitSha);
  const task = await store.getTask(jobId);
  let last = 50;
  const r = await summarizeRepo(
    {
      repoName: data.repoUrl
        .replace(/\.git$/, '')
        .split('/')
        .slice(-2)
        .join('/'),
      tree,
      files,
      readme: await readOpt('README.md'),
      packageJson: await readOpt('package.json'),
      lookup,
    },
    {
      gateway: gatewayOf(deps),
      summaryModel: config.llm.summaryModel,
      repoModel: config.llm.chatModel,
      repoId,
      taskId: task?.id,
      save: (row) => store.upsertSummary(repoId, commitSha, row),
      onProgress: async (done, total) => {
        const pct = 50 + Math.floor((done / total) * 34);
        if (pct <= last) return;
        last = pct;
        await progress('summarizing', pct, `摘要 ${done}/${total}`);
      },
    },
  );
  const text = `摘要完成:LLM ${r.llm},规则 ${r.rule},复用 ${r.reused},失败降级 ${r.failed}`;
  const warn = r.budget
    ? `LLM ${r.budget.scope === 'task' ? '单任务' : '日'}预算已用尽,${r.budget.degraded} 个节点改用规则摘要`
    : null;
  return { text, warn };
}

export type PreparedChunks = Awaited<ReturnType<typeof buildChunks>>;

/**
 * 切块:来源优先用解析断点 `${root}.analysis.json` 里的顶层声明块;断点不在(图已入库、跳过解析的重跑)
 * 时按图里的文件整文件一块。所有文件先过共享排除规则(敏感 / 超大 / 二进制),命中的不产出切块。
 */
export async function prepareChunks(
  data: AnalyzeJobData,
  deps: PipelineDeps,
  root: string,
): Promise<PreparedChunks> {
  const { store } = deps;
  const { repoId, commitSha } = data;
  const ana = readJson<AnalyzeResult>(`${root}.analysis.json`);
  let files: ChunkSourceFile[];
  if (ana) {
    files = ana.parsed.map((p) => ({ path: p.path, chunks: p.chunks, sensitive: p.sensitive }));
  } else {
    const g = await store.loadGraph(repoId, commitSha);
    files = g.files.map((f) => ({
      path: f.path,
      chunks: f.loc > 0 ? [{ symbol: null, startLine: 1, endLine: f.loc }] : [],
    }));
  }
  const readSource = async (p: string) => {
    const rel = safeRelPath(p);
    if (!rel) return null;
    try {
      // 与摘要一致:先 lstat,非普通文件(符号链接等)和超过 MAX_SEND_BYTES 的不读
      const st = await lstat(join(root, rel));
      if (!st.isFile() || st.size > MAX_SEND_BYTES) return null;
      return await readFile(join(root, rel), 'utf8');
    } catch {
      return null;
    }
  };
  return buildChunks(files, readSource);
}

/**
 * 切块 + 向量化(T-214 第一部分)。切块来源优先用解析断点 `${root}.analysis.json` 里的
 * 顶层声明块;断点不在(图已入库、跳过解析的重跑)时按图里的文件整文件一块。
 * 所有文件先过共享排除规则(敏感 / 超大 / 二进制),命中的不产出切块、不送 embedding、不进向量库。
 */
export async function runEmbedding(
  data: AnalyzeJobData,
  deps: PipelineDeps,
  root: string,
  progress: (s: ProgressStage, pct: number, message?: string) => Promise<void>,
  /** 本任务(同 repo+commit)上次记录在 stats 里的内容 hash 汇总;与本次一致且点数相符才复用 */
  prevDigest: string | null = null,
  /** 已切好的块(runPipeline 写 code_chunk 时切过一次,这里复用) */
  prepared: PreparedChunks | null = null,
): Promise<{ chunks: number; reused: boolean; message: string; digest?: string }> {
  const { store, config } = deps;
  const { repoId, commitSha } = data;
  const { chunks, excluded } = prepared ?? (await prepareChunks(data, deps, root));
  // 跨任务复用:优先取同 (repo, commit) 最近一个成功任务记录的 digest,其次本任务上次的 digest
  const doneDigest = (await store.latestDoneTaskForCommit(repoId, commitSha))?.stats
    .embeddingDigest;
  const baseline = typeof doneDigest === 'string' ? doneDigest : prevDigest;
  const digest = chunksDigest(deps.embedder!, chunks);
  const index = (beforeWrite?: () => Promise<void>) =>
    indexChunks(
      { repoId, commitSha, chunks, batchSize: config.embedding.batchSize, prevDigest: baseline },
      deps.embedder!,
      deps.vectorStore!,
      (done, total) =>
        progress('embedding', 85 + Math.floor((done / total) * 14), `向量化 ${done}/${total} 块`),
      beforeWrite,
    );
  let r: { chunks: number; reused: boolean; digest?: string };
  if (deps.lockKv) {
    // 同 commit 并发任务:拿到锁的写,拿不到的不写、等持有者完成后记 reused;持有者失败则接手
    const locked = await withEmbedLock(
      deps.lockKv,
      embedLockKey(repoId, commitSha),
      (guard) => index(() => guard.assertHeld()),
      {
        ttlSec: config.embedding.lockTtlSec,
        maxWaitMs: config.embedding.lockMaxWaitSec * 1000,
        pollMs: deps.lockPollMs,
        renewMs: deps.lockRenewMs,
        prefix: deps.lockPrefix,
        digest,
        onWait: () => progress('embedding', 85, '等待同 commit 的另一任务完成向量化'),
      },
    );
    if (locked.ran) r = locked.result;
    else {
      // 等待者复用:完成标记 digest 一致之外,再核对向量库点数与本次切块数一致,不一致按失败处理
      const have = await deps.vectorStore!.count(repoId, commitSha);
      if (have !== chunks.length)
        throw new Error(`复用校验失败:向量库有 ${have} 个点,本次切块 ${chunks.length} 块`);
      r = { chunks: have, reused: true, digest };
    }
  } else r = await index();
  const skip = excluded.length ? `,排除 ${excluded.length} 个文件` : '';
  return {
    ...r,
    message: r.reused
      ? `该 commit 已有 ${r.chunks} 个向量,复用${skip}`
      : `向量化完成:${r.chunks} 块${skip}`,
  };
}
