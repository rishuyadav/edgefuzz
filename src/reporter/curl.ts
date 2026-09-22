/**
 * Curl reproducer generator.
 *
 * Produces a ready-to-run `curl` command that faithfully reproduces
 * the exact request that triggered a crash.
 */

import type { MutatedRequest } from '../types/index.js';

const RAW_JSON_PREFIX = '__RAW_JSON__:';

/**
 * Build a shell-safe `curl` command for a MutatedRequest.
 */
export function buildCurlReproducer(req: MutatedRequest): string {
  const parts: string[] = ['curl', '-i', '-X', req.method];

  // Headers
  for (const [key, value] of Object.entries(req.headers)) {
    // Skip Content-Length — curl computes it automatically
    if (key.toLowerCase() === 'content-length') continue;
    parts.push(`-H ${shellQuote(`${key}: ${value}`)}`);
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
