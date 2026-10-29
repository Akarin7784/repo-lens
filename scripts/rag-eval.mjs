/* global process, console, URL */
// T-214 检索评测(手动,CI 不跑):hono @ ed1d5f7,真实 ONNX(e5-small fp32,本地模型目录,不联网)+ 内存向量库 + 查询改写。
// 用法:pnpm build && node scripts/rag-eval.mjs <tuning|holdout|s1> [--fake-llm]
// 留出集(只跑一次):v2 = zod(ZOD_DIR),v3 = h3(H3_DIR);配置见 rag-eval-holdout-lib.mjs 的 HOLDOUTS
//   ZOD_DIR=…|H3_DIR=… EMBEDDING_MODEL_DIR=… node scripts/rag-eval.mjs <v2|v3> [--force]
//   [--id-letter X --commit SHA --prefix dir/ --rows N --holdout-file docs/…](覆盖配置)
//   题目从 HO.file 机械解析;必须真实 DeepSeek(不允许 fake);结果同时写入 <V2|V3>_RESULT_FILE
//   (默认 /tmp/rl-eval-<v2|v3>-result.txt),该文件已存在时拒绝再跑,除非 --force(输出里留 FORCE 标记)。
//   HONO_DIR(默认 /tmp/hono)  EMBEDDING_MODEL_DIR(必填,含 Xenova/multilingual-e5-small)
//   改写:有 DEEPSEEK_API_KEY 且未加 --fake-llm 时走真实 DeepSeek;否则 FakeLlm(结果须标「改写未运行」)。
// 只打印题目、命中与 usage;绝不打印 key(输出前抹掉)。向量缓存在 /tmp/rl-eval-vectors.json(只含公开仓库切块向量),
// 按 embedding digest(模型 + revision + 切块版本 + 文本模板版本 + 每块内容 hash)判断复用,不按块数;
// 改写缓存在 /tmp/rl-eval-rewrites.json,key = 问题 + 提示词版本 + 模型(同一问题重跑不再调模型)。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  HOLDOUTS,
  resolveHoldoutConfig,
  parseHoldout,
  judge,
  scoreQuestion,
  assertRunOnce,
} from './rag-eval-holdout-lib.mjs';
import { analyzeRepo, scanSourceFiles } from '../packages/analyzer/dist/index.js';
import {
  OnnxEmbedder,
  MemoryVectorStore,
  buildChunks,
  hybridSearch,
  buildKeywordIndex,
  bm25,
  exactMatches,
  tokenize,
  stem,
  indexChunks,
  pointId,
  chunksDigest,
  CURRENT_EMBEDDING_VERSIONS,
  DEFAULT_EMBEDDING_MODEL_REVISION,
} from '../packages/rag/dist/index.js';
import {
  DEFAULT_PRICES,
  FakeLlm,
  LlmGateway,
  MemoryLlmKv,
  createLlmClient,
  readLlmConfig,
  rewriteQuery,
  REWRITE_PROMPT_VERSION,
} from '../packages/agent/dist/index.js';
import { MemoryStore } from '../packages/db/dist/index.js';

const HONO_SHA = 'ed1d5f72135ccf7e09c17d64dc4af7588dd3e491';
// 留出集(v2、v3…):配置来自 HOLDOUTS,可用 --id-letter/--commit/--prefix/--rows/--holdout-file 覆盖
const HO = Object.hasOwn(HOLDOUTS, process.argv[2])
  ? resolveHoldoutConfig(process.argv[2], process.argv.slice(3))
  : null;
const V2 = HO !== null;
const SHA = V2 ? HO.commit : HONO_SHA;
const key = process.env.DEEPSEEK_API_KEY?.trim() ?? '';
const scrub = (s) => (key ? String(s).split(key).join('***') : String(s));
const V2_RESULT = V2
  ? process.env[`${HO.name.toUpperCase()}_RESULT_FILE`] || `/tmp/rl-eval-${HO.name}-result.txt`
  : null;
let resultReady = false;
const out = (s) => {
  console.log(scrub(s));
  if (V2 && resultReady) appendFileSync(V2_RESULT, scrub(s) + '\n');
};

const SETS = {
  tuning: [
    ['中1', '如何设置 CORS 跨域中间件', ['src/middleware/cors/index.ts'], ['cors']],
    ['中2', '怎么从请求里读取 JSON 请求体', ['src/request.ts'], ['HonoRequest', 'json']],
    ['中3', '路由参数是怎么解析的', ['src/request.ts', 'src/router/'], null],
    ['中4', '如何返回流式响应', ['src/helper/streaming/'], null],
    ['中5', 'JWT 鉴权中间件怎么验证 token', ['src/middleware/jwt/jwt.ts'], ['jwt']],
    ['中6', '如何设置和读取 cookie', ['src/helper/cookie/index.ts'], ['setCookie', 'getCookie']],
    [
      '英1',
      'how to set up basic auth middleware',
      ['src/middleware/basic-auth/index.ts'],
      ['basicAuth'],
    ],
    ['英2', 'where are route parameters matched in the router', ['src/router/'], null],
    ['英3', 'how to serve static files', ['src/middleware/serve-static/'], null],
    ['英4', 'how does the app handle errors and not found', ['src/hono-base.ts'], null],
    ['英5', 'compress response with gzip', ['src/middleware/compress/index.ts'], ['compress']],
    [
      '英6',
      'validate request body with a validator',
      ['src/validator/validator.ts'],
      ['validator'],
    ],
  ],
  // 判定按 RAG_HOLDOUT.md:文件属于应命中文件,且(列了符号时)切块符号为所列之一或其所属类(如 Context 类覆盖 set/get/var)
  holdout: [
    ['H1', '中间件是怎么串联执行的?', ['src/compose.ts'], ['compose']],
    ['H2', 'Context 对象是做什么的?', ['src/context.ts'], ['Context']],
    [
      'H3',
      '一个请求从进来到返回响应,在 Hono 里经过了哪些步骤?',
      ['src/hono-base.ts', 'src/compose.ts'],
      ['Hono', 'compose'],
    ],
    ['H4', '中间件之间怎么传递数据?', ['src/context.ts'], ['Context']],
    ['H5', '怎么限制请求体的大小?', ['src/middleware/body-limit/index.ts'], ['bodyLimit']],
    [
      'H6',
      '如何给每个请求生成一个请求 ID?',
      ['src/middleware/request-id/request-id.ts'],
      ['requestId'],
    ],
    ['H7', '怎么防御 CSRF 攻击?', ['src/middleware/csrf/index.ts'], ['csrf']],
    [
      'H8',
      '如何自己写一个可复用、带类型的中间件?',
      ['src/helper/factory/index.ts'],
      ['createMiddleware'],
    ],
  ],
  s1: [
    [
      'S1',
      '路由匹配在哪个文件?',
      [
        'src/router/smart-router/router.ts',
        'src/router/reg-exp-router/router.ts',
        'src/router/reg-exp-router/matcher.ts',
        'src/router/trie-router/router.ts',
      ],
      null,
    ],
  ],
};

const setName = process.argv[2];
const FORCE = process.argv.includes('--force');
if (V2) {
  // 防误跑:结果文件已存在则拒绝,除非 --force
  assertRunOnce({
    name: HO.name,
    resultFile: V2_RESULT,
    exists: existsSync(V2_RESULT),
    force: FORCE,
  });
  if (process.argv.includes('--fake-llm')) throw new Error(`${HO.name} 不允许 --fake-llm`);
  if (!key) throw new Error(`${HO.name} 需要环境变量 DEEPSEEK_API_KEY(不允许退回 FakeLlm)`);
  // 题目在任何仓库分析前先严格解析,解析失败直接报错
  SETS[HO.name] = parseHoldout(
    readFileSync(new URL(`../${HO.file}`, import.meta.url), 'utf8'),
    HO,
  ).map((r) => [r.id, r.question, r.want, null]);
}
const fake = process.argv.includes('--fake-llm') || !key;
const DIAG = setName === 'diag-s1';
const ATTRIB = setName === 'attrib';
if (!SETS[setName] && !DIAG && !ATTRIB)
  throw new Error('用法: rag-eval.mjs <tuning|holdout|s1|v2|v3> [--fake-llm] [--force]');
if (V2 && !process.env[HO.dirEnv]) throw new Error(`${HO.name} 需要 ${HO.dirEnv}`);
const root = V2 ? process.env[HO.dirEnv] : (process.env.HONO_DIR ?? '/tmp/hono');
const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
if (head !== SHA) throw new Error(`${V2 ? HO.repo : 'hono'} HEAD ${head} != ${SHA}`);
const mainSha = execFileSync('git', [
  '-C',
  new URL('..', import.meta.url).pathname,
  'rev-parse',
  'HEAD',
])
  .toString()
  .trim();
const modelDir = process.env.EMBEDDING_MODEL_DIR;
if (!modelDir) throw new Error('需要 EMBEDDING_MODEL_DIR');

const ana = await analyzeRepo({ root, files: scanSourceFiles(root) });
const files = ana.parsed.map((p) => ({ path: p.path, chunks: p.chunks, sensitive: p.sensitive }));
const read = async (p) => {
  try {
    return readFileSync(`${root}/${p}`, 'utf8');
  } catch {
    return null;
  }
};
const { chunks } = await buildChunks(files, read);
const lines = new Map();
const rows = [];
for (const c of chunks) {
  if (!lines.has(c.path)) lines.set(c.path, (await read(c.path)).split('\n'));
  rows.push({
    path: c.path,
    symbol: c.symbol,
    startLine: c.startLine,
    endLine: c.endLine,
    content: lines
      .get(c.path)
      .slice(c.startLine - 1, c.endLine)
      .join('\n'),
    qdrantPointId: pointId(1, SHA, {
      path: c.path,
      symbol: c.symbol,
      start_line: c.startLine,
      end_line: c.endLine,
    }),
  });
}
// 本地模型目录须是 Dockerfile 固定的 revision(EMBEDDING_MODEL_REVISION 可覆盖)
const revision = process.env.EMBEDDING_MODEL_REVISION || DEFAULT_EMBEDDING_MODEL_REVISION;
const emb = new OnnxEmbedder(
  'Xenova/multilingual-e5-small',
  modelDir,
  undefined,
  undefined,
  revision,
);
const digest = chunksDigest(emb, chunks);
const V = CURRENT_EMBEDDING_VERSIONS;
out(
  `EVAL versions chunker=${V.chunker} embedText=${V.embedText} model=${emb.model}@${revision} prompt=${REWRITE_PROMPT_VERSION} digest=${digest.slice(0, 12)}`,
);
const vs = new MemoryVectorStore();
// v2 用独立缓存文件,键除 digest(已含各版本)外再显式核对 commit、切块/拼接版本、模型修订与块数
const cache = V2 ? `/tmp/rl-eval-vectors-${HO.name}.json` : '/tmp/rl-eval-vectors.json';
const cached = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : null;
const cacheKeyOk =
  !V2 ||
  (cached?.sha === SHA &&
    cached?.chunker === V.chunker &&
    cached?.embedText === V.embedText &&
    cached?.revision === revision);
if (cacheKeyOk && cached?.digest === digest && cached.points?.length === chunks.length) {
  for (const p of cached.points) vs.points.set(p.id, p);
  out(`EVAL vectors reused (digest match)`);
} else {
  const t0 = Date.now();
  await indexChunks({ repoId: 1, commitSha: SHA, chunks, batchSize: 16 }, emb, vs);
  writeFileSync(
    cache,
    JSON.stringify({
      digest,
      n: chunks.length,
      sha: SHA,
      chunker: V.chunker,
      embedText: V.embedText,
      revision,
      points: [...vs.points.values()],
    }),
  );
  out(`EVAL embedded ${chunks.length} chunks in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

const byId = new Map(rows.map((c) => [c.qdrantPointId, c]));
const env = { ...process.env, LLM_PROVIDER: fake ? 'fake' : 'deepseek' };
const cfg = readLlmConfig(env);
const client = fake ? new FakeLlm() : createLlmClient(cfg, { env });
const gateway = new LlmGateway({
  client,
  kv: new MemoryLlmKv(),
  usage: new MemoryStore(),
  prices: DEFAULT_PRICES,
  dailyBudgetCents: 100,
});

const rwFile = '/tmp/rl-eval-rewrites.json';
const rwStore = existsSync(rwFile) ? JSON.parse(readFileSync(rwFile, 'utf8')) : {};
// fake LLM 的改写不写缓存(避免污染真实改写结果)
const rwCache = fake
  ? undefined
  : {
      get: (k) => rwStore[k] ?? null,
      set: (k, v) => {
        rwStore[k] = v;
        writeFileSync(rwFile, JSON.stringify(rwStore, null, 1));
      },
    };

const okFile = (path, want) =>
  want.some((w) => (w.endsWith('/') ? path.startsWith(w) : path === w));
const fileLevel = setName === 'tuning'; // 调参题只给「参考」位置,按文件判定
const okHit = (h, want, syms) =>
  okFile(h.path, want) && (fileLevel || !syms || h.symbol === null || syms.includes(h.symbol));
// 归因(只读,不调参):未命中题各路在完整列表中的名次;候选数与 hybridSearch 默认一致(50)
if (ATTRIB) {
  const ids = new Set(['H2', 'H4', 'H7', 'H8', 'S1', '英3']);
  const qs = [...SETS.tuning, ...SETS.holdout, ...SETS.s1].filter((x) => ids.has(x[0]));
  const idx = buildKeywordIndex(rows);
  const N = rows.length;
  for (const [id, q, want, syms] of qs) {
    const judge = id[0] === '英' ? (c) => okFile(c.path, want) : (c) => okHit(c, want, syms);
    const fileOnly = (c) => okFile(c.path, want);
    let log;
    const rewritten = await rewriteQuery(q, {
      gateway,
      model: cfg.chatModel,
      cache: rwCache,
      log: (l) => (log = l),
    });
    const kwQuery = rewritten === q ? q : `${rewritten} ${q}`;
    const vR = (await vs.search(1, SHA, await emb.embedQuery(rewritten), N)).map((h) =>
      byId.get(h.id),
    );
    const vO = (await vs.search(1, SHA, await emb.embedQuery(q), N)).map((h) => byId.get(h.id));
    const kw = bm25(idx, kwQuery, N).map(([i]) => rows[i]);
    const ex = exactMatches(rows, kwQuery, N).map((i) => rows[i]);
    const fu = (
      await hybridSearch({
        repoId: 1,
        commitSha: SHA,
        question: q,
        rewritten,
        chunks: rows,
        embeddingStatus: 'ready',
        embedder: emb,
        vectorStore: vs,
        limit: N,
      })
    ).hits;
    const r = (l, f) => {
      const i = l.findIndex(f);
      return i < 0 ? '无' : i + 1;
    };
    out(`ATTRIB ${id} rw="${rewritten}" used=${log?.used ?? false}`);
    out(
      `   判定命中 名次: 向量(改写)=${r(vR, judge)} 向量(原问题)=${r(vO, judge)} BM25=${r(kw, judge)} 精确=${r(ex, judge)} RRF=${r(fu, judge)}`,
    );
    out(
      `   仅文件   名次: 向量(改写)=${r(vR, fileOnly)} 向量(原问题)=${r(vO, fileOnly)} BM25=${r(kw, fileOnly)} 精确=${r(ex, fileOnly)} RRF=${r(fu, fileOnly)}`,
    );
  }
  process.exit(0);
}
// S1 诊断(只读,不改检索逻辑):各路 top10 与正确文件名次
if (DIAG) {
  const [, q, want] = SETS.s1[0];
  const isRouterImpl = (path) => path.startsWith('src/router/') && !path.includes('.test.');
  const rank = (list) => {
    const i = list.findIndex((c) => isRouterImpl(c.path));
    return i < 0 ? '>10' : String(i + 1);
  };
  const exactWant = (list) => {
    const i = list.findIndex((c) => want.includes(c.path) && c.symbol === 'match');
    return i < 0 ? '>10' : String(i + 1);
  };
  const show = (name, list, extra = () => '') => {
    out(
      `DIAG ${name}: 首个 src/router/ 实现名次=${rank(list)} 首个应命中 match 名次=${exactWant(list)}`,
    );
    for (const [i, c] of list.entries())
      out(`   ${i + 1}. ${c.path}:${c.startLine}-${c.endLine} ${c.symbol ?? '-'}${extra(c, i)}`);
  };
  let log;
  const rewritten = await rewriteQuery(q, {
    gateway,
    model: cfg.chatModel,
    cache: rwCache,
    log: (l) => (log = l),
  });
  out(
    `DIAG q="${q}" rewritten="${rewritten}" used=${log?.used} costMicroUsd=${log?.costMicroUsd ?? 0}`,
  );
  const kwQuery = rewritten === q ? q : `${rewritten} ${q}`;
  const idx = buildKeywordIndex(rows);
  out(`DIAG tokens(kwQuery)=${JSON.stringify(tokenize(kwQuery).map(stem))}`);
  const vec = async (text) =>
    (await vs.search(1, SHA, await emb.embedQuery(text), 10)).map((h) => byId.get(h.id));
  show('向量(改写后)', await vec(rewritten));
  show('向量(原问题,不改写)', await vec(q));
  const kw = bm25(idx, kwQuery, 10);
  show(
    'BM25(改写+原问题)',
    kw.map(([i]) => rows[i]),
    (c, i) => ` bm25=${kw[i][1].toFixed(2)}`,
  );
  const kwO = bm25(idx, q, 10);
  show(
    'BM25(仅原问题)',
    kwO.map(([i]) => rows[i]),
  );
  show(
    '精确匹配',
    exactMatches(rows, kwQuery, 10).map((i) => rows[i]),
  );
  for (const [label, rw] of [
    ['RRF(改写)', rewritten],
    ['RRF(不改写)', q],
  ]) {
    const r = await hybridSearch({
      repoId: 1,
      commitSha: SHA,
      question: q,
      rewritten: rw,
      chunks: rows,
      embeddingStatus: 'ready',
      embedder: emb,
      vectorStore: vs,
      limit: 10,
    });
    show(label, r.hits, (c) => ` rrf=${c.score.toFixed(4)} [${c.sources.join(',')}]`);
  }
  // 正确文件在完整列表中的名次(不截断)
  const full = (await vs.search(1, SHA, await emb.embedQuery(rewritten), rows.length)).map((h) =>
    byId.get(h.id),
  );
  const fullO = (await vs.search(1, SHA, await emb.embedQuery(q), rows.length)).map((h) =>
    byId.get(h.id),
  );
  const fullK = bm25(idx, kwQuery, rows.length).map(([i]) => rows[i]);
  for (const w of want) {
    const r1 = (l) => {
      const i = l.findIndex((c) => c.path === w && c.symbol === 'match');
      return i < 0 ? '无' : i + 1;
    };
    out(
      `DIAG 全量名次 ${w} match: 向量(改写)=${r1(full)} 向量(原问题)=${r1(fullO)} BM25=${r1(fullK)}`,
    );
  }
  process.exit(0);
}
let top5 = 0;
let top1 = 0;
let calls = 0;
let cost = 0;
const per = {
  中: [0, 0, 0, 0, 0],
  英: [0, 0, 0, 0, 0],
  H: [0, 0, 0, 0, 0],
  S: [0, 0, 0, 0, 0],
  V: [0, 0, 0, 0, 0],
};
if (V2) per[HO.idLetter] ??= [0, 0, 0, 0, 0];
let failed = 0;
if (V2) {
  if (fake || cfg.provider !== 'deepseek')
    throw new Error(`${HO.name} 要求 llm=deepseek,实际 ${cfg.provider}`);
  writeFileSync(V2_RESULT, '');
  resultReady = true;
  if (FORCE) out(`EVAL ${HO.name} FORCE-RERUN(--force:结果文件此前已存在或被显式覆盖)`);
  out(
    `EVAL ${HO.name} start main=${mainSha} ${HO.repo}=${SHA} prefix=${HO.prefix} idLetter=${HO.idLetter} rows=${HO.expectedRows} chunks=${chunks.length} chunker=${V.chunker} embedText=${V.embedText} model=${emb.model}@${revision} prompt=${REWRITE_PROMPT_VERSION} digest=${digest} llm=${cfg.provider}/${cfg.chatModel}`,
  );
}
for (const [id, q, want, syms] of SETS[setName]) {
  let log;
  const rewritten = await rewriteQuery(q, {
    gateway,
    model: cfg.chatModel,
    cache: rwCache,
    log: (l) => (log = l),
  });
  if (
    (log?.used && !log?.cacheHit) ||
    ['budget', 'breaker', 'unavailable', 'empty', 'error'].includes(log?.reason ?? '')
  )
    calls++;
  cost += log?.costMicroUsd ?? 0;
  if (V2 && !log?.used) {
    // 改写失败:该题记为失败,不降级为原问题检索
    failed++;
    per[HO.idLetter][0]++;
    out(`EVAL ${id} FAILED rewrite=${log?.reason ?? 'unknown'} hit5=0 top1=0 q="${q}"(未检索)`);
    continue;
  }
  const r = await hybridSearch({
    repoId: 1,
    commitSha: SHA,
    question: q,
    rewritten,
    chunks: rows,
    embeddingStatus: 'ready',
    embedder: emb,
    vectorStore: vs,
    limit: 5,
  });
  const base = (await vs.search(1, SHA, await emb.embedQuery(q), 5)).map((h) => byId.get(h.id));
  const bHit = base.some((h) => okHit(h, want, syms));
  const bFirst = base[0] ? okHit(base[0], want, syms) : false;
  const hit = r.hits.some((h) => okHit(h, want, syms));
  const first = r.hits[0] ? okHit(r.hits[0], want, syms) : false;
  if (V2) {
    const paths = r.hits.map((h) => h.path);
    const sc = scoreQuestion({
      rewriteUsed: true,
      retrieval: r.retrieval,
      paths,
      want,
      prefix: HO.prefix,
    });
    const j = { firstRank: sc.firstRank };
    const degraded = sc.failed;
    if (degraded) failed++;
    const ok5 = sc.hit5;
    const ok1 = sc.top1;
    const g = per[HO.idLetter];
    g[0]++;
    g[1] += ok5 ? 1 : 0;
    g[2] += ok1 ? 1 : 0;
    top5 += ok5 ? 1 : 0;
    top1 += ok1 ? 1 : 0;
    out(
      `EVAL ${id} hit5=${ok5 ? 1 : 0} top1=${ok1 ? 1 : 0} firstHitRank=${j.firstRank ?? '无'} retrieval=${r.retrieval}${degraded ? ` FAILED(降级:${r.degradedReason ?? '?'})` : ''} rewrite=${log.cacheHit ? 'cached' : 'used'} q="${q}" rw="${rewritten}"`,
    );
    out(`   want: ${want.join(' ; ')}`);
    for (const [i, h] of r.hits.entries())
      out(
        `   ${i + 1}. ${h.path}:${h.startLine}-${h.endLine} ${h.symbol ?? '-'} [${h.sources.join(',')}]${judge([h.path], want, HO.prefix).hit5 ? ' ✓' : ''}`,
      );
    continue;
  }
  const g = per[id[0]];
  g[0]++;
  g[1] += hit ? 1 : 0;
  g[2] += first ? 1 : 0;
  g[3] += bHit ? 1 : 0;
  g[4] += bFirst ? 1 : 0;
  top5 += hit ? 1 : 0;
  top1 += first ? 1 : 0;
  out(
    `EVAL ${id} hit5=${hit ? 1 : 0} top1=${first ? 1 : 0} vecOnly(原问题)hit5=${bHit ? 1 : 0} top1=${bFirst ? 1 : 0} retrieval=${r.retrieval} rewrite=${log?.used ? (log?.cacheHit ? 'cached' : 'used') : log?.reason} q="${q}" rw="${rewritten}"`,
  );
  for (const [i, h] of r.hits.entries())
    out(
      `   ${i + 1}. ${h.path}:${h.startLine}-${h.endLine} ${h.symbol ?? '-'} [${h.sources.join(',')}]`,
    );
}
for (const [k, [n, a, b, c, d]] of Object.entries(per))
  if (n)
    out(
      // v2 分支不累加仅向量基线栏,V 分组不打印该栏(避免输出非实测的 0)
      V2 && k === HO.idLetter
        ? `EVAL group ${k}: top5 ${a}/${n} top1 ${b}/${n}`
        : `EVAL group ${k}: top5 ${a}/${n} top1 ${b}/${n} | 仅向量(原问题,无改写)基线 top5 ${c}/${n} top1 ${d}/${n}`,
    );
if (V2)
  out(
    `EVAL ${HO.name} summary failed=${failed} main=${mainSha} ${HO.repo}=${SHA} chunks=${chunks.length} digest=${digest} llm=${cfg.provider}/${cfg.chatModel}`,
  );
out(
  `EVAL ${setName} total top5=${top5}/${SETS[setName].length} top1=${top1}/${SETS[setName].length} chunks=${chunks.length} llm=${fake ? 'fake(改写未运行)' : 'deepseek'} rewriteCalls=${calls} costMicroUsd=${cost} prompt=${REWRITE_PROMPT_VERSION} chunker=${V.chunker} embedText=${V.embedText} revision=${revision}`,
);
