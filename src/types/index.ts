/**
 * Core domain types for EdgeFuzz.
 * All modules import from here — keeps cross-module contracts stable.
 */

// ---------------------------------------------------------------------------
// OpenAPI / Schema types
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface ParsedParameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  required: boolean;
  schema: JsonSchema;
}

export interface ParsedEndpoint {
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  parameters: ParsedParameter[];
  requestBody?: {
    required: boolean;
    contentType: string;
    schema: JsonSchema;
  };
}

export interface ParsedSpec {
  baseUrl: string;
  specSource: string; // URL or file path used to load the spec
  endpoints: ParsedEndpoint[];
}

// ---------------------------------------------------------------------------
// JSON Schema (simplified subset we handle)
// ---------------------------------------------------------------------------

export interface JsonSchema {
  type?: string | string[];
  format?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  enum?: unknown[];
  nullable?: boolean;
  // OpenAPI 3.1 nullable representation
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  additionalProperties?: boolean | JsonSchema;
}

// ---------------------------------------------------------------------------
// Mutation types
// ---------------------------------------------------------------------------

/** A single adversarial payload variant to be sent to an endpoint */
export interface MutatedRequest {
  endpoint: ParsedEndpoint;
  /** Unique identifier for the mutation rule that produced this payload */
  mutationId: string;
  /** Human-readable description of what this mutation is testing */
  mutationLabel: string;
  /** Category bucket for grouping in reports */
  mutationCategory: MutationCategory;
  /** Final URL with path params substituted */
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  /** Query params (for GET/DELETE etc.) */
  queryParams?: Record<string, string>;
  /** JSON body (for POST/PUT/PATCH) */
  body?: unknown;
}

export type MutationCategory =
  | 'type-boundary'
  | 'structural'
  | 'encoding'
  | 'format'
  | 'security';

// ---------------------------------------------------------------------------
// Execution / result types
// ---------------------------------------------------------------------------

export interface RequestResult {
  request: MutatedRequest;
  statusCode: number;
  responseBody: string;
  latencyMs: number;
  /** True if the connection timed out entirely (server hang) */
  timedOut: boolean;
  /** True if a network-level error occurred before getting a response */
  networkError: boolean;
  networkErrorMessage?: string;
}

// ---------------------------------------------------------------------------
// Crash / finding types
// ---------------------------------------------------------------------------

export type CrashSeverity = 'critical' | 'high' | 'medium';

export interface CrashFinding {
  /** Dedup key — same endpoint + mutation rule = same crash */
  id: string;
  severity: CrashSeverity;
  endpoint: ParsedEndpoint;
  mutationId: string;
  mutationLabel: string;
  mutationCategory: MutationCategory;
  statusCode: number;
  responseBody: string;
  latencyMs: number;
  timedOut: boolean;
  /** True if a network-level error caused the crash (server died mid-request) */
  networkError: boolean;
  /** The exact payload that triggered the crash */
  triggeringPayload: unknown;
  /** Ready-to-run curl command that reproduces the crash */
  curlReproducer: string;
  /** LLM-generated fix suggestion, populated if OPENAI/ANTHROPIC key is set */
  llmFixSuggestion?: string;
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface FuzzReport {
  version: '1';
  generatedAt: string; // ISO 8601
  target: string;
  specSource: string;
  summary: {
    totalRequests: number;
    totalEndpoints: number;
    totalCrashes: number;
    durationMs: number;
    requestsPerSecond: number;
  };
  crashes: CrashFinding[];
}

// ---------------------------------------------------------------------------
// Config / options types
// ---------------------------------------------------------------------------

export interface EdgeFuzzConfig {
  /** Target base URL (e.g. http://localhost:8080) */
  targetUrl: string;
  /** Path or URL to OpenAPI spec; if omitted, auto-discovery is attempted */
  specPath?: string;
  /** Max concurrent in-flight HTTP requests */
  concurrency: number;
  /** Per-request timeout in milliseconds */
  timeoutMs: number;
  /** Where to write the JSON report; false = don't write */
  reportPath: string | false;
  /** Disable TUI and output plain text (useful for CI) */
  ci: boolean;
  /** LLM provider to use for fix suggestions */
  llmProvider?: 'openai' | 'anthropic';
  /** Override LLM model name */
  llmModel?: string;
  /** Custom request headers to include in all fuzzing requests */
  headers: Record<string, string>;
  /** Only fuzz endpoints matching these path prefixes */
  includePaths?: string[];
  /** Skip endpoints matching these path prefixes */
  excludePaths?: string[];
}

// ---------------------------------------------------------------------------
// Progress event types (used by TUI / CI reporter)
// ---------------------------------------------------------------------------

export type ProgressEvent =
  | { type: 'start'; totalRequests: number; totalEndpoints: number }
  | { type: 'request_done'; result: RequestResult }
  | { type: 'crash_found'; crash: CrashFinding }
  | { type: 'llm_suggestion'; crashId: string; suggestion: string }
  | { type: 'done'; report: FuzzReport };
