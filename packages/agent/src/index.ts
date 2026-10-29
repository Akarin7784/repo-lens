export const PACKAGE_NAME = '@repolens/agent';
export * from './llm/types.js';
export * from './llm/pricing.js';
export { FakeLlm, estimateTokens } from './llm/fake.js';
export {
  LlmGateway,
  cacheHash,
  type LlmGatewayOptions,
  type LlmKv,
  type UsageSink,
} from './llm/gateway.js';
export {
  readLlmConfig,
  createLlmClient,
  LLM_PROVIDERS,
  DEEPSEEK_DEFAULT_MODEL,
  type LlmConfig,
  type LlmProvider,
} from './llm/config.js';
export { DeepSeekClient, LlmHttpError, DEEPSEEK_DEFAULT_BASE_URL } from './llm/deepseek.js';
export {
  BreakerClient,
  CircuitOpenError,
  BREAKER_FAILURES,
  BREAKER_OPEN_S,
  type BreakerKv,
} from './llm/breaker.js';
