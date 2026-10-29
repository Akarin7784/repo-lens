/* global process, console */
// T-214 检索评测(手动,CI 不跑):hono @ ed1d5f7,真实 ONNX(e5-small fp32,本地模型目录,不联网)+ 内存向量库 + 查询改写。
// 用法:pnpm build && node scripts/rag-eval.mjs <tuning|holdout|s1> [--fake-llm]
//   HONO_DIR(默认 /tmp/hono)  EMBEDDING_MODEL_DIR(必填,含 Xenova/multilingual-e5-small)
//   改写:有 DEEPSEEK_API_KEY 且未加 --fake-llm 时走真实 DeepSeek;否则 FakeLlm(结果须标「改写未运行」)。
// 只打印题目、命中与 usage;绝不打印 key(输出前抹掉)。向量缓存在 /tmp/rl-eval-vectors.json(只含公开仓库切块向量)。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { analyzeRepo, scanSourceFiles } from '../packages/analyzer/dist/index.js';
import {
  OnnxEmbedder,
  MemoryVectorStore,
  buildChunks,
  hybridSearch,
  indexChunks,
  pointId,
} from '../packages/rag/dist/index.js';
import {
  DEFAULT_PRICES,
  FakeLlm,
  LlmGateway,
  MemoryLlmKv,
  createLlmClient,
  readLlmConfig,
  rewriteQuery,
} from '../packages/agent/dist/index.js';
import { MemoryStore } from '../packages/db/dist/index.js';

const SHA = 'ed1d5f72135ccf7e09c17d64dc4af7588dd3e491';
const key = process.env.DEEPSEEK_API_KEY?.trim() ?? '';
const scrub = (s) => (key ? String(s).split(key).join('***') : String(s));
const out = (s) => console.log(scrub(s));

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
const fake = process.argv.includes('--fake-llm') || !key;
if (!SETS[setName]) throw new Error('用法: rag-eval.mjs <tuning|holdout|s1> [--fake-llm]');
const root = process.env.HONO_DIR ?? '/tmp/hono';
const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
if (head !== SHA) throw new Error(`hono HEAD ${head} != ${SHA}`);
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
const emb = new OnnxEmbedder('Xenova/multilingual-e5-small', modelDir);
const vs = new MemoryVectorStore();
const cache = '/tmp/rl-eval-vectors.json';
if (existsSync(cache) && JSON.parse(readFileSync(cache, 'utf8')).n === chunks.length) {
  for (const p of JSON.parse(readFileSync(cache, 'utf8')).points) vs.points.set(p.id, p);
} else {
  const t0 = Date.now();
  await indexChunks({ repoId: 1, commitSha: SHA, chunks, batchSize: 16 }, emb, vs);
  writeFileSync(cache, JSON.stringify({ n: chunks.length, points: [...vs.points.values()] }));
  out(`EVAL embedded ${chunks.length} chunks in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

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

const okFile = (path, want) =>
  want.some((w) => (w.endsWith('/') ? path.startsWith(w) : path === w));
const fileLevel = setName === 'tuning'; // 调参题只给「参考」位置,按文件判定
const okHit = (h, want, syms) =>
  okFile(h.path, want) && (fileLevel || !syms || h.symbol === null || syms.includes(h.symbol));
let top5 = 0;
let top1 = 0;
let calls = 0;
let cost = 0;
const byId = new Map(rows.map((c) => [c.qdrantPointId, c]));
const per = { 中: [0, 0, 0, 0, 0], 英: [0, 0, 0, 0, 0], H: [0, 0, 0, 0, 0], S: [0, 0, 0, 0, 0] };
for (const [id, q, want, syms] of SETS[setName]) {
  let log;
  const rewritten = await rewriteQuery(q, { gateway, model: cfg.chatModel, log: (l) => (log = l) });
  if (
    log?.used ||
    ['budget', 'breaker', 'unavailable', 'empty', 'error'].includes(log?.reason ?? '')
  )
    calls++;
  cost += log?.costMicroUsd ?? 0;
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
  const g = per[id[0]];
  g[0]++;
  g[1] += hit ? 1 : 0;
  g[2] += first ? 1 : 0;
  g[3] += bHit ? 1 : 0;
  g[4] += bFirst ? 1 : 0;
  top5 += hit ? 1 : 0;
  top1 += first ? 1 : 0;
  out(
    `EVAL ${id} hit5=${hit ? 1 : 0} top1=${first ? 1 : 0} vecOnly(原问题)hit5=${bHit ? 1 : 0} top1=${bFirst ? 1 : 0} retrieval=${r.retrieval} rewrite=${log?.used ? 'used' : log?.reason} q="${q}" rw="${rewritten}"`,
  );
  for (const [i, h] of r.hits.entries())
    out(
      `   ${i + 1}. ${h.path}:${h.startLine}-${h.endLine} ${h.symbol ?? '-'} [${h.sources.join(',')}]`,
    );
}
for (const [k, [n, a, b, c, d]] of Object.entries(per))
  if (n)
    out(
      `EVAL group ${k}: top5 ${a}/${n} top1 ${b}/${n} | 仅向量(原问题,无改写)基线 top5 ${c}/${n} top1 ${d}/${n}`,
    );
out(
  `EVAL ${setName} total top5=${top5}/${SETS[setName].length} top1=${top1}/${SETS[setName].length} chunks=${chunks.length} llm=${fake ? 'fake(改写未运行)' : 'deepseek'} rewriteCalls=${calls} costMicroUsd=${cost} prompt=rw-1`,
);
