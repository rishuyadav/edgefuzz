/**
 * LLM provider detection and configuration.
 *
 * Activated only when OPENAI_API_KEY or ANTHROPIC_API_KEY is set (or a
 * custom EDGEFUZZ_LLM_BASE_URL proxy is configured).
 *
 * Currently used by Phase A (semantic mutation generation).
 */

export type LLMProvider = 'openai' | 'anthropic';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model?: string;
  /** Custom base URL — use for LiteLLM proxy, Ollama, or any OpenAI-compatible endpoint */
  baseUrl?: string;
}

/**
 * Detect which LLM provider is available from environment variables.
 * Optional overrides from CLI flags take precedence over auto-detection.
 */
export function detectLLMProvider(
  providerOverride?: LLMProvider,
  modelOverride?: string,
  baseUrlOverride?: string,
): LLMConfig | null {
  const modelEnv = process.env['EDGEFUZZ_LLM_MODEL'];
  // EDGEFUZZ_LLM_BASE_URL lets users point at LiteLLM, Ollama, or any OpenAI-compatible proxy
  const baseUrl = baseUrlOverride ?? process.env['EDGEFUZZ_LLM_BASE_URL'];

  // If provider is explicitly specified, require that provider's key
  if (providerOverride === 'openai') {
    const key = process.env['OPENAI_API_KEY'];
    if (!key) return null;
    return { provider: 'openai', apiKey: key, model: modelOverride ?? modelEnv ?? 'gpt-4o-mini', baseUrl };
  }
  if (providerOverride === 'anthropic') {
    const key = process.env['ANTHROPIC_API_KEY'];
    if (!key) return null;
    return { provider: 'anthropic', apiKey: key, model: modelOverride ?? modelEnv ?? 'claude-3-5-haiku-20241022', baseUrl };
  }

  // When a custom base URL is provided without an explicit provider, treat it as OpenAI-compatible.
  // This is the LiteLLM / Ollama path — the key might be a proxy token, not a real OAI key.
  if (baseUrl) {
    const key = process.env['OPENAI_API_KEY'] ?? 'placeholder';
    const model = modelOverride ?? modelEnv ?? 'gpt-4o-mini';
    return { provider: 'openai', apiKey: key, model, baseUrl };
  }

  // Auto-detect: OpenAI takes precedence over Anthropic
  const openaiKey = process.env['OPENAI_API_KEY'];
  if (openaiKey) {
    return { provider: 'openai', apiKey: openaiKey, model: modelOverride ?? modelEnv ?? 'gpt-4o-mini', baseUrl };
  }

  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey) {
    return { provider: 'anthropic', apiKey: anthropicKey, model: modelOverride ?? modelEnv ?? 'claude-3-5-haiku-20241022', baseUrl };
  }

  return null;
}
