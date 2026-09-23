/**
 * Stage 3: Concurrent HTTP Execution Harness.
 *
 * Uses undici (Node's native HTTP client) for high-throughput request execution
 * and p-limit for concurrency control. Emits progress events for the TUI.
 */

import { request as undiciRequest } from 'undici';
import pLimit from 'p-limit';
import type { MutatedRequest, RequestResult } from '../types/index.js';

const RAW_JSON_PREFIX = '__RAW_JSON__:';

export interface ExecutorOptions {
  concurrency: number;
  timeoutMs: number;
  onResult: (result: RequestResult) => void;
}

/**
 * Execute all mutated requests concurrently.
 *
 * @param requests - Flat list of adversarial requests to send.
 * @param options  - Concurrency limit, timeout, and result callback.
 * @returns        - All results in completion order (not input order).
 */
export async function executeRequests(
  requests: MutatedRequest[],
  options: ExecutorOptions,
): Promise<RequestResult[]> {
  const { concurrency, timeoutMs, onResult } = options;
  const limit = pLimit(concurrency);
  const results: RequestResult[] = [];

  const tasks = requests.map((req) =>
    limit(async () => {
      const result = await executeOne(req, timeoutMs);
      results.push(result);
      onResult(result);
      return result;
    }),
  );

  await Promise.all(tasks);
  return results;
}

// ---------------------------------------------------------------------------
// Single request execution
// ---------------------------------------------------------------------------

async function executeOne(req: MutatedRequest, timeoutMs: number): Promise<RequestResult> {
  const startTime = Date.now();

  try {
    const { bodyStr, headers } = prepareBody(req);

    // undici v7: request() does NOT throw on non-2xx by default.
    // Do NOT pass throwOnError — it was removed in v7 and causes UND_ERR_INVALID_ARG.
    const response = await undiciRequest(req.url, {
      method: req.method,
      headers,
      body: bodyStr ?? undefined,
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
    });

    const latencyMs = Date.now() - startTime;
    const responseBody = await readResponseBody(response);

    return {
      request: req,
      statusCode: response.statusCode,
      responseBody,
      latencyMs,
      timedOut: false,
      networkError: false,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errCode = (err instanceof Error && 'code' in err)
      ? String((err as NodeJS.ErrnoException).code ?? '')
      : '';

    // Use error codes (stable across undici versions) rather than message strings.
    // undici v7 timeout codes: UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT, UND_ERR_CONNECT_TIMEOUT
    // Node.js network timeout: ETIMEDOUT
    const TIMEOUT_CODES = new Set([
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'ETIMEDOUT',
    ]);
    const isTimeout = TIMEOUT_CODES.has(errCode);

    return {
      request: req,
      statusCode: 0,
      responseBody: '',
      latencyMs,
      timedOut: isTimeout,
      networkError: true,
      networkErrorMessage: err instanceof Error ? err.message : String(err),
      networkErrorCode: errCode || undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Body preparation
// ---------------------------------------------------------------------------

interface PreparedBody {
  bodyStr: string | null;
  headers: Record<string, string>;
}

function prepareBody(req: MutatedRequest): PreparedBody {
  const headers = { ...req.headers };

  // No body for these methods
  if (['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method) && !req.body) {
    // Remove Content-Type for bodyless requests
    delete headers['Content-Type'];
    return { bodyStr: null, headers };
  }

  if (req.body === undefined || req.body === null) {
    // Explicitly null body — send as JSON "null"
    if (req.body === null) {
      return { bodyStr: 'null', headers };
    }
    delete headers['Content-Type'];
    return { bodyStr: null, headers };
  }

  // Raw JSON string passthrough (structural mutation with pre-formed JSON)
  if (typeof req.body === 'string' && req.body.startsWith(RAW_JSON_PREFIX)) {
    const rawJson = req.body.slice(RAW_JSON_PREFIX.length);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(rawJson));
    return { bodyStr: rawJson, headers };
  }

  // Wrong content-type mutations (already stringified by mutator)
  if (
    typeof req.body === 'string' &&
    headers['Content-Type'] &&
    headers['Content-Type'] !== 'application/json'
  ) {
    const bodyStr = req.body;
    headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    return { bodyStr, headers };
  }

  // Standard: serialize to JSON (handles Infinity/NaN by converting to null)
  let bodyStr: string;
  try {
    bodyStr = stableStringify(req.body);
  } catch {
    bodyStr = JSON.stringify(req.body) ?? 'null';
  }

  headers['Content-Type'] = 'application/json';
  headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
  return { bodyStr, headers };
}

/**
 * Stable JSON serializer that handles Infinity and NaN
 * by converting them to `null` (mirrors what most JSON parsers expect).
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'number') {
      if (!isFinite(val) || isNaN(val)) return null;
    }
    return val;
  }) ?? 'null';
}

// ---------------------------------------------------------------------------
// Response body reading
// ---------------------------------------------------------------------------

async function readResponseBody(
  response: Awaited<ReturnType<typeof undiciRequest>>,
): Promise<string> {
  try {
    // Limit response body to 64KB to avoid memory issues with large error pages
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_BYTES = 65_536; // 64 KB

    for await (const chunk of response.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
      totalBytes += buf.length;
      if (totalBytes > MAX_BYTES) {
        chunks.push(buf.slice(0, MAX_BYTES - (totalBytes - buf.length)));
        break;
      }
      chunks.push(buf);
    }

    return Buffer.concat(chunks).toString('utf-8');
  } catch {
    return '';
  }
}
