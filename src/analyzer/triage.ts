/**
 * Phase C: LLM Crash Triage.
 *
 * After fuzzing completes, passes all deduplicated crashes to the LLM
 * in a single structured call. The LLM reads each crash's response body
 * (which may contain stack traces, error messages, or ORM errors) and returns:
 *
 *  - rootCause:        canonical enum label (never free text in logic)
 *  - confidence:       0.0–1.0 score
 *  - notes:            1-2 sentence plain-English explanation
 *  - duplicateOf?:     id of another crash with the same root cause
 *  - severityOverride? upgrade/downgrade from static classifier's severity
 *
 * Design principles:
 *  - One batched LLM call for all crashes (not N calls) → minimal latency + cost
 *  - Structured output enforced via JSON mode (OpenAI) or tool_use (Anthropic)
 *  - Mutations are applied in-place on CrashFinding objects (no new allocations)
 *  - Degrades gracefully: triage failure leaves findings unchanged
 *  - The LLM sees all crashes together so it can identify cross-crash duplicates
 */

import type {
  CrashFinding,
  CrashTriageResult,
  CrashRootCause,
  CrashSeverity,
} from '../types/index.js';
import type { LLMConfig } from '../reporter/llm.js';

// Closed set of valid root cause labels — must match CrashRootCause union type
const VALID_ROOT_CAUSES = new Set<string>([
  'integer-overflow', 'null-pointer', 'type-coercion', 'unhandled-exception',
  'sql-error', 'nosql-error', 'encoding-error', 'validation-missing',
  'timeout-hang', 'memory-error', 'auth-bypass', 'path-traversal',
  'injection', 'schema-mismatch', 'unknown',
]);

const VALID_SEVERITIES = new Set<string>(['critical', 'high', 'medium', 'low']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Triage all crashes via LLM. Mutates each CrashFinding in-place
 * with rootCause, confidence, triageNotes, duplicateOf, and llmSeverity.
 *
 * Safe to call with any number of crashes — batches large sets automatically.
 * Returns without modifying findings if LLM call fails.
 */
export async function triageCrashes(
  crashes: CrashFinding[],
  config: LLMConfig,
): Promise<void> {
  if (crashes.length === 0) return;

  // Batch into groups of 20 max (LLM context window consideration)
  const BATCH_SIZE = 20;
  for (let i = 0; i < crashes.length; i += BATCH_SIZE) {
    const batch = crashes.slice(i, i + BATCH_SIZE);
    await triageBatch(batch, config);
  }
}

// ---------------------------------------------------------------------------
// Batch triage
// ---------------------------------------------------------------------------

async function triageBatch(crashes: CrashFinding[], config: LLMConfig): Promise<void> {
  const prompt = buildTriagePrompt(crashes);

  try {
    let raw: string;
    if (config.provider === 'openai') {
      raw = await callOpenAITriage(prompt, config);
    } else {
      raw = await callAnthropicTriage(prompt, config);
    }

    const results = parseTriageResponse(raw, crashes);
    applyTriageResults(crashes, results);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[EdgeFuzz] LLM triage failed, using static classification: ${msg}\n`);
    // Crashes remain with their static classification — no change
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildTriagePrompt(crashes: CrashFinding[]): string {
  const crashDescriptions = crashes
    .map((crash, i) => formatCrashForTriage(crash, i))
    .join('\n\n---\n\n');

  const rootCauseList = Array.from(VALID_ROOT_CAUSES).join(' | ');

  return `You are a senior backend security engineer performing automated crash triage.
You will receive a list of HTTP 500 crashes discovered by a fuzzer. For each crash, analyze the available evidence and classify it.

## Crashes to Triage

${crashDescriptions}

## Your Task

For EACH crash, return a triage result with these fields:

- crashId: the exact crash ID provided (string, required)
- rootCause: ONE of these exact values — ${rootCauseList}
- confidence: float 0.0–1.0 representing how certain you are this is a real bug
  (0.0–0.3: likely environment artifact or false positive; 0.4–0.7: plausible but uncertain; 0.8–1.0: clear bug)
- notes: 1-2 sentences explaining what likely caused this crash (be specific about the code path)
- duplicateOf: (optional) the crashId of another crash in this list that has the SAME root cause at the code level
  Only set this if you are highly confident (>0.8) they share the same underlying bug.
  The first occurrence of a root cause is the canonical one (do not set duplicateOf on it).
- severityOverride: (optional) override the static severity if you see clear evidence to upgrade or downgrade.
  Use ONLY: "critical" | "high" | "medium" | "low"
  Only override when the response body reveals something the static rules couldn't know
  (e.g., a stack trace showing an SQL error → upgrade to "high"; a generic 500 with no stack trace → may downgrade)

## Root Cause Reference
- integer-overflow: arithmetic overflow/underflow crashed the server
- null-pointer: null/None/nil dereference on a non-nullable field
- type-coercion: wrong type caused an unexpected cast or parse error
- unhandled-exception: a generic unhandled exception (no more specific cause visible)
- sql-error: SQL syntax error, constraint violation, or ORM error
- nosql-error: MongoDB/Redis/DynamoDB operation error
- encoding-error: Unicode decode error, UTF-8 parsing failure, null byte
- validation-missing: server didn't validate input before using it
- timeout-hang: server stopped responding (infinite loop, deadlock, slow query)
- memory-error: out-of-memory or stack overflow
- auth-bypass: the crash reveals a possible authentication or authorization bypass
- path-traversal: file system path traversal attempt revealed a crash
- injection: template injection, command injection, or similar
- schema-mismatch: payload structure caused a deserialization or schema validation crash
- unknown: cannot determine root cause from available evidence

## Response Format
Respond with ONLY a valid JSON object. No markdown, no explanation outside the JSON:

{
  "triageResults": [
    {
      "crashId": "...",
      "rootCause": "...",
      "confidence": 0.0,
      "notes": "...",
      "duplicateOf": "...",
      "severityOverride": "..."
    }
  ]
}

Important:
- Return exactly one result per crash ID provided
- Use the EXACT crashId values from the input — do not modify them
- "duplicateOf" and "severityOverride" are optional — omit them when not applicable
- confidence must be a number between 0.0 and 1.0`;
}

function formatCrashForTriage(crash: CrashFinding, index: number): string {
  const lines: string[] = [
    `### Crash ${index + 1}`,
    `crashId: ${crash.id}`,
    `Endpoint: ${crash.endpoint.method} ${crash.endpoint.path}`,
    `Status: ${crash.timedOut ? 'TIMEOUT' : `HTTP ${crash.statusCode}`}`,
    `Mutation: ${crash.mutationLabel} (category: ${crash.mutationCategory}, source: ${crash.mutationSource})`,
    `Static severity: ${crash.severity}`,
    `Latency: ${crash.latencyMs}ms`,
  ];

  if (crash.triggeringPayload !== null) {
    const payloadStr = JSON.stringify(crash.triggeringPayload, null, 2);
    // Truncate very large payloads (e.g. 1MB body)
    lines.push(`Payload: ${payloadStr.length > 500 ? payloadStr.slice(0, 500) + '... [truncated]' : payloadStr}`);
  }

  if (crash.responseBody) {
    // Response body is the most valuable signal — give it more space
    const body = crash.responseBody.slice(0, 1000);
    lines.push(`Response body:\n${body}${crash.responseBody.length > 1000 ? '\n... [truncated]' : ''}`);
  } else {
    lines.push('Response body: (empty)');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LLM provider calls
// ---------------------------------------------------------------------------

async function callOpenAITriage(prompt: string, config: LLMConfig): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: config.apiKey });

  const response = await client.chat.completions.create({
    model: config.model ?? 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are a security-focused crash analysis engine. Always respond with valid JSON only. Never include markdown, code fences, or any text outside the JSON object.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,   // Low temperature — triage needs consistent, deterministic output
    max_tokens: 4096,
  });

  return response.choices[0]?.message?.content ?? '{"triageResults":[]}';
}

async function callAnthropicTriage(prompt: string, config: LLMConfig): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.apiKey });

  const response = await client.messages.create({
    model: config.model ?? 'claude-3-5-haiku-20241022',
    max_tokens: 4096,
    tools: [
      {
        name: 'submit_triage',
        description: 'Submit the triage results for all crashes',
        input_schema: {
          type: 'object' as const,
          properties: {
            triageResults: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  crashId: { type: 'string' },
                  rootCause: { type: 'string' },
                  confidence: { type: 'number' },
                  notes: { type: 'string' },
                  duplicateOf: { type: 'string' },
                  severityOverride: { type: 'string' },
                },
                required: ['crashId', 'rootCause', 'confidence', 'notes'],
              },
            },
          },
          required: ['triageResults'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_triage' },
    messages: [{ role: 'user', content: prompt }],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (toolUse && toolUse.type === 'tool_use') {
    return JSON.stringify(toolUse.input);
  }
  return '{"triageResults":[]}';
}

// ---------------------------------------------------------------------------
// Response parsing and validation
// ---------------------------------------------------------------------------

interface RawTriageResponse {
  triageResults?: unknown[];
}

interface RawTriageResult {
  crashId?: unknown;
  rootCause?: unknown;
  confidence?: unknown;
  notes?: unknown;
  duplicateOf?: unknown;
  severityOverride?: unknown;
}

function parseTriageResponse(raw: string, crashes: CrashFinding[]): CrashTriageResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write('[EdgeFuzz] Triage: LLM returned invalid JSON\n');
    return [];
  }

  const response = parsed as RawTriageResponse;
  if (!Array.isArray(response.triageResults)) {
    process.stderr.write('[EdgeFuzz] Triage: LLM response missing "triageResults" array\n');
    return [];
  }

  // Build a set of valid crash IDs for validation
  const validIds = new Set(crashes.map((c) => c.id));

  const results: CrashTriageResult[] = [];

  for (const raw of response.triageResults) {
    const r = raw as RawTriageResult;

    // Validate crashId
    if (typeof r.crashId !== 'string' || !validIds.has(r.crashId)) continue;

    // Validate rootCause (must be in our closed enum)
    const rootCause = typeof r.rootCause === 'string' && VALID_ROOT_CAUSES.has(r.rootCause)
      ? (r.rootCause as CrashRootCause)
      : 'unknown' as CrashRootCause;

    // Validate confidence (clamp to 0–1)
    const rawConf = typeof r.confidence === 'number' ? r.confidence : 0.5;
    const confidence = Math.max(0, Math.min(1, rawConf));

    // Validate notes
    const notes = typeof r.notes === 'string'
      ? r.notes.trim().slice(0, 600)
      : 'No analysis available.';

    // Validate optional duplicateOf
    const duplicateOf =
      typeof r.duplicateOf === 'string' && validIds.has(r.duplicateOf) && r.duplicateOf !== r.crashId
        ? r.duplicateOf
        : undefined;

    // Validate optional severityOverride
    const severityOverride =
      typeof r.severityOverride === 'string' && VALID_SEVERITIES.has(r.severityOverride)
        ? (r.severityOverride as CrashSeverity)
        : undefined;

    results.push({
      crashId: r.crashId,
      rootCause,
      confidence,
      notes,
      duplicateOf,
      severityOverride,
    });
  }

  return results;
}

/**
 * Apply validated triage results back to CrashFinding objects in-place.
 */
function applyTriageResults(crashes: CrashFinding[], results: CrashTriageResult[]): void {
  const resultMap = new Map(results.map((r) => [r.crashId, r]));

  for (const crash of crashes) {
    const triage = resultMap.get(crash.id);
    if (!triage) continue;

    crash.rootCause = triage.rootCause;
    crash.confidence = triage.confidence;
    crash.triageNotes = triage.notes;

    if (triage.duplicateOf) crash.duplicateOf = triage.duplicateOf;
    if (triage.severityOverride) crash.llmSeverity = triage.severityOverride;
  }
}
