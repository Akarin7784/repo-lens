import { createHash } from 'node:crypto';
import type { GraphIndex, SummaryLevel, SummaryRow } from '@repolens/db';
import type { LlmGateway } from '../llm/gateway.js';
import { LlmError, type LlmMessage } from '../llm/types.js';
import { PROMPT_VERSION, dirPrompt, filePrompt, parseSummary, repoPrompt } from './prompts.js';
import { ruleDirSummary, ruleFileSummary, ruleRepoSummary } from './rules.js';

export const RULE_MODEL = 'rule';
/** D8:按 fanIn 取前 200 个文件做 LLM 文件摘要,其余只做规则摘要 */
export const DEFAULT_MAX_LLM_FILES = 200;
export const REPO_TARGET = 'repo';

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
}

export interface SummarizeInput {
  repoName: string;
  tree: GraphIndex;
  /** key = 文件节点 id(f:…) */
  files: Map<string, SummaryFileInput>;
  readme: string | null;
  packageJson: string | null;
  /** 已有摘要,key = `${level}|${targetId}` */
  existing: Map<string, SummaryRow>;
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
  /** 预算熔断:触发的预算级别与之后改用规则摘要的节点数 */
  budget: { scope: 'daily' | 'task'; degraded: number } | null;
}

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
  const res: SummarizeResult = { total: 0, llm: 0, rule: 0, reused: 0, failed: 0, budget: null };

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
        const r = await deps.gateway.complete({
          model,
          messages: msgs,
          json: true,
          maxTokens: 600,
          purpose: 'summary',
          repoId: deps.repoId,
          taskId: deps.taskId,
        });
        const s = parseSummary(r.text);
        if (s) return { text: s, ...r.usage };
      } catch (err) {
        if (err instanceof LlmError && err.code === 'BUDGET_EXCEEDED') {
          res.budget ??= { scope: err.scope ?? 'daily', degraded: 0 };
          return null;
        }
        // LLM_UNAVAILABLE / 未知模型等:重试一次
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
  ) => {
    const prev = inp.existing.get(summaryKey(level, targetId));
    const llmHash = inputHash(level, model, llmInput);
    const ruleHash = inputHash(level, RULE_MODEL, ruleInput);
    let row: SummaryRow | null = null;
    if (prev && prev.inputHash === (mode === 'llm' ? llmHash : ruleHash)) {
      res.reused++;
      content.set(targetId, prev.content);
      await tick();
      return;
    }
    if (mode === 'llm') {
      const out = await callLlm(model, messages());
      if (out) {
        res.llm++;
        row = {
          level,
          targetId,
          inputHash: llmHash,
          model,
          content: out.text,
          tokensIn: out.tokensIn,
          tokensOut: out.tokensOut,
        };
      } else if (res.budget) {
        res.budget.degraded++;
      }
    }
    if (!row) {
      if (prev && prev.inputHash === ruleHash) {
        res.reused++;
        content.set(targetId, prev.content);
        await tick();
        return;
      }
      res.rule++;
      row = {
        level,
        targetId,
        inputHash: ruleHash,
        model: RULE_MODEL,
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
    const ruleInput = JSON.stringify([info.path, info.lang, info.loc, info.exports]);
    const mode: Mode = llmFiles.has(n.id) && info.code !== null ? 'llm' : 'rule';
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
    const children = kids.map((id) => ({ id, summary: content.get(id) ?? '' }));
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
      JSON.stringify([n.path, kind, children]),
      () => dirPrompt({ path: n.path, kind, children }),
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
