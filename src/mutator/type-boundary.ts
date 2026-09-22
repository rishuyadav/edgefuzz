/**
 * Type-boundary mutation rules.
 *
 * These rules probe the edges of primitive type handling:
 * integer overflow/underflow, float-where-int-expected,
 * empty strings, null, boolean coercion, etc.
 */

import type { JsonSchema } from '../types/index.js';

export interface MutationValue {
  id: string;
  label: string;
  value: unknown;
}

/**
 * Given a JSON Schema node, return a list of adversarial boundary values
 * that are semantically plausible but designed to break naive type handling.
 */
export function typeBoundaryMutations(schema: JsonSchema): MutationValue[] {
  const mutations: MutationValue[] = [];
  const type = resolveType(schema);

  switch (type) {
    case 'integer':
      mutations.push(
        { id: 'int-max-plus-one', label: 'MAX_INT + 1 (64-bit overflow)', value: 9223372036854775808 },
        { id: 'int-min-minus-one', label: 'MIN_INT - 1 (underflow)', value: -9223372036854775809 },
        { id: 'int-zero', label: 'Zero (boundary)', value: 0 },
        { id: 'int-negative-one', label: '-1 (negative boundary)', value: -1 },
        { id: 'int-max-safe', label: 'MAX_SAFE_INTEGER + 1', value: Number.MAX_SAFE_INTEGER + 1 },
        { id: 'int-as-float', label: 'Float where int expected (1.5)', value: 1.5 },
        { id: 'int-as-string', label: 'Numeric string "999"', value: '999' },
        { id: 'int-as-bool', label: 'Boolean true where int expected', value: true },
        { id: 'int-null', label: 'null value', value: null },
        { id: 'int-nan-string', label: '"NaN" string', value: 'NaN' },
        { id: 'int-inf-string', label: '"Infinity" string', value: 'Infinity' },
      );
      // Respect schema bounds if present
      if (schema.minimum !== undefined) {
        mutations.push({
          id: 'int-below-minimum',
          label: `Below minimum (${schema.minimum - 1})`,
          value: schema.minimum - 1,
        });
      }
      if (schema.maximum !== undefined) {
        mutations.push({
          id: 'int-above-maximum',
          label: `Above maximum (${schema.maximum + 1})`,
          value: schema.maximum + 1,
        });
      }
      break;

    case 'number':
      mutations.push(
        { id: 'num-inf', label: 'Infinity', value: Infinity },
        { id: 'num-neg-inf', label: '-Infinity', value: -Infinity },
        { id: 'num-nan', label: 'NaN', value: NaN },
        { id: 'num-zero', label: 'Zero', value: 0 },
        { id: 'num-negative', label: 'Negative (-0.000001)', value: -0.000001 },
        { id: 'num-very-large', label: '1e308 (near float max)', value: 1e308 },
        { id: 'num-as-string', label: 'Numeric string "3.14"', value: '3.14' },
        { id: 'num-null', label: 'null value', value: null },
      );
      break;

    case 'string':
      mutations.push(
        { id: 'str-empty', label: 'Empty string ""', value: '' },
        { id: 'str-whitespace', label: 'Whitespace-only "   "', value: '   ' },
        { id: 'str-as-int', label: 'Integer 0 where string expected', value: 0 },
        { id: 'str-null', label: 'null value', value: null },
        { id: 'str-bool', label: 'Boolean false where string expected', value: false },
        { id: 'str-array', label: 'Array where string expected', value: [] },
      );
      // Format-specific boundary values
      if (schema.format) {
        mutations.push(...formatBoundaryMutations(schema.format));
      }
      if (schema.minLength !== undefined) {
        mutations.push({
          id: 'str-below-minlength',
          label: `String shorter than minLength (${schema.minLength})`,
          value: 'x'.repeat(Math.max(0, schema.minLength - 1)),
        });
      }
      if (schema.maxLength !== undefined) {
        mutations.push({
          id: 'str-above-maxlength',
          label: `String longer than maxLength (${schema.maxLength})`,
          value: 'x'.repeat(schema.maxLength + 1),
        });
      }
      break;

    case 'boolean':
      mutations.push(
        { id: 'bool-as-string-true', label: '"true" string where boolean expected', value: 'true' },
        { id: 'bool-as-string-false', label: '"false" string where boolean expected', value: 'false' },
        { id: 'bool-as-one', label: '1 where boolean expected', value: 1 },
        { id: 'bool-as-zero', label: '0 where boolean expected', value: 0 },
        { id: 'bool-null', label: 'null value', value: null },
      );
      break;

    case 'array':
      mutations.push(
        { id: 'arr-null', label: 'null where array expected', value: null },
        { id: 'arr-as-string', label: 'String where array expected', value: 'not-an-array' },
        { id: 'arr-as-object', label: 'Object where array expected', value: {} },
        { id: 'arr-empty', label: 'Empty array []', value: [] },
        { id: 'arr-deep-nested', label: 'Deeply nested array (depth 20)', value: buildDeepArray(20) },
        { id: 'arr-large', label: 'Array with 1000 items', value: Array(1000).fill(0) },
      );
      break;

    case 'object':
      mutations.push(
        { id: 'obj-null', label: 'null where object expected', value: null },
        { id: 'obj-as-array', label: 'Array where object expected', value: [1, 2, 3] },
        { id: 'obj-as-string', label: 'String where object expected', value: '{}' },
        { id: 'obj-empty', label: 'Empty object {}', value: {} },
      );
      break;

    default:
      // Unknown type — still emit a null
      mutations.push({ id: 'unknown-null', label: 'null (unknown type)', value: null });
  }

  // Enum violations: send a value NOT in the enum
  if (schema.enum && schema.enum.length > 0) {
    mutations.push({
      id: 'enum-violation',
      label: 'Value not in enum set',
      value: '__INVALID_ENUM_VALUE__',
    });
    mutations.push({ id: 'enum-null', label: 'null for enum field', value: null });
  }

  return mutations;
}

function formatBoundaryMutations(format: string): MutationValue[] {
  switch (format) {
    case 'email':
      return [
        { id: 'fmt-email-no-at', label: 'Email without @ symbol', value: 'notanemail.com' },
        { id: 'fmt-email-no-domain', label: 'Email without domain', value: 'user@' },
        { id: 'fmt-email-empty', label: 'Empty email', value: '' },
        { id: 'fmt-email-sql', label: "SQL in email field", value: "' OR '1'='1'@evil.com" },
      ];
    case 'date':
    case 'date-time':
      return [
        { id: 'fmt-date-invalid', label: 'Invalid date string', value: '9999-99-99' },
        { id: 'fmt-date-epoch-neg', label: 'Negative epoch timestamp', value: -1 },
        { id: 'fmt-date-far-future', label: 'Far-future date', value: '9999-12-31' },
        { id: 'fmt-date-string', label: '"not-a-date" string', value: 'not-a-date' },
        { id: 'fmt-date-zero', label: 'Epoch zero string', value: '0000-00-00T00:00:00Z' },
      ];
    case 'uuid':
      return [
        { id: 'fmt-uuid-invalid', label: 'Malformed UUID', value: 'not-a-uuid' },
        { id: 'fmt-uuid-empty', label: 'Empty UUID', value: '' },
        { id: 'fmt-uuid-zeros', label: 'All-zero UUID', value: '00000000-0000-0000-0000-000000000000' },
        { id: 'fmt-uuid-sql', label: "SQL injection in UUID field", value: "'; DROP TABLE users;--" },
      ];
    case 'uri':
    case 'url':
      return [
        { id: 'fmt-url-invalid', label: 'Invalid URL', value: 'not-a-url' },
        { id: 'fmt-url-empty', label: 'Empty URL', value: '' },
        { id: 'fmt-url-js', label: 'javascript: protocol URL', value: 'javascript:alert(1)' },
        { id: 'fmt-url-file', label: 'file:// URL', value: 'file:///etc/passwd' },
      ];
    case 'password':
      return [
        { id: 'fmt-pwd-empty', label: 'Empty password', value: '' },
        { id: 'fmt-pwd-null-byte', label: 'Password with null byte', value: 'pass\x00word' },
      ];
    case 'int32':
      return [
        { id: 'fmt-int32-overflow', label: 'INT32_MAX + 1', value: 2147483648 },
        { id: 'fmt-int32-underflow', label: 'INT32_MIN - 1', value: -2147483649 },
      ];
    case 'int64':
      return [
        { id: 'fmt-int64-overflow', label: 'INT64 overflow (as string)', value: '9223372036854775808' },
      ];
    default:
      return [];
  }
}

function resolveType(schema: JsonSchema): string {
  if (schema.type) {
    return Array.isArray(schema.type) ? (schema.type[0] ?? 'string') : schema.type;
  }
  // Infer from structure
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  // OpenAPI 3.1 nullable via anyOf: [{type: X}, {type: 'null'}]
  if (schema.anyOf) {
    const nonNull = schema.anyOf.find((s) => s.type !== 'null');
    if (nonNull) return resolveType(nonNull);
  }
  return 'string';
}

function buildDeepArray(depth: number): unknown {
  if (depth === 0) return [42];
  return [buildDeepArray(depth - 1)];
}
