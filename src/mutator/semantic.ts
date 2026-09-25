/**
 * Phase A: LLM Semantic Mutation Generator.
 *
 * Augments the static mutation rules with context-aware, business-logic
 * payloads that only an LLM can produce by understanding the endpoint's
 * purpose from its schema, operationId, and field names.
 *
 * Design principles:
 *  - Structured output only: LLM must return JSON conforming to
 *    SemanticMutationResponse. Free text never enters the fuzzing pipeline.
 *  - Graceful degradation: any LLM failure returns [] — static rules
 *    always cover the baseline regardless.
 *  - One LLM call per endpoint (not per field) to minimise token cost.
 *  - Capped at MAX_MUTATIONS_PER_ENDPOINT to prevent runaway API usage.
 *  - The prompt explicitly tells the LLM which categories static rules
 *    already cover, so it focuses on semantic gaps.
 */

import type {
  ParsedEndpoint,
  SemanticMutation,
  SemanticMutationResponse,
} from '../types/index.js';
import { detectLLMProvider, type LLMConfig } from '../reporter/llm.js';

const MAX_MUTATIONS_PER_ENDPOINT = 10;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate semantic mutations for a single endpoint via LLM.
 *
 * Returns an empty array on any error — callers must always
 * treat this as a best-effort augmentation, not a hard dependency.
 */
export async function generateSemanticMutations(
  endpoint: ParsedEndpoint,
  llmConfig?: LLMConfig,
): Promise<SemanticMutation[]> {
  const config = llmConfig ?? detectLLMProvider();
  if (!config) return [];

  const prompt = buildSemanticPrompt(endpoint);

  try {
    let raw: string;

    if (config.provider === 'openai') {
      raw = await callOpenAIStructured(prompt, config);
    } else {
      raw = await callAnthropicStructured(prompt, config);
    }

    return parseAndValidate(raw, endpoint);
  } catch (err) {
    // Non-fatal — static rules still run
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[EdgeFuzz] LLM semantic mutations skipped for ${endpoint.method} ${endpoint.path}: ${msg}\n`);
    return [];
  }
}

/**
 * Generate semantic mutations for multiple endpoints in parallel.
 * Bounded to avoid overwhelming the LLM API rate limit.
 */
export async function generateSemanticMutationsBatch(
  endpoints: ParsedEndpoint[],
  llmConfig?: LLMConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, SemanticMutation[]>> {
  const config = llmConfig ?? detectLLMProvider();
  const result = new Map<string, SemanticMutation[]>();

  if (!config || endpoints.length === 0) return result;

  // Process in parallel batches of 5 to respect typical rate limits
  const BATCH_SIZE = 5;
  let done = 0;

  for (let i = 0; i < endpoints.length; i += BATCH_SIZE) {
    const batch = endpoints.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((ep) => generateSemanticMutations(ep, config)),
    );

    for (let j = 0; j < batch.length; j++) {
      const ep = batch[j]!;
      const key = `${ep.method}:${ep.path}`;
      result.set(key, batchResults[j] ?? []);
      done++;
      onProgress?.(done, endpoints.length);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildSemanticPrompt(endpoint: ParsedEndpoint): string {
  const { method, path, operationId, summary, parameters, requestBody } = endpoint;

  // Build a concise schema description the LLM can reason about
  const schemaDesc = requestBody
    ? describeSchema(requestBody.schema)
    : parameters.length > 0
      ? describeParameters(parameters)
      : '(no body or parameters)';

  const hasBody = !!requestBody;
  const hasQueryParams = parameters.some((p) => p.in === 'query');

  return `You are a security-focused API testing expert. Your job is to generate adversarial test payloads that expose unhandled crashes (HTTP 500 errors) in a REST API.

## Target Endpoint
Method: ${method}
Path: ${path}
${operationId ? `Operation: ${operationId}` : ''}
${summary ? `Summary: ${summary}` : ''}

## Schema
${schemaDesc}

## Already Covered by Static Rules (DO NOT repeat these categories)
The static fuzzer already tests:
- Integer max/min overflow, zero, negative one, float-where-int, NaN, Infinity
- Null values in all fields
- Empty strings, whitespace-only strings
- Missing required fields (each individually)
- Deeply nested objects, oversized payloads (~1MB)
- SQL injection fragments, NoSQL $operator injection
- Null bytes (\\x00), Unicode edge cases, path traversal
- Wrong Content-Type headers, empty body, array-instead-of-object

## Your Task
Generate up to ${MAX_MUTATIONS_PER_ENDPOINT} ADDITIONAL adversarial payloads that the static rules CANNOT produce because they require understanding the endpoint's BUSINESS DOMAIN.

Focus on:
1. **Domain-specific invalid values** — e.g. expired dates, invalid status transitions, IDs from wrong entity types
2. **Semantic contradictions** — e.g. a discount > 100%, quantity = 0 with rush_shipping = true
3. **Business rule violations** — e.g. a future birth_date, a negative price, a start_date after end_date
4. **Realistic but malformed values** — e.g. a GUID with one wrong character, a phone number with letters, a zip code with 6 digits
5. **Cross-field inconsistencies** — fields that are individually valid but logically contradictory together

## Response Format
Respond ONLY with a valid JSON object matching this exact schema. No markdown, no explanation outside the JSON:

{
  "mutations": [
    {
      "label": "Short description of what this tests (max 80 chars)",
      "reasoning": "Why this specific payload might cause a server crash (1-2 sentences)",
      ${hasBody ? '"body": { ...payload object... },' : ''}
      ${hasQueryParams ? '"queryParams": { "param": "value" }' : ''}
    }
  ]
}

Rules:
- Each mutation must be a complete, valid JSON object that can be sent as-is
- "label" must be unique and specific (not generic like "invalid input")
- ${hasBody ? 'Populate "body" with the mutated request body' : 'Since this endpoint has no body, use "queryParams" for param mutations'}
- Maximum ${MAX_MUTATIONS_PER_ENDPOINT} mutations
- If you cannot think of meaningful domain-specific cases beyond static rules, return fewer — quality over quantity`;
}

function describeSchema(schema: import('../types/index.js').JsonSchema, indent = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];

  if (schema.type) lines.push(`${pad}type: ${Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type}`);
  if (schema.format) lines.push(`${pad}format: ${schema.format}`);
  if (schema.enum) lines.push(`${pad}enum: [${schema.enum.map((v) => JSON.stringify(v)).join(', ')}]`);
  if (schema.minimum !== undefined) lines.push(`${pad}minimum: ${schema.minimum}`);
  if (schema.maximum !== undefined) lines.push(`${pad}maximum: ${schema.maximum}`);

  if (schema.properties) {
    lines.push(`${pad}properties:`);
    const required = schema.required ?? [];
    for (const [key, val] of Object.entries(schema.properties)) {
      const req = required.includes(key) ? ' (required)' : ' (optional)';
      lines.push(`${pad}  ${key}${req}:`);
      const nested = describeSchema(val, indent + 2);
      if (nested) lines.push(nested);
    }
  }

  if (schema.items) {
    lines.push(`${pad}items:`);
    lines.push(describeSchema(schema.items, indent + 1));
  }

  return lines.join('\n');
}

function describeParameters(params: import('../types/index.js').ParsedParameter[]): string {
  return params
    .map((p) => {
      const parts = [`${p.in} param "${p.name}"`, `type: ${p.schema.type ?? 'unknown'}`];
      if (p.schema.format) parts.push(`format: ${p.schema.format}`);
      if (p.required) parts.push('required');
      return parts.join(', ');
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// LLM provider calls — both use structured / JSON mode
// ---------------------------------------------------------------------------

async function callOpenAIStructured(prompt: string, config: LLMConfig): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: config.apiKey, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });

  const response = await client.chat.completions.create({
    model: config.model ?? 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are a security testing expert. Always respond with valid JSON only. Never include markdown code fences or any text outside the JSON object.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.7,       // Higher temp = more creative/diverse payloads
    max_tokens: 2048,
  });

  return response.choices[0]?.message?.content ?? '{"mutations":[]}';
}

async function callAnthropicStructured(prompt: string, config: LLMConfig): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.apiKey });

  // Anthropic doesn't have a native json_object mode in older models,
  // so we use a tool-call pattern to force structured output.
  const response = await client.messages.create({
    model: config.model ?? 'claude-3-5-haiku-20241022',
    max_tokens: 2048,
    tools: [
      {
        name: 'submit_mutations',
        description: 'Submit the list of adversarial mutations you generated',
        input_schema: {
          type: 'object' as const,
          properties: {
            mutations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  reasoning: { type: 'string' },
                  body: { type: 'object' },
                  queryParams: { type: 'object' },
                },
                required: ['label', 'reasoning'],
              },
            },
          },
          required: ['mutations'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_mutations' },
    messages: [{ role: 'user', content: prompt }],
  });

  // Extract the tool input as JSON
  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (toolUse && toolUse.type === 'tool_use') {
    return JSON.stringify(toolUse.input);
  }

  return '{"mutations":[]}';
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function parseAndValidate(raw: string, endpoint: ParsedEndpoint): SemanticMutation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(`[EdgeFuzz] LLM returned invalid JSON for ${endpoint.method} ${endpoint.path}\n`);
    return [];
  }

  if (!isSemanticMutationResponse(parsed)) {
    process.stderr.write(`[EdgeFuzz] LLM response missing "mutations" array for ${endpoint.method} ${endpoint.path}\n`);
    return [];
  }

  // Validate and sanitise each mutation — drop malformed ones
  const valid: SemanticMutation[] = [];
  for (const m of parsed.mutations) {
    if (typeof m.label !== 'string' || m.label.trim() === '') continue;
    if (typeof m.reasoning !== 'string') continue;

    const mutation: SemanticMutation = {
      label: m.label.trim().slice(0, 120), // cap label length
      reasoning: m.reasoning.trim().slice(0, 500),
    };

    // Validate body is a plain object if present
    if (m.body !== undefined) {
      if (typeof m.body === 'object' && m.body !== null && !Array.isArray(m.body)) {
        mutation.body = m.body as Record<string, unknown>;
      }
      // If body is not a plain object, skip body (don't drop the whole mutation)
    }

    // Validate queryParams is Record<string, string> if present
    if (m.queryParams !== undefined) {
      if (typeof m.queryParams === 'object' && m.queryParams !== null) {
        const qp: Record<string, string> = {};
        for (const [k, v] of Object.entries(m.queryParams)) {
          qp[k] = String(v);
        }
        mutation.queryParams = qp;
      }
    }

    valid.push(mutation);

    if (valid.length >= MAX_MUTATIONS_PER_ENDPOINT) break;
  }

  return valid;
}

function isSemanticMutationResponse(val: unknown): val is SemanticMutationResponse {
  return (
    typeof val === 'object' &&
    val !== null &&
    'mutations' in val &&
    Array.isArray((val as SemanticMutationResponse).mutations)
  );
}

// Re-export so callers don't need to import from two places
export { detectLLMProvider };
export type { LLMConfig };
