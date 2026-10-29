import { createHash } from 'node:crypto';
import type { GraphIndex, SummaryLevel, SummaryRow, SummarySource } from '@repolens/db';
import type { LlmGateway } from '../llm/gateway.js';
import { LlmError, type LlmMessage } from '../llm/types.js';
import {
  PROMPT_VERSION,
  capChildren,
  dirPrompt,
  filePrompt,
  parseSummary,
  repoPrompt,
} from './prompts.js';
import { ruleDirSummary, ruleFileSummary, ruleRepoSummary } from './rules.js';

export const RULE_MODEL = 'rule';
/** D8:按 fanIn 取前 200 个文件做 LLM 文件摘要,其余只做规则摘要 */
export const DEFAULT_MAX_LLM_FILES = 200;
export const REPO_TARGET = 'repo';
/** 单个文件摘要调用的超时(每次尝试);超时按失败处理:重试 1 次,仍超时用规则摘要 */
export const DEFAULT_FILE_TIMEOUT_MS = 30_000;

export class SummaryTimeoutError extends Error {
  constructor(ms: number) {
    super(`摘要调用超过 ${ms}ms`);
    this.name = 'SummaryTimeoutError';
  }
}

/**
 * 带超时地执行一次调用:超时时 abort 传给调用的 signal(真正中止底层请求,迟到响应不会再计费),
 * 并以 SummaryTimeoutError 失败。外部 signal(如任务取消)用 AbortSignal.any 合并。
 */
async function withTimeout<T>(
  run: (signal: AbortSignal | undefined) => Promise<T>,
  ms: number | undefined,
  external?: AbortSignal,
): Promise<T> {
  if (!ms || ms <= 0) return run(external);
  const ctl = new AbortController();
  const signal = external ? AbortSignal.any([ctl.signal, external]) : ctl.signal;
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => {
      const e = new SummaryTimeoutError(ms);
      ctl.abort(e);
      rej(e);
    }, ms);
  });
  const p = run(signal);
  p.catch(() => {}); // 超时后底层的 AbortError 不再有人等,避免 unhandled rejection
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

export interface SummaryFileInput {
  path: string;
  lang: string;
  loc: number;
  exports: string[];
  /** 依赖的文件路径与外部包名 */
  imports: string[];
  contentHash: string;
  /** 源码(读快照);读不到时为 null,只能用规则摘要 */
  code: string | null;
  /** 命中敏感文件规则时的规则 id:只做规则摘要(路径/语言/行数),内容绝不进提示词 */
  sensitive?: string | null;
}

export interface SummarizeInput {
  repoName: string;
  tree: GraphIndex;
  /** key = 文件节点 id(f:…) */
  files: Map<string, SummaryFileInput>;
  readme: string | null;
  packageJson: string | null;
  /**
   * 已有摘要(可跨 commit),key = `${level}|${targetId}`,
   * 或 `${level}|${targetId}#${inputHash}`(同一节点多个 commit 各有一份时按哈希精确命中)
   */
  existing?: Map<string, SummaryRow>;
  /**
   * 按输入哈希查可复用的旧摘要(优先于 existing)。worker 用它逐节点查库(store.findSummaryByInput),
   * 不再把仓库所有 commit 的摘要一次读进内存
   */
  lookup?: (level: SummaryLevel, targetId: string, inputHash: string) => Promise<SummaryRow | null>;
}

export interface SummarizeDeps {
  gateway: LlmGateway;
  summaryModel: string;
  /** repo 层用的大模型 */
  repoModel: string;
  repoId: number;
  taskId?: number;
  maxLlmFiles?: number;
  concurrency?: number;
  /** 单文件摘要调用超时,默认 DEFAULT_FILE_TIMEOUT_MS;0 表示不限 */
  fileTimeoutMs?: number;
  /** 外部取消(可选):与单文件超时合并后传给 LLM 请求 */
  signal?: AbortSignal;
  save: (row: SummaryRow) => Promise<void>;
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

export interface SummarizeResult {
  total: number;
  /** 本次调 LLM(含网关缓存命中)生成 */
  llm: number;
  /** 本次用规则生成 */
  rule: number;
  /** input_hash 未变,直接复用库里的摘要(不经过网关,不写 llm_usage) */
  reused: number;
  /** LLM 重试后仍失败、降级成规则摘要的节点数 */
  failed: number;
  /** 文件摘要调用超时的次数(每次尝试计 1) */
  timedOut: number;
  /** 预算熔断:触发的预算级别与之后改用规则摘要的节点数 */
  budget: { scope: 'daily' | 'task'; degraded: number } | null;
}

/** 旧行没有 source 时按模型名推断 */
export const sourceOfModel = (model: string): SummarySource =>
  model === RULE_MODEL ? 'rule' : 'llm';
export const summaryKey = (level: SummaryLevel, targetId: string) => `${level}|${targetId}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const inputHash = (level: SummaryLevel, model: string, input: string) =>
  sha256(`${level}\n${model}\nv${PROMPT_VERSION}\n${input}`);

type Mode = 'llm' | 'rule';

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

/**
 * 分层摘要(BACKEND_AI_DESIGN §4,不含 function 层):file → dir → module → repo,后序遍历,上层只读下层摘要。
 * - input_hash = sha256(level + model + promptVersion + 输入);与库里一致就复用,不经过网关(同 commit 重跑不新增 llm_usage)。
 * - fanIn 前 maxLlmFiles 个文件走 LLM,其余文件规则摘要;dir/module/repo 走 LLM。
 * - LLM 失败或 JSON 解析失败重试 1 次(D6),仍失败用规则摘要。
 * - 网关抛 BUDGET_EXCEEDED 后,剩余所有节点改用规则摘要(已复用的 LLM 摘要不受影响)。
 */
export async function summarizeRepo(
  inp: SummarizeInput,
  deps: SummarizeDeps,
): Promise<SummarizeResult> {
  const { tree } = inp;
  const conc = deps.concurrency ?? 4;
  const content = new Map<string, string>(); // nodeId → 摘要
  const res: SummarizeResult = {
    total: 0,
    llm: 0,
    rule: 0,
    reused: 0,
    failed: 0,
    timedOut: 0,
    budget: null,
  };

  const fileNodes = [...tree.nodes.values()].filter((n) => n.type === 'file');
  const dirs = [...tree.nodes.values()].filter((n) => n.type === 'dir');
  const modules = [...tree.nodes.values()].filter((n) => n.type === 'module');
  res.total = fileNodes.length + dirs.length + modules.length + 1;
  let done = 0;
  const tick = async () => {
    done++;
    await deps.onProgress?.(done, res.total);
  };

  const ranked = [...fileNodes].sort(
    (a, b) => (tree.fanIn.get(b.id) ?? 0) - (tree.fanIn.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1),
  );
  const llmFiles = new Set(
    ranked.slice(0, deps.maxLlmFiles ?? DEFAULT_MAX_LLM_FILES).map((n) => n.id),
  );

  /** 调 LLM;返回 null 表示该节点要降级为规则摘要 */
  const callLlm = async (
    model: string,
    messages: LlmMessage[],
    timeoutMs?: number,
  ): Promise<{ text: string; tokensIn: number; tokensOut: number } | null> => {
    if (res.budget) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const msgs =
        attempt === 0
          ? messages
          : [
              ...messages,
              {
                role: 'user' as const,
                content: '上次输出无法解析或调用失败。只输出 JSON 对象 {"summary": "..."}。',
              },
            ];
      try {
        const r = await withTimeout(
          (signal) =>
            deps.gateway.complete({
              model,
              messages: msgs,
              json: true,
              maxTokens: 600,
              purpose: 'summary',
              repoId: deps.repoId,
              taskId: deps.taskId,
              signal,
            }),
          timeoutMs,
          deps.signal,
        );
        const s = parseSummary(r.text);
        if (s) return { text: s, ...r.usage };
      } catch (err) {
        if (err instanceof LlmError && err.code === 'BUDGET_EXCEEDED') {
          res.budget ??= { scope: err.scope ?? 'daily', degraded: 0 };
          return null;
        }
        if (err instanceof SummaryTimeoutError) res.timedOut++;
        // 超时 / LLM_UNAVAILABLE / 未知模型等:重试一次
      }
    }
    res.failed++;
    return null;
  };

  /** 统一处理一个节点:hash 比对复用 → LLM → 规则 */
  const handle = async (
    level: SummaryLevel,
    targetId: string,
    mode: Mode,
    model: string,
    llmInput: string,
    messages: () => LlmMessage[],
    ruleInput: string,
    rule: () => string,
    timeoutMs?: number,
  ) => {
    const key = summaryKey(level, targetId);
    const prevWith = async (hash: string) => {
      if (inp.lookup) return inp.lookup(level, targetId, hash);
      const p = inp.existing?.get(`${key}#${hash}`) ?? inp.existing?.get(key);
      return p && p.inputHash === hash ? p : null;
    };
    const llmHash = inputHash(level, model, llmInput);
    const ruleHash = inputHash(level, RULE_MODEL, ruleInput);
    let row: SummaryRow | null = null;
    // 复用:输入哈希相同就沿用旧行(内容与来源都保持),并为当前 commit 写一份
    const reuse = async (prev: SummaryRow) => {
      res.reused++;
      const keep: SummaryRow = { ...prev, source: prev.source ?? sourceOfModel(prev.model) };
      delete keep.commitSha; // 写到当前 commit,由 save 决定
      await deps.save(keep);
      content.set(targetId, prev.content);
      await tick();
    };
    const hit = await prevWith(mode === 'llm' ? llmHash : ruleHash);
    if (hit) return reuse(hit);
    if (mode === 'llm') {
      const out = await callLlm(model, messages(), timeoutMs);
      if (out) {
        res.llm++;
        row = {
          level,
          targetId,
          inputHash: llmHash,
          model,
          source: 'llm',
          content: out.text,
          tokensIn: out.tokensIn,
          tokensOut: out.tokensOut,
        };
      } else if (res.budget) {
        res.budget.degraded++;
      }
    }
    if (!row) {
      const ruleHit = await prevWith(ruleHash);
      if (ruleHit) return reuse(ruleHit);
      res.rule++;
      row = {
        level,
        targetId,
        inputHash: ruleHash,
        model: RULE_MODEL,
        source: 'rule',
        content: rule(),
        tokensIn: 0,
        tokensOut: 0,
      };
    }
    await deps.save(row);
    content.set(targetId, row.content);
    await tick();
  };

  // 1) file
  await pool(fileNodes, conc, async (n) => {
    const f = inp.files.get(n.id);
    const info = f ?? {
      path: n.path,
      lang: 'unknown',
      loc: n.loc ?? 0,
      exports: [],
      imports: [],
      contentHash: '',
      code: null,
    };
    if (info.sensitive) {
      // 双保险:调用方已清空 code/exports,这里再强制只用路径、语言、行数
      info.code = null;
      info.exports = [];
      info.imports = [];
    }
    const ruleInput = JSON.stringify([info.path, info.lang, info.loc, info.exports]);
    const mode: Mode = llmFiles.has(n.id) && info.code !== null && !info.sensitive ? 'llm' : 'rule';
    const llmInput = JSON.stringify([
      info.path,
      info.lang,
      info.loc,
      info.exports,
      info.imports,
      info.contentHash,
    ]);
    await handle(
      'file',
      n.id,
      mode,
      deps.summaryModel,
      llmInput,
      () => filePrompt({ ...info, code: info.code ?? '' }),
      ruleInput,
      () => ruleFileSummary(info),
      deps.fileTimeoutMs ?? DEFAULT_FILE_TIMEOUT_MS,
    );
  });

  // 2) dir(深的先)→ 3) module:上层只读子节点摘要
  const depth = (id: string) => tree.ancestors(id).length;
  const byDepth = new Map<number, typeof dirs>();
  for (const d of dirs) {
    const k = depth(d.id);
    if (!byDepth.has(k)) byDepth.set(k, []);
    byDepth.get(k)!.push(d);
  }
  const summarizeContainer = async (
    n: (typeof dirs)[number] | (typeof modules)[number],
    kind: 'dir' | 'module',
  ) => {
    const kids = (tree.children.get(n.id) ?? []).slice().sort();
    // 子项摘要总长度有上限;hash 只看实际放进提示词的子项与省略数
    const { kept: children, omitted } = capChildren(
      kids.map((id) => ({ id, summary: content.get(id) ?? '' })),
    );
    const files = tree.filesUnder(n.id);
    const loc = files.reduce((s, f) => s + ('loc' in f ? (f.loc ?? 0) : 0), 0);
    const labels = kids
      .map((id) => tree.nodes.get(id)!)
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (a.id < b.id ? -1 : 1))
      .map((c) => c.label);
    const ruleInput = JSON.stringify([n.path, kind, files.length, loc, labels]);
    await handle(
      'dir',
      n.id,
      'llm',
      deps.summaryModel,
      JSON.stringify(omitted ? [n.path, kind, children, omitted] : [n.path, kind, children]),
      () => dirPrompt({ path: n.path, kind, children, omitted }),
      ruleInput,
      () => ruleDirSummary({ path: n.path, kind, fileCount: files.length, loc, children: labels }),
    );
  };
  for (const k of [...byDepth.keys()].sort((a, b) => b - a))
    await pool(byDepth.get(k)!, conc, (d) => summarizeContainer(d, 'dir'));
  await pool(modules, conc, (m) => summarizeContainer(m, 'module'));

  // 4) repo
  const mods = modules
    .slice()
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (a.id < b.id ? -1 : 1))
    .map((m) => ({ id: m.id, summary: content.get(m.id) ?? '' }));
  const modLabels = mods.map((m) => m.id.slice(2));
  await handle(
    'repo',
    REPO_TARGET,
    'llm',
    deps.repoModel,
    JSON.stringify([
      inp.repoName,
      mods,
      inp.readme?.slice(0, 2000) ?? null,
      inp.packageJson?.slice(0, 2000) ?? null,
    ]),
    () =>
      repoPrompt({
        name: inp.repoName,
        modules: mods,
        readme: inp.readme,
        packageJson: inp.packageJson,
      }),
    JSON.stringify([inp.repoName, fileNodes.length, modLabels]),
    () => ruleRepoSummary({ name: inp.repoName, fileCount: fileNodes.length, modules: modLabels }),
  );
  return res;
}
