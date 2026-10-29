/* global process, console */
// 手动冒烟:用真实 DeepSeek key 发一次极小请求,确认 key/模型/记账可用。CI 不跑。
// 用法:pnpm --filter @repolens/agent build && LLM_PROVIDER=deepseek node scripts/llm-smoke.mjs
// 只打印回复长度、usage 和折算费用;绝不打印 key(输出前也会把 key 从文本里抹掉)。
import {
  DEFAULT_PRICES,
  costMicroUsd,
  createLlmClient,
  priceOf,
  readLlmConfig,
} from '../packages/agent/dist/index.js';

const key = process.env.DEEPSEEK_API_KEY?.trim() ?? '';
const scrub = (s) => (key ? String(s).split(key).join('***') : String(s));
const out = (s) => console.log(scrub(s));

try {
  const env = { ...process.env, LLM_PROVIDER: process.env.LLM_PROVIDER ?? 'deepseek' };
  const cfg = readLlmConfig(env);
  if (cfg.provider !== 'deepseek') throw new Error('需要 LLM_PROVIDER=deepseek');
  const client = createLlmClient(cfg, { env });
  const model = cfg.summaryModel;
  const t0 = Date.now();
  const r = await client.call({
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    maxTokens: 16,
    temperature: 0,
  });
  const cost = costMicroUsd(
    priceOf(DEFAULT_PRICES, model),
    r.usage.tokensIn,
    r.usage.tokensOut,
    r.usage.cachedTokensIn ?? 0,
  );
  out(
    `LLM-SMOKE ok model=${model} ms=${Date.now() - t0} replyChars=${r.text.length} ` +
      `tokensIn=${r.usage.tokensIn} cachedIn=${r.usage.cachedTokensIn ?? 0} tokensOut=${r.usage.tokensOut} ` +
      `cost=${cost}µUSD ($${(cost / 1e6).toFixed(6)}, 按高峰价)`,
  );
} catch (e) {
  out(`LLM-SMOKE fail ${e?.name ?? 'Error'}: ${e?.message ?? e}`);
  process.exitCode = 1;
}
