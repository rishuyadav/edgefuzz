/**
 * Stage 2: Smart Adversarial Mutation Engine.
 *
 * Orchestrates all mutation rule sets and produces a flat list of
 * MutatedRequest objects ready to be fired by the executor.
 *
 * Two modes:
 *  static-only (default):  type-boundary + structural + encoding rules
 *  +llm (opt-in):          above + LLM-generated semantic payloads per endpoint
 */

import type {
  ParsedSpec,
  ParsedEndpoint,
  ParsedParameter,
  MutatedRequest,
  JsonSchema,
  MutationCategory,
  SemanticMutation,
} from '../types/index.js';
import { typeBoundaryMutations } from './type-boundary.js';
import { structuralMutations } from './structural.js';
import { encodingMutations } from './encoding.js';
import {
  generateSemanticMutationsBatch,
  type LLMConfig,
} from './semantic.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateMutationsOptions {
  /**
   * When true, calls the LLM to generate additional semantic mutations
   * after all static rules have run. Requires llmConfig to be provided.
   * Default: false
   */
  llmMutations?: boolean;
  llmConfig?: LLMConfig;
  /** Progress callback for the LLM generation phase */
  onLlmProgress?: (done: number, total: number) => void;
}

/**
 * Generate the full set of adversarial requests for an entire parsed spec.
 *
 * In static-only mode (default): synchronous, zero API cost.
 * In LLM-augmented mode (llmMutations: true): async, makes one LLM call
 * per endpoint in parallel batches, then appends semantic mutations.
 */
export async function generateMutations(
  spec: ParsedSpec,
  options: GenerateMutationsOptions = {},
): Promise<MutatedRequest[]> {
  const { llmMutations = false, llmConfig, onLlmProgress } = options;

  // --- Phase A.1: Static mutations (always runs, zero cost) ---
  const staticRequests: MutatedRequest[] = [];
  for (const endpoint of spec.endpoints) {
    staticRequests.push(...mutateEndpointStatic(endpoint, spec.baseUrl));
  }

  if (!llmMutations) {
    return staticRequests;
  }

  // --- Phase A.2: LLM semantic mutations (opt-in, requires API key) ---
  const semanticMap = await generateSemanticMutationsBatch(
    spec.endpoints,
    llmConfig,
    onLlmProgress,
  );

  const semanticRequests: MutatedRequest[] = [];
  for (const endpoint of spec.endpoints) {
    const key = `${endpoint.method}:${endpoint.path}`;
    const mutations = semanticMap.get(key) ?? [];
    semanticRequests.push(...mutateEndpointSemantic(endpoint, spec.baseUrl, mutations));
  }

  // Static first, semantic appended — static always provides baseline coverage
  return [...staticRequests, ...semanticRequests];
}

// ---------------------------------------------------------------------------
// Static per-endpoint mutation
// ---------------------------------------------------------------------------

function mutateEndpointStatic(endpoint: ParsedEndpoint, baseUrl: string): MutatedRequest[] {
  const requests: MutatedRequest[] = [];
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // ---- 1. Body mutations (POST / PUT / PATCH) ----
  if (endpoint.requestBody) {
    const { schema } = endpoint.requestBody;
    const validPayload = generateValidPayload(schema);

    // Type-boundary mutations on each top-level field
    if (schema.properties) {
      for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
        const fieldMutations = typeBoundaryMutations(fieldSchema);
        for (const mutation of fieldMutations) {
          const body = {
            ...(isObject(validPayload) ? validPayload : {}),
            [fieldName]: mutation.value,
          };
          requests.push(
            makeRequest(endpoint, baseUrl, baseHeaders, {
              mutationId: `body-field-${fieldName}-${mutation.id}`,
              mutationLabel: `Field "${fieldName}": ${mutation.label}`,
              mutationCategory: 'type-boundary',
              body,
            }),
          );
        }
      }
    }

    // Structural mutations
    const structMutations = structuralMutations(schema, validPayload);
    for (const mutation of structMutations) {
      requests.push(
        makeRequest(endpoint, baseUrl, baseHeaders, {
          mutationId: mutation.id,
          mutationLabel: mutation.label,
          mutationCategory: 'structural',
          body: mutation.body,
        }),
      );
    }

    // Encoding mutations on all string fields
    if (schema.properties) {
      const stringFields = Object.entries(schema.properties).filter(
        ([, s]) => resolveType(s) === 'string',
      );
      if (stringFields.length > 0) {
        const encMutations = encodingMutations();
        const [firstField] = stringFields[0]!;
        for (const enc of encMutations) {
          const body = {
            ...(isObject(validPayload) ? validPayload : {}),
            [firstField]: enc.value,
          };
          requests.push(
            makeRequest(endpoint, baseUrl, baseHeaders, {
              mutationId: `body-enc-${firstField}-${enc.id}`,
              mutationLabel: `Encoding "${firstField}": ${enc.label}`,
              mutationCategory: 'encoding',
              body,
            }),
          );
        }
      }
    }

    // Content-type confusion mutations
    const contentTypeMutations: Array<{
      id: string;
      label: string;
      contentType: string;
      body: string;
    }> = [
      {
        id: 'ct-form-encoded',
        label: 'Wrong content-type: application/x-www-form-urlencoded',
        contentType: 'application/x-www-form-urlencoded',
        body: 'field=value&other=123',
      },
      {
        id: 'ct-plain-text',
        label: 'Wrong content-type: text/plain',
        contentType: 'text/plain',
        body: 'plain text body',
      },
      {
        id: 'ct-xml',
        label: 'Wrong content-type: application/xml',
        contentType: 'application/xml',
        body: '<?xml version="1.0"?><root><field>value</field></root>',
      },
    ];

    for (const ct of contentTypeMutations) {
      requests.push(
        makeRequest(
          endpoint,
          baseUrl,
          { ...baseHeaders, 'Content-Type': ct.contentType },
          {
            mutationId: ct.id,
            mutationLabel: ct.label,
            mutationCategory: 'structural',
            body: ct.body,
          },
        ),
      );
    }
  } else {
    // No request body — send spurious body to test server robustness
    requests.push(
      makeRequest(endpoint, baseUrl, baseHeaders, {
        mutationId: 'no-body-spurious',
        mutationLabel: 'Spurious JSON body on no-body endpoint',
        mutationCategory: 'structural',
        body: { unexpected: 'payload', count: 9999 },
      }),
    );
  }

  // ---- 2. Query parameter mutations ----
  const queryParams = endpoint.parameters.filter((p) => p.in === 'query');
  for (const param of queryParams) {
    const paramMutations = typeBoundaryMutations(param.schema);
    const encMutations = resolveType(param.schema) === 'string' ? encodingMutations() : [];

    const allParamMutations = [
      ...paramMutations.map((m) => ({ ...m, category: 'type-boundary' as MutationCategory })),
      ...encMutations.map((m) => ({ ...m, category: 'encoding' as MutationCategory })),
    ];

    for (const mutation of allParamMutations) {
      const baseQParams = buildBaseQueryParams(queryParams, param.name);
      const qParamsWithMutation = {
        ...baseQParams,
        [param.name]: String(mutation.value ?? 'null'),
      };
      requests.push(
        makeRequest(endpoint, baseUrl, baseHeaders, {
          mutationId: `query-${param.name}-${mutation.id}`,
          mutationLabel: `Query param "${param.name}": ${mutation.label}`,
          mutationCategory: mutation.category,
          queryParams: qParamsWithMutation,
        }),
      );
    }
  }

  // ---- 3. Path parameter mutations ----
  const pathParams = endpoint.parameters.filter((p) => p.in === 'path');
  for (const param of pathParams) {
    const paramMutations = [...typeBoundaryMutations(param.schema), ...encodingMutations()];

    for (const mutation of paramMutations) {
      const mutatedPath = substitutePath(
        endpoint.path,
        pathParams,
        param.name,
        mutation.value,
      );
      if (mutatedPath === null) continue;

      requests.push({
        endpoint,
        mutationId: `path-${param.name}-${mutation.id}`,
        mutationLabel: `Path param "${param.name}": ${mutation.label}`,
        mutationCategory: 'type-boundary',
        mutationSource: 'static',
        url: `${baseUrl}${mutatedPath}`,
        method: endpoint.method,
        headers: baseHeaders,
      });
    }
  }

  // ---- 4. Header mutations ----
  const headerParams = endpoint.parameters.filter((p) => p.in === 'header');
  for (const param of headerParams) {
    const paramMutations = typeBoundaryMutations(param.schema);
    for (const mutation of paramMutations) {
      const mutatedHeaders = {
        ...baseHeaders,
        [param.name]: String(mutation.value ?? ''),
      };
      requests.push(
        makeRequest(endpoint, baseUrl, mutatedHeaders, {
          mutationId: `header-${param.name}-${mutation.id}`,
          mutationLabel: `Header "${param.name}": ${mutation.label}`,
          mutationCategory: 'type-boundary',
        }),
      );
    }
  }

  return requests;
}

// ---------------------------------------------------------------------------
// LLM semantic per-endpoint mutation (Phase A)
// ---------------------------------------------------------------------------

function mutateEndpointSemantic(
  endpoint: ParsedEndpoint,
  baseUrl: string,
  semanticMutations: SemanticMutation[],
): MutatedRequest[] {
  const requests: MutatedRequest[] = [];
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  for (let i = 0; i < semanticMutations.length; i++) {
    const mutation = semanticMutations[i]!;
    const mutationId = `semantic-${i}-${endpoint.method.toLowerCase()}-${endpoint.path.replace(/\W+/g, '-')}`;

    const url = buildUrl(endpoint, baseUrl, mutation.queryParams);

    requests.push({
      endpoint,
      mutationId,
      mutationLabel: `[LLM] ${mutation.label}`,
      mutationCategory: 'semantic',
      mutationSource: 'llm',
      url,
      method: endpoint.method,
      headers: baseHeaders,
      queryParams: mutation.queryParams,
      body: mutation.body,
    });
  }

  return requests;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RequestOverrides {
  mutationId: string;
  mutationLabel: string;
  mutationCategory: MutationCategory;
  body?: unknown;
  queryParams?: Record<string, string>;
}

function makeRequest(
  endpoint: ParsedEndpoint,
  baseUrl: string,
  headers: Record<string, string>,
  overrides: RequestOverrides,
): MutatedRequest {
  const url = buildUrl(endpoint, baseUrl, overrides.queryParams);

  return {
    endpoint,
    mutationId: overrides.mutationId,
    mutationLabel: overrides.mutationLabel,
    mutationCategory: overrides.mutationCategory,
    mutationSource: 'static',
    url,
    method: endpoint.method,
    headers,
    queryParams: overrides.queryParams,
    body: overrides.body,
  };
}

function buildUrl(
  endpoint: ParsedEndpoint,
  baseUrl: string,
  queryParams?: Record<string, string>,
): string {
  const pathParams = endpoint.parameters.filter((p) => p.in === 'path');
  let urlPath = endpoint.path;

  for (const param of pathParams) {
    const placeholder = getValidPathValue(param.schema, param.name);
    urlPath = urlPath.replace(
      `{${param.name}}`,
      encodeURIComponent(String(placeholder)),
    );
  }

  let url = `${baseUrl}${urlPath}`;

  if (queryParams && Object.keys(queryParams).length > 0) {
    const qs = new URLSearchParams(queryParams).toString();
    url = `${url}?${qs}`;
  }

  return url;
}

function buildBaseQueryParams(
  params: ParsedParameter[],
  excludeName: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const param of params) {
    if (param.name === excludeName) continue;
    if (param.required) {
      result[param.name] = String(getValidParamValue(param.schema, param.name));
    }
  }
  return result;
}

function substitutePath(
  pathTemplate: string,
  pathParams: ParsedParameter[],
  mutatedParamName: string,
  mutatedValue: unknown,
): string | null {
  let path = pathTemplate;
  for (const param of pathParams) {
    if (param.name === mutatedParamName) {
      const strVal = mutatedValue === null ? 'null' : String(mutatedValue);
      path = path.replace(`{${param.name}}`, strVal);
    } else {
      const validVal = getValidPathValue(param.schema, param.name);
      path = path.replace(
        `{${param.name}}`,
        encodeURIComponent(String(validVal)),
      );
    }
  }
  return path;
}

/**
 * Generate a plausible "valid" payload from a schema.
 * Used as the baseline that static mutation rules modify.
 */
export function generateValidPayload(schema: JsonSchema): unknown {
  const type = resolveType(schema);

  switch (type) {
    case 'object': {
      const obj: Record<string, unknown> = {};
      if (schema.properties) {
        for (const [key, fieldSchema] of Object.entries(schema.properties)) {
          obj[key] = generateValidPayload(fieldSchema);
        }
      }
      return obj;
    }
    case 'array':
      return [generateValidPayload(schema.items ?? { type: 'string' })];
    case 'integer':
    case 'number':
      if (schema.minimum !== undefined) return schema.minimum;
      if (schema.maximum !== undefined) return Math.min(schema.maximum, 1);
      return 1;
    case 'boolean':
      return true;
    case 'string':
      if (schema.enum && schema.enum.length > 0) return schema.enum[0];
      if (schema.format) return getFormatDefault(schema.format);
      return 'example';
    default:
      return null;
  }
}

function getFormatDefault(format: string): string {
  switch (format) {
    case 'email': return 'user@example.com';
    case 'date': return '2024-01-01';
    case 'date-time': return '2024-01-01T00:00:00Z';
    case 'uuid': return '550e8400-e29b-41d4-a716-446655440000';
    case 'uri':
    case 'url': return 'https://example.com';
    case 'password': return 'Password123!';
    case 'byte': return 'dGVzdA==';
    case 'binary': return 'binary';
    default: return 'example';
  }
}

function getValidPathValue(schema: JsonSchema, _name: string): string | number {
  const type = resolveType(schema);
  if (type === 'integer' || type === 'number') return 1;
  if (schema.format === 'uuid') return '550e8400-e29b-41d4-a716-446655440000';
  return '1';
}

function getValidParamValue(schema: JsonSchema, _name: string): string | number | boolean {
  const type = resolveType(schema);
  if (type === 'integer' || type === 'number') return 1;
  if (type === 'boolean') return true;
  if (schema.enum && schema.enum.length > 0) return String(schema.enum[0]);
  return 'test';
}

function resolveType(schema: JsonSchema): string {
  if (schema.type) {
    return Array.isArray(schema.type) ? (schema.type[0] ?? 'string') : schema.type;
  }
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  if (schema.anyOf) {
    const nonNull = schema.anyOf.find((s) => s.type !== 'null');
    if (nonNull) return resolveType(nonNull);
  }
  return 'string';
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}
