/**
 * Stage 4: Crash Deduplication & Classification.
 *
 * Rules:
 *  - CRASH (flagged): 5xx response, server timeout, network error after connect
 *  - HANDLED (ignored): 4xx response — the server correctly rejected the input
 *  - Deduplication key: (method, path, mutationRuleFamily) — distinct payloads
 *    hitting the same code path for the same root cause count as one finding.
 */

import crypto from 'crypto';
import type {
  RequestResult,
  CrashFinding,
  CrashSeverity,
  MutationCategory,
} from '../types/index.js';
import { buildCurlReproducer } from '../reporter/curl.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse a completed request result and, if it represents an unhandled crash,
 * return a CrashFinding. Returns null if the response is expected / handled.
 */
export function analyseCrash(result: RequestResult): CrashFinding | null {
  if (!isCrash(result)) return null;

  const crashId = deduplicationKey(result);
  const severity = classifySeverity(result);

  return {
    id: crashId,
    severity,
    endpoint: result.request.endpoint,
    mutationId: result.request.mutationId,
    mutationLabel: result.request.mutationLabel,
    mutationCategory: result.request.mutationCategory,
    mutationSource: result.request.mutationSource,
    statusCode: result.statusCode,
    responseBody: result.responseBody,
    latencyMs: result.latencyMs,
    timedOut: result.timedOut,
    networkError: result.networkError,
    triggeringPayload: result.request.body ?? result.request.queryParams ?? null,
    curlReproducer: buildCurlReproducer(result.request),
  };
}

/**
 * Deduplicate a stream of findings by their id.
 * Keeps the first occurrence of each unique crash.
 */
export function deduplicateFindings(findings: CrashFinding[]): CrashFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Classification logic
// ---------------------------------------------------------------------------

/**
 * Determine whether a request result constitutes an unhandled crash.
 */
function isCrash(result: RequestResult): boolean {
  // Server-side error = unhandled crash
  if (result.statusCode >= 500 && result.statusCode < 600) return true;

  // Server hang / timeout — only flag if we connected but got no response
  // Pure connection refused is not a crash of the app under test
  if (result.timedOut) return true;

  // Network errors that indicate the server crashed / restarted mid-request
  if (result.networkError && result.networkErrorMessage) {
    const msg = result.networkErrorMessage.toLowerCase();
    const isConnectionRefused =
      msg.includes('econnrefused') || msg.includes('connection refused');
    if (!isConnectionRefused) return true;
  }

  // 4xx — correctly handled input, not a crash
  return false;
}

function classifySeverity(result: RequestResult): CrashSeverity {
  // Server completely hung / crashed = critical
  if (result.timedOut || result.networkError) return 'critical';

  // 500 from an encoding/security mutation = high (potential injection surface)
  if (
    result.statusCode === 500 &&
    isSecurityCategory(result.request.mutationCategory)
  ) {
    return 'high';
  }

  // 500 from structural/type mutations = medium (logic error, not security)
  if (result.statusCode === 500) return 'medium';

  // 502 / 503 / 504 — gateway/downstream issues, lower confidence
  return 'medium';
}

function isSecurityCategory(category: MutationCategory): boolean {
  return category === 'encoding' || category === 'security';
}

/**
 * Build a stable deduplication key.
 *
 * Two crashes are considered the same root cause if they share:
 *  - The same HTTP method + path
 *  - The same mutation "family" (strip the field-specific suffix)
 *
 * This prevents 50 reports for the same underlying bug triggered by
 * 50 different field names in the same payload.
 */
function deduplicationKey(result: RequestResult): string {
  const { endpoint, mutationId } = result.request;
  const statusBucket = result.timedOut ? 'timeout' : String(result.statusCode);

  // Extract the mutation family: "body-field-fieldName-int-max-plus-one"
  // → family = "int-max-plus-one" (last hyphen-separated rule id segment)
  const mutationFamily = extractMutationFamily(mutationId);

  const raw = `${endpoint.method}:${endpoint.path}:${mutationFamily}:${statusBucket}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

/**
 * Strip the field-specific prefix from a mutationId to get the rule family.
 *
 * Examples:
 *  "body-field-userId-int-max-plus-one"  → "int-max-plus-one"
 *  "struct-empty-body"                   → "struct-empty-body"
 *  "query-page-int-zero"                 → "int-zero"
 *  "enc-null-byte"                       → "enc-null-byte"
 */
function extractMutationFamily(mutationId: string): string {
  // Known prefixes that contain field names we want to strip
  const fieldPrefixPatterns = [
    /^body-field-[^-]+-(.+)$/,
    /^query-[^-]+-(.+)$/,
    /^path-[^-]+-(.+)$/,
    /^header-[^-]+-(.+)$/,
    /^body-enc-[^-]+-(.+)$/,
  ];

  for (const pattern of fieldPrefixPatterns) {
    const match = mutationId.match(pattern);
    if (match?.[1]) return match[1];
  }

  return mutationId;
}
