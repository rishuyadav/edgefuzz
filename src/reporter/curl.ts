/**
 * Curl reproducer generator.
 *
 * Produces a ready-to-run `curl` command that faithfully reproduces
 * the exact request that triggered a crash.
 */

import type { MutatedRequest } from '../types/index.js';

const RAW_JSON_PREFIX = '__RAW_JSON__:';

/**
 * Header names that carry credentials and must be redacted in shared output.
 * Matching is case-insensitive.
 */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-auth-token',
  'api-key',
  'token',
  'cookie',
]);

/**
 * Redact a header value if the header name is known to carry credentials.
 * Preserves the scheme prefix (e.g. "Bearer ") so the reproducer remains
 * runnable after the user substitutes their real token.
 *
 * Example:
 *   "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *   → "Bearer <REDACTED>"
 */
function redactHeaderValue(name: string, value: string): string {
  if (!SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) return value;
  // Preserve scheme prefix (Bearer, Basic, Token, etc.) for clarity
  const spaceIdx = value.indexOf(' ');
  if (spaceIdx !== -1) {
    const scheme = value.slice(0, spaceIdx);
    return `${scheme} <REDACTED>`;
  }
  return '<REDACTED>';
}

/**
 * Build a shell-safe `curl` command for a MutatedRequest.
 *
 * Sensitive header values (Authorization, X-Api-Key, etc.) are redacted
 * so the reproducer is safe to share in bug reports and CI logs.
 * The user should substitute their own credentials before running it.
 */
export function buildCurlReproducer(req: MutatedRequest): string {
  const parts: string[] = ['curl', '-i', '-X', req.method];

  // Headers
  for (const [key, value] of Object.entries(req.headers)) {
    // Skip Content-Length — curl computes it automatically
    if (key.toLowerCase() === 'content-length') continue;
    const safeValue = redactHeaderValue(key, value);
    parts.push(`-H ${shellQuote(`${key}: ${safeValue}`)}`);
  }

  // Body
  if (req.body !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const bodyStr = serializeBody(req);
    if (bodyStr !== null) {
      parts.push(`-d ${shellQuote(bodyStr)}`);
    }
  }

  // URL
  parts.push(shellQuote(req.url));

  return parts.join(' \\\n  ');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeBody(req: MutatedRequest): string | null {
  if (req.body === undefined) return null;
  if (req.body === null) return 'null';

  // Raw JSON passthrough
  if (typeof req.body === 'string' && req.body.startsWith(RAW_JSON_PREFIX)) {
    return req.body.slice(RAW_JSON_PREFIX.length);
  }

  // Wrong content-type mutations (body is already a plain string)
  const ct = req.headers['Content-Type'] ?? '';
  if (typeof req.body === 'string' && ct !== 'application/json') {
    return req.body;
  }

  // Standard JSON serialization
  try {
    return JSON.stringify(req.body, (_key, val) => {
      if (typeof val === 'number' && (!isFinite(val) || isNaN(val))) return null;
      return val;
    });
  } catch {
    return String(req.body);
  }
}

/**
 * Shell-quote a string using single quotes.
 * Escapes embedded single quotes by ending the quote, inserting a literal ', re-opening.
 */
function shellQuote(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
