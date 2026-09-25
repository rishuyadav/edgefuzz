/**
 * Optional LLM fix suggestion layer.
 *
 * Activated only when OPENAI_API_KEY or ANTHROPIC_API_KEY is set.
 * Sends the crashing payload + endpoint schema + response body to the LLM
 * and streams back a concise root-cause analysis and fix recommendation.
 */

import type { CrashFinding, ParsedEndpoint } from '../types/index.js';

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

/**
 * Generate a fix suggestion for a crash finding using the configured LLM.
 * Returns the suggestion text, or null if the LLM call fails.
 *
 * Deliberately non-streaming to keep the interface simple — the TUI
 * will show a spinner while waiting.
 */
export async function generateFixSuggestion(
  crash: CrashFinding,
  config: LLMConfig,
): Promise<string | null> {
  const prompt = buildPrompt(crash);

  try {
    if (config.provider === 'openai') {
      return await callOpenAI(prompt, config);
    } else {
      return await callAnthropic(prompt, config);
    }
  } catch (err) {
    // LLM failures are non-fatal — just return null
    const message = err instanceof Error ? err.message : String(err);
    return `[LLM unavailable: ${message}]`;
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildPrompt(crash: CrashFinding): string {
  const endpoint = crash.endpoint;
  const endpointDesc = formatEndpoint(endpoint);

  const payloadStr = crash.triggeringPayload
    ? JSON.stringify(crash.triggeringPayload, null, 2)
    : '(no body)';

  const responseSnippet = crash.responseBody
    ? crash.responseBody.slice(0, 500)
    : '(empty response body)';

  const crashDesc = crash.timedOut
    ? 'The server timed out (possible hang or infinite loop).'
    : `The server returned HTTP ${crash.statusCode}.`;

  return `You are a senior backend engineer doing a code review.
An automated API fuzzer discovered an unhandled crash in a REST API endpoint.

ENDPOINT:
${endpointDesc}

MUTATION APPLIED:
${crash.mutationLabel} (category: ${crash.mutationCategory})

TRIGGERING PAYLOAD:
${payloadStr}

SERVER RESPONSE:
${crashDesc}
Response body (truncated to 500 chars):
${responseSnippet}

YOUR TASK:
1. In 1-2 sentences, identify the most likely root cause.
2. Provide a concise, language-agnostic fix recommendation (3-5 sentences max).
3. Show a pseudocode snippet (5-10 lines max) illustrating the fix pattern.

Be direct and specific. Do not repeat the crash details back to me.`;
}

function formatEndpoint(endpoint: ParsedEndpoint): string {
  const lines = [`${endpoint.method} ${endpoint.path}`];
  if (endpoint.summary) lines.push(`Summary: ${endpoint.summary}`);
  if (endpoint.requestBody) {
    lines.push(`Request body: ${endpoint.requestBody.contentType}`);
    lines.push(`Body schema: ${JSON.stringify(endpoint.requestBody.schema, null, 2)}`);
  }
  if (endpoint.parameters.length > 0) {
    const paramSummary = endpoint.parameters
      .map((p) => `  ${p.in} "${p.name}" (${p.schema.type ?? 'unknown'}, required=${p.required})`)
      .join('\n');
    lines.push(`Parameters:\n${paramSummary}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function callOpenAI(prompt: string, config: LLMConfig): Promise<string> {
  // Dynamic import to avoid loading the SDK when unused
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: config.apiKey, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });

  const response = await client.chat.completions.create({
    model: config.model ?? 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
    temperature: 0.2,
  });

  return response.choices[0]?.message?.content?.trim() ?? '[No response from OpenAI]';
}

async function callAnthropic(prompt: string, config: LLMConfig): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.apiKey });

  const response = await client.messages.create({
    model: config.model ?? 'claude-3-5-haiku-20241022',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = response.content[0];
  if (block?.type === 'text') return block.text.trim();
  return '[No response from Anthropic]';
}
