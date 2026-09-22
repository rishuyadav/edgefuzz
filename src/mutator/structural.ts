/**
 * Structural mutation rules.
 *
 * These rules probe how the server handles payload structure violations:
 * missing required fields, extra unknown fields, deeply nested JSON,
 * wrong content shape, etc.
 */

import type { JsonSchema } from '../types/index.js';

export interface StructuralMutation {
  id: string;
  label: string;
  body: unknown;
}

/**
 * Generate structurally mutated variants of a valid JSON payload.
 *
 * @param schema  - The OpenAPI schema for the request body.
 * @param validPayload - A "valid" baseline payload (generated from schema defaults).
 */
export function structuralMutations(schema: JsonSchema, validPayload: unknown): StructuralMutation[] {
  const mutations: StructuralMutation[] = [];

  mutations.push(
    // Completely empty body
    { id: 'struct-empty-body', label: 'Empty JSON object {}', body: {} },
    // null body
    { id: 'struct-null-body', label: 'null body', body: null },
    // Array instead of object
    { id: 'struct-array-body', label: 'Array instead of object', body: [1, 2, 3] },
    // String instead of object
    { id: 'struct-string-body', label: 'String instead of object', body: 'not-an-object' },
    // Integer instead of object
    { id: 'struct-int-body', label: 'Integer instead of object', body: 42 },
    // Deeply nested object
    {
      id: 'struct-deep-nest',
      label: 'Deeply nested object (depth 100)',
      body: buildDeepObject(100),
    },
    // Oversized payload (~1MB of data)
    {
      id: 'struct-oversized',
      label: 'Oversized payload (~1MB)',
      body: { data: 'x'.repeat(1_000_000) },
    },
    // Extra unknown fields injected alongside valid payload
    {
      id: 'struct-extra-fields',
      label: 'Extra unknown fields alongside valid payload',
      body: {
        ...(isObject(validPayload) ? validPayload : {}),
        __edgefuzz_extra_field__: 'injected',
        __proto__: { polluted: true },
        constructor: { prototype: { polluted: true } },
      },
    },
    // Unicode key names
    {
      id: 'struct-unicode-keys',
      label: 'Unicode / emoji field names',
      body: {
        ...(isObject(validPayload) ? validPayload : {}),
        '你好': 'value',
        '🔥': 'fire',
        '\u0000key': 'null-byte-key',
      },
    },
    // Duplicate keys via JSON string (most parsers take last, but some choke)
    {
      id: 'struct-raw-duplicate-keys',
      label: 'Raw JSON string with duplicate keys',
      body: '__RAW_JSON__:{"id":1,"id":2}',
    },
  );

  // Schema-aware: remove each required field one by one
  if (schema.properties && schema.required && schema.required.length > 0) {
    for (const requiredField of schema.required) {
      const withoutField = { ...(isObject(validPayload) ? validPayload : {}) };
      delete (withoutField as Record<string, unknown>)[requiredField];
      mutations.push({
        id: `struct-missing-${requiredField}`,
        label: `Missing required field: "${requiredField}"`,
        body: withoutField,
      });
    }
  }

  // Schema-aware: set every field to null simultaneously
  if (schema.properties) {
    const allNull: Record<string, null> = {};
    for (const key of Object.keys(schema.properties)) {
      allNull[key] = null;
    }
    mutations.push({
      id: 'struct-all-null',
      label: 'All fields set to null',
      body: allNull,
    });
  }

  return mutations;
}

function buildDeepObject(depth: number): unknown {
  if (depth === 0) return { value: 'deep' };
  return { nested: buildDeepObject(depth - 1) };
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}
