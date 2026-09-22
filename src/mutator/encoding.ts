/**
 * Encoding & security mutation rules.
 *
 * Targets: string fields that may be fed into databases, file systems,
 * template engines, or serializers without sufficient sanitization.
 */

export interface EncodingMutation {
  id: string;
  label: string;
  value: string | unknown;
}

/**
 * Generate encoding/security adversarial values for string-typed fields.
 * These are applied to every string field in the request body and query params.
 */
export function encodingMutations(): EncodingMutation[] {
  return [
    // -------------------------------------------------------------------------
    // Null bytes and control characters
    // -------------------------------------------------------------------------
    {
      id: 'enc-null-byte',
      label: 'Null byte (\\x00)',
      value: '\x00',
    },
    {
      id: 'enc-null-byte-embedded',
      label: 'Null byte embedded in valid string',
      value: 'hello\x00world',
    },
    {
      id: 'enc-control-chars',
      label: 'Control characters (\\x01-\\x1f)',
      value: '\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x1f',
    },
    {
      id: 'enc-crlf',
      label: 'CRLF injection (\\r\\n)',
      value: 'value\r\nX-Injected-Header: evil',
    },

    // -------------------------------------------------------------------------
    // Unicode edge cases
    // -------------------------------------------------------------------------
    {
      id: 'enc-utf8-bom',
      label: 'UTF-8 BOM character',
      value: '\uFEFF',
    },
    {
      id: 'enc-replacement-char',
      label: 'Unicode replacement character (U+FFFD)',
      value: '\uFFFD',
    },
    {
      id: 'enc-high-surrogate',
      label: 'Unpaired UTF-16 surrogate (U+D800)',
      value: '\uD800',
    },
    {
      id: 'enc-zero-width',
      label: 'Zero-width space / joiner',
      value: '\u200B\u200D\u200C',
    },
    {
      id: 'enc-rtl-override',
      label: 'Right-to-left override character',
      value: '\u202E',
    },
    {
      id: 'enc-emoji-sequence',
      label: 'Complex emoji / ZWJ sequence',
      value: '👨‍👩‍👧‍👦🏳️‍🌈',
    },
    {
      id: 'enc-max-codepoint',
      label: 'Max unicode codepoint (U+10FFFF)',
      value: '\u{10FFFF}',
    },

    // -------------------------------------------------------------------------
    // Injection payloads (functional crashes, not XSS/SQLi exploitation)
    // -------------------------------------------------------------------------
    {
      id: 'enc-sql-or',
      label: "SQL injection fragment: ' OR '1'='1",
      value: "' OR '1'='1",
    },
    {
      id: 'enc-sql-drop',
      label: "SQL injection fragment: '; DROP TABLE users;--",
      value: "'; DROP TABLE users;--",
    },
    {
      id: 'enc-sql-comment',
      label: 'SQL comment: --',
      value: '--',
    },
    {
      id: 'enc-nosql-injection',
      label: 'NoSQL injection: {$gt: ""}',
      value: { $gt: '' },
    },
    {
      id: 'enc-nosql-where',
      label: 'NoSQL $where injection',
      value: { $where: 'function() { return true; }' },
    },
    {
      id: 'enc-template-injection',
      label: 'Server-side template injection: {{7*7}}',
      value: '{{7*7}}',
    },
    {
      id: 'enc-path-traversal',
      label: 'Path traversal: ../../etc/passwd',
      value: '../../etc/passwd',
    },
    {
      id: 'enc-path-traversal-encoded',
      label: 'Encoded path traversal: ..%2F..%2Fetc%2Fpasswd',
      value: '..%2F..%2Fetc%2Fpasswd',
    },

    // -------------------------------------------------------------------------
    // Oversized strings
    // -------------------------------------------------------------------------
    {
      id: 'enc-long-string-1mb',
      label: 'Very long string (1 MB)',
      value: 'A'.repeat(1_000_000),
    },
    {
      id: 'enc-long-string-repeated-unicode',
      label: 'Long repeated Unicode (100K chars)',
      value: '你'.repeat(100_000),
    },

    // -------------------------------------------------------------------------
    // JSON / serialization confusion
    // -------------------------------------------------------------------------
    {
      id: 'enc-json-string',
      label: 'Stringified JSON object',
      value: '{"key": "value"}',
    },
    {
      id: 'enc-json-array-string',
      label: 'Stringified JSON array',
      value: '[1, 2, 3]',
    },
    {
      id: 'enc-double-encoded',
      label: 'Double URL-encoded percent sign',
      value: '%2527',
    },
    {
      id: 'enc-xml-entity',
      label: 'XML entity expansion stub',
      value: '<!DOCTYPE foo [<!ENTITY xxe "test">]>&xxe;',
    },
  ];
}
