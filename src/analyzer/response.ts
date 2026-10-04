/**
 * Response Schema Validator — Stage 4 contract checking.
 *
 * After each HTTP request, this module checks whether the response body
 * conforms to the schema documented in the OpenAPI spec. It detects:
 *
 *  - missing-required-field : required property absent from a 2xx response
 *  - wrong-type             : property present but wrong JSON type vs spec
 *  - error-body-leaked      : non-2xx body contains stack traces / internals
 *  - undocumented-status    : status code not mentioned in the spec at all
 *  - empty-success-body     : 200/201 returned empty body when schema expects object
 *
 * These are NOT crashes (no 500) but indicate contract violations and bugs.
 */

import crypto from 'crypto';
import type {
  RequestResult,
  ResponseMismatch,
  MismatchKind,
  CrashSeverity,
  JsonSchema,
  ParsedEndpoint,
} from '../types/index.js';
import { buildCurlReproducer } from '../reporter/curl.js';

// ---------------------------------------------------------------------------
// Patterns that indicate internal details leaked in error responses
// ---------------------------------------------------------------------------

const LEAK_PATTERNS: RegExp[] = [
  /at\s+\w+[\w.<>]+\s*\(/,          // JS/Java stack trace: "at Object.<anonymous> ("
  /Traceback \(most recent call/,    // Python traceback
  /Exception in thread/,            // Java uncaught exception
  /\bSQLException\b/,               // Java SQL exception class
  /\bPDOException\b/,               // PHP PDO exception
  /\bActiveRecord::/,               // Ruby on Rails ORM error
  /\bSequelizeError\b/,             // Node.js Sequelize
  /\bTypeOrmError\b/,               // Node.js TypeORM
  /\bMongoError\b/,                 // MongoDB driver
  /\bPrismaClientKnownRequestError/, // Prisma ORM
  /\bSyntaxError:/,                 // Raw JS SyntaxError in response body
  /\bTypeError:/,                   // Raw JS TypeError in response body
  /\bReferenceError:/,              // Raw JS ReferenceError
  // Credential leakage — require the field to be a JSON key followed by a
  // non-empty string value (not an array, object, or validation error message).
  // This prevents false positives on .NET validation errors like:
  //   "$.password": ["The JSON value could not be converted..."]
  // where "password" is a JSON path reference, not a leaked credential value.
  // Pattern breakdown: ["']?<field>["']?\s*:\s*["']<6+ non-quote chars>["']
  /["']?password["']?\s*:\s*["'][^"']{6,}["']/i,
  /["']?secret["']?\s*:\s*["'][^"']{6,}["']/i,
  /["']?connectionString["']?\s*:\s*["'][^"']{6,}["']/i,
  /mongodb:\/\//i,                  // MongoDB URI
  /mysql:\/\//i,                    // MySQL URI
  /postgres:\/\//i,                 // Postgres URI
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse a completed HTTP response and produce any ResponseMismatch findings.
 * Returns an empty array when the response fully conforms to the spec.
 */
export function analyseResponse(result: RequestResult): ResponseMismatch[] {
  const { request, statusCode, responseBody } = result;
  const endpoint = request.endpoint;

  // Network errors and timeouts are handled by crash.ts, not here
  if (result.networkError || result.timedOut) return [];

  const mismatches: ResponseMismatch[] = [];

  // 1. Check for error body leakage on any non-2xx response
  if (statusCode >= 400 && statusCode < 500 && responseBody) {
    const leakMismatch = checkErrorBodyLeakage(result, endpoint, statusCode, responseBody);
    if (leakMismatch) mismatches.push(leakMismatch);
  }

  // 2. Undocumented status code
  if (endpoint.responseSchemas) {
    const undocumented = checkUndocumentedStatus(result, endpoint, statusCode);
    if (undocumented) mismatches.push(undocumented);
  }

  // 3. Response schema validation for 2xx responses
  if (statusCode >= 200 && statusCode < 300 && endpoint.responseSchemas) {
    const schemaKey = String(statusCode);
    const schema =
      endpoint.responseSchemas[schemaKey] ??
      endpoint.responseSchemas['2XX'] ??
      endpoint.responseSchemas['default'];

    if (schema) {
      // Empty body check
      const emptyMismatch = checkEmptyBody(result, endpoint, statusCode, responseBody, schema);
      if (emptyMismatch) mismatches.push(emptyMismatch);

      // Schema conformance (only when body is parseable JSON)
      if (responseBody.trim()) {
        try {
          const parsed: unknown = JSON.parse(responseBody);
          const violations = validateAgainstSchema(parsed, schema, '');
          for (const v of violations) {
            const id = makeId(endpoint, request.mutationId, v.kind, v.fieldPath ?? '');
            mismatches.push({
              id,
              kind: v.kind,
              severity: v.severity,
              endpoint,
              mutationId: request.mutationId,
              mutationLabel: request.mutationLabel,
              statusCode,
              message: v.message,
              fieldPath: v.fieldPath,
              actualValue: v.actualValue,
              expectedType: v.expectedType,
              curlReproducer: buildCurlReproducer(request),
            });
          }
        } catch {
          // Non-JSON body — not flagged here (server may return text/html for some errors)
        }
      }
    }
  }

  return mismatches;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkErrorBodyLeakage(
  result: RequestResult,
  endpoint: ParsedEndpoint,
  statusCode: number,
  body: string,
): ResponseMismatch | null {
  const matchedPattern = LEAK_PATTERNS.find((re) => re.test(body));
  if (!matchedPattern) return null;

  const excerpt = body.slice(0, 300).replace(/\n/g, ' ');
  const id = makeId(endpoint, result.request.mutationId, 'error-body-leaked', String(statusCode));

  return {
    id,
    kind: 'error-body-leaked',
    severity: 'high',
    endpoint,
    mutationId: result.request.mutationId,
    mutationLabel: result.request.mutationLabel,
    statusCode,
    message: `HTTP ${statusCode} response body contains internal details (stack trace, ORM error, or credential). This leaks implementation details to clients.`,
    responseExcerpt: excerpt,
    curlReproducer: buildCurlReproducer(result.request),
  };
}

function checkUndocumentedStatus(
  result: RequestResult,
  endpoint: ParsedEndpoint,
  statusCode: number,
): ResponseMismatch | null {
  if (!endpoint.responseSchemas) return null;
  // Skip 5xx — those are handled by crash.ts
  if (statusCode >= 500) return null;

  const documented = endpoint.responseSchemas;
  const statusStr = String(statusCode);
  const firstDigit = statusStr[0]!;

  // Check exact match, wildcard (e.g. "2XX"), and "default"
  const isDocumented =
    statusStr in documented ||
    `${firstDigit}XX` in documented ||
    'default' in documented;

  if (isDocumented) return null;

  const id = makeId(endpoint, result.request.mutationId, 'undocumented-status', statusStr);
  return {
    id,
    kind: 'undocumented-status',
    severity: 'low',
    endpoint,
    mutationId: result.request.mutationId,
    mutationLabel: result.request.mutationLabel,
    statusCode,
    message: `HTTP ${statusCode} is not documented in the OpenAPI spec for ${endpoint.method} ${endpoint.path}. The spec documents: ${Object.keys(documented).join(', ')}.`,
    curlReproducer: buildCurlReproducer(result.request),
  };
}

function checkEmptyBody(
  result: RequestResult,
  endpoint: ParsedEndpoint,
  statusCode: number,
  body: string,
  schema: JsonSchema,
): ResponseMismatch | null {
  if (body.trim()) return null; // not empty
  // Only flag when spec expects a non-trivial body
  const schemaType = resolveSchemaType(schema);
  if (schemaType !== 'object' && schemaType !== 'array') return null;

  const id = makeId(endpoint, result.request.mutationId, 'empty-success-body', String(statusCode));
  return {
    id,
    kind: 'empty-success-body',
    severity: 'medium',
    endpoint,
    mutationId: result.request.mutationId,
    mutationLabel: result.request.mutationLabel,
    statusCode,
    message: `HTTP ${statusCode} returned an empty body but the spec defines a ${schemaType} response schema for ${endpoint.method} ${endpoint.path}.`,
    curlReproducer: buildCurlReproducer(result.request),
  };
}

// ---------------------------------------------------------------------------
// Schema conformance validator (recursive, depth-limited)
// ---------------------------------------------------------------------------

interface Violation {
  kind: MismatchKind;
  severity: CrashSeverity;
  message: string;
  fieldPath?: string;
  actualValue?: unknown;
  expectedType?: string;
}

function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path: string,
  depth = 0,
): Violation[] {
  // Depth guard — avoid O(n²) on deeply nested responses
  if (depth > 6) return [];

  const violations: Violation[] = [];
  const expectedType = resolveSchemaType(schema);

  // Type check
  const actualType = jsonTypeOf(value);
  if (expectedType && actualType !== expectedType && value !== null) {
    violations.push({
      kind: 'wrong-type',
      severity: 'low',
      message: `Field "${path || '<root>'}" has type "${actualType}" but spec expects "${expectedType}".`,
      fieldPath: path || undefined,
      actualValue: value,
      expectedType,
    });
    // Don't recurse into a mismatched type
    return violations;
  }

  // Required fields check on objects
  if (expectedType === 'object' && schema.required && isObject(value)) {
    for (const requiredField of schema.required) {
      if (!(requiredField in (value as Record<string, unknown>))) {
        const fieldPath = path ? `${path}.${requiredField}` : requiredField;
        violations.push({
          kind: 'missing-required-field',
          severity: 'medium',
          message: `Required field "${fieldPath}" is absent from the response body.`,
          fieldPath,
          actualValue: undefined,
          expectedType: schema.properties?.[requiredField]
            ? resolveSchemaType(schema.properties[requiredField]!)
            : 'any',
        });
      }
    }
  }

  // Recurse into object properties
  if (
    expectedType === 'object' &&
    schema.properties &&
    isObject(value)
  ) {
    const obj = value as Record<string, unknown>;
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      if (propName in obj) {
        const childPath = path ? `${path}.${propName}` : propName;
        violations.push(
          ...validateAgainstSchema(obj[propName], propSchema, childPath, depth + 1),
        );
      }
    }
  }

  // Recurse into array items (sample first element only — avoid O(n) per run)
  if (expectedType === 'array' && schema.items && Array.isArray(value) && value.length > 0) {
    violations.push(
      ...validateAgainstSchema(value[0], schema.items, `${path}[0]`, depth + 1),
    );
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function resolveSchemaType(schema: JsonSchema): string {
  if (schema.type) {
    return Array.isArray(schema.type) ? (schema.type[0] ?? 'string') : schema.type;
  }
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  if (schema.anyOf) {
    const nonNull = schema.anyOf.find((s) => s.type !== 'null');
    if (nonNull) return resolveSchemaType(nonNull);
  }
  return '';
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') {
    // OpenAPI distinguishes integer from number
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return t; // 'string', 'boolean', 'object'
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function makeId(
  endpoint: ParsedEndpoint,
  mutationId: string,
  kind: MismatchKind,
  discriminator: string,
): string {
  const key = `${endpoint.method}:${endpoint.path}:${kind}:${discriminator}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}
