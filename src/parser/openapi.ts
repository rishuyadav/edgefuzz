/**
 * Stage 1: OpenAPI 3.x parser with auto-discovery.
 *
 * Responsibilities:
 *  - Load an OpenAPI 3.x spec from a URL, file path, or auto-discovered localhost endpoint.
 *  - Fully dereference $ref chains via swagger-parser.
 *  - Normalize every endpoint + parameter into our internal ParsedSpec type.
 */

import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
// swagger-parser v10 ships as CommonJS with a default export that is the parser object itself
const SwaggerParser = _require('swagger-parser') as {
  dereference: (api: unknown) => Promise<unknown>;
  validate: (api: unknown) => Promise<unknown>;
  parse: (api: unknown) => Promise<unknown>;
};
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type {
  ParsedSpec,
  ParsedEndpoint,
  ParsedParameter,
  HttpMethod,
  JsonSchema,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Auto-discovery constants
// ---------------------------------------------------------------------------

const DISCOVERY_PORTS = [3000, 8000, 8080, 8081, 5000, 4000, 9000];
const DISCOVERY_PATHS = [
  '/openapi.json',
  '/openapi.yaml',
  '/swagger.json',
  '/swagger.yaml',
  '/api-docs',
  '/api-docs.json',
  '/v1/openapi.json',
  '/v2/openapi.json',
  '/v3/openapi.json',
  '/docs/openapi.json',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and parse an OpenAPI 3.x specification.
 *
 * @param specPath - A URL (`http://...`), an absolute/relative file path,
 *                   or `undefined` to trigger auto-discovery on localhost.
 * @param targetBaseUrl - Used as the base URL for requests when the spec
 *                         doesn't include a `servers` entry, or when we
 *                         want to override it (e.g., point at a different env).
 */
export async function parseSpec(specPath: string | undefined, targetBaseUrl: string): Promise<ParsedSpec> {
  const { rawSpec, resolvedSpecUrl } = await loadSpec(specPath, targetBaseUrl);

  // swagger-parser validates and fully dereferences $ref chains
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (await SwaggerParser.dereference(rawSpec as any)) as any;

  // Validate this is OpenAPI 3.x
  if (!api.openapi || !api.openapi.startsWith('3.')) {
    const version = api.openapi ?? api.swagger ?? 'unknown';
    const isSwagger2 = String(version).startsWith('2.');
    const migrationHint = isSwagger2
      ? `\n\n  Tip: Convert your Swagger 2.0 spec to OpenAPI 3.x:\n` +
        `    Online:  https://editor.swagger.io → File → Convert to OpenAPI 3\n` +
        `    CLI:     npx swagger2openapi your-spec.yaml -o openapi3.yaml`
      : '';
    throw new Error(
      `Unsupported spec version: "${version}". EdgeFuzz requires OpenAPI 3.x.${migrationHint}`,
    );
  }

  const baseUrl = resolveBaseUrl(api, targetBaseUrl);
  const endpoints = extractEndpoints(api);

  return {
    baseUrl,
    specSource: resolvedSpecUrl,
    endpoints,
  };
}

/**
 * Attempt to discover an OpenAPI spec on localhost without a user-supplied path.
 * Returns the spec URL and parsed content of the first spec found.
 */
export async function discoverSpec(targetBaseUrl: string): Promise<string> {
  const base = targetBaseUrl.replace(/\/$/, '');

  process.stderr.write(`  Searching for OpenAPI spec at ${base}...\n`);

  // If a targetBaseUrl is given, probe its known paths first
  for (const specPath of DISCOVERY_PATHS) {
    const url = `${base}${specPath}`;
    try {
      const found = await probeUrl(url);
      if (found) {
        process.stderr.write(`  Found spec at ${url}\n\n`);
        return url;
      }
    } catch {
      // continue probing
    }
  }

  // If not found on the given host, sweep common localhost ports
  for (const port of DISCOVERY_PORTS) {
    for (const specPath of DISCOVERY_PATHS) {
      const url = `http://localhost:${port}${specPath}`;
      try {
        const found = await probeUrl(url);
        if (found) {
          process.stderr.write(`  Found spec at ${url}\n\n`);
          return url;
        }
      } catch {
        // continue
      }
    }
  }

  throw new Error(
    `Could not auto-discover an OpenAPI spec.\n\n` +
      `  Probed these paths on ${base}:\n` +
      DISCOVERY_PATHS.map((p) => `    ${base}${p}`).join('\n') +
      `\n\n` +
      `  Is your server running and reachable at ${base}?\n\n` +
      `  Tip: Provide the spec path explicitly:\n` +
      `    edgefuzz ${base} --spec ./openapi.yaml\n` +
      `    edgefuzz ${base} --spec ${base}/openapi.json\n\n` +
      `  Don't have a server yet? Try the built-in demo:\n` +
      `    edgefuzz --demo`,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadSpec(
  specPath: string | undefined,
  targetBaseUrl: string,
): Promise<{ rawSpec: unknown; resolvedSpecUrl: string }> {
  // Case 1: explicit URL
  if (specPath && (specPath.startsWith('http://') || specPath.startsWith('https://'))) {
    const res = await fetch(specPath);
    if (!res.ok) {
      throw new Error(`Failed to fetch spec from ${specPath}: HTTP ${res.status}`);
    }
    const text = await res.text();
    return { rawSpec: parseSpecText(text, specPath), resolvedSpecUrl: specPath };
  }

  // Case 2: file path
  if (specPath) {
    const resolved = path.resolve(specPath);
    if (!existsSync(resolved)) {
      throw new Error(`Spec file not found: ${resolved}`);
    }
    const text = await readFile(resolved, 'utf-8');
    return { rawSpec: parseSpecText(text, resolved), resolvedSpecUrl: resolved };
  }

  // Case 3: auto-discovery
  const discoveredUrl = await discoverSpec(targetBaseUrl);
  const res = await fetch(discoveredUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch auto-discovered spec at ${discoveredUrl}: HTTP ${res.status}`);
  }
  const text = await res.text();
  return { rawSpec: parseSpecText(text, discoveredUrl), resolvedSpecUrl: discoveredUrl };
}

function parseSpecText(text: string, hint: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Failed to parse spec as JSON (source: ${hint}): ${(e as Error).message}`);
    }
  }
  // Treat as YAML
  try {
    const yaml = _require('js-yaml') as typeof import('js-yaml');
    return yaml.load(text);
  } catch (e) {
    throw new Error(`Failed to parse spec as YAML (source: ${hint}): ${(e as Error).message}`);
  }
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const text = await res.text();
    const trimmed = text.trim();
    // Must look like JSON object or YAML with openapi/swagger key
    return (
      trimmed.startsWith('{') ||
      trimmed.includes('openapi:') ||
      trimmed.includes('swagger:')
    );
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveBaseUrl(api: any, overrideBaseUrl: string): string {
  // User-supplied override always wins
  if (overrideBaseUrl) return overrideBaseUrl.replace(/\/$/, '');

  // Use first server entry from the spec
  if (api.servers && api.servers.length > 0) {
    const serverUrl = api.servers[0].url as string;
    // If it's a relative URL (starts with /), we can't use it — fall through
    if (serverUrl.startsWith('http')) return serverUrl.replace(/\/$/, '');
  }

  return 'http://localhost:8080';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractEndpoints(api: any): ParsedEndpoint[] {
  const endpoints: ParsedEndpoint[] = [];
  const paths: Record<string, Record<string, unknown>> = api.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    // Shared parameters defined at path level (inherited by all methods)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sharedParams: any[] = (pathItem as any).parameters ?? [];

    const methods: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

    for (const method of methods) {
      const operation = (pathItem as Record<string, unknown>)[method.toLowerCase()];
      if (!operation || typeof operation !== 'object') continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const op = operation as any;

      // Merge path-level params with operation-level params (op wins on name+in collision)
      const rawParams = mergeParameters(sharedParams, op.parameters ?? []);
      const parameters = rawParams.map(normalizeParameter).filter(Boolean) as ParsedParameter[];

      const endpoint: ParsedEndpoint = {
        method,
        path: pathTemplate,
        operationId: op.operationId,
        summary: op.summary,
        parameters,
        requestBody: extractRequestBody(op.requestBody),
      };

      endpoints.push(endpoint);
    }
  }

  return endpoints;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeParameters(shared: any[], operation: any[]): any[] {
  const merged = [...shared];
  for (const param of operation) {
    const idx = merged.findIndex((p) => p.name === param.name && p.in === param.in);
    if (idx >= 0) {
      merged[idx] = param; // operation-level wins
    } else {
      merged.push(param);
    }
  }
  return merged;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeParameter(raw: any): ParsedParameter | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.name || !raw.in) return null;
  if (!['query', 'header', 'path', 'cookie'].includes(raw.in)) return null;

  return {
    name: String(raw.name),
    in: raw.in as ParsedParameter['in'],
    required: Boolean(raw.required ?? (raw.in === 'path')), // path params always required
    schema: normalizeSchema(raw.schema ?? {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractRequestBody(rawBody: any): ParsedEndpoint['requestBody'] | undefined {
  if (!rawBody || typeof rawBody !== 'object') return undefined;

  const content = rawBody.content ?? {};

  // Prefer application/json, then the first available content type
  let contentType = 'application/json';
  let mediaObj = content['application/json'];

  if (!mediaObj) {
    const firstKey = Object.keys(content)[0];
    if (!firstKey) return undefined;
    contentType = firstKey;
    mediaObj = content[firstKey];
  }

  if (!mediaObj) return undefined;

  return {
    required: Boolean(rawBody.required),
    contentType,
    schema: normalizeSchema(mediaObj.schema ?? {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeSchema(raw: any): JsonSchema {
  if (!raw || typeof raw !== 'object') return { type: 'string' };

  const schema: JsonSchema = {};

  if (raw.type) schema.type = raw.type as string;
  if (raw.format) schema.format = raw.format as string;
  if (raw.enum) schema.enum = raw.enum as unknown[];
  if (raw.minimum !== undefined) schema.minimum = Number(raw.minimum);
  if (raw.maximum !== undefined) schema.maximum = Number(raw.maximum);
  if (raw.minLength !== undefined) schema.minLength = Number(raw.minLength);
  if (raw.maxLength !== undefined) schema.maxLength = Number(raw.maxLength);
  if (raw.nullable) schema.nullable = Boolean(raw.nullable);
  if (raw.required && Array.isArray(raw.required)) schema.required = raw.required as string[];

  if (raw.properties && typeof raw.properties === 'object') {
    schema.properties = {};
    for (const [key, val] of Object.entries(raw.properties)) {
      schema.properties[key] = normalizeSchema(val);
    }
  }

  if (raw.items) schema.items = normalizeSchema(raw.items);
  if (raw.anyOf && Array.isArray(raw.anyOf)) schema.anyOf = raw.anyOf.map(normalizeSchema);
  if (raw.oneOf && Array.isArray(raw.oneOf)) schema.oneOf = raw.oneOf.map(normalizeSchema);
  if (raw.allOf && Array.isArray(raw.allOf)) schema.allOf = raw.allOf.map(normalizeSchema);

  return schema;
}
