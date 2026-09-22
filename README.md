# ⚡ EdgeFuzz

**Zero-config adversarial API fuzzer that finds unhandled 500 crashes in your REST APIs before they hit production.**

EdgeFuzz automatically generates hundreds of adversarial edge-case payloads from your OpenAPI spec and fires them at your local server — catching `NullPointerExceptions`, integer overflows, encoding crashes, and structural panics in seconds, not weeks.

[![CI](https://github.com/rishuyadav/edgefuzz/actions/workflows/ci.yml/badge.svg)](https://github.com/rishuyadav/edgefuzz/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/edgefuzz)](https://www.npmjs.com/package/edgefuzz)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Why EdgeFuzz?

Writing edge-case tests is tedious. Tools like Postman and unit test suites only cover the happy path. EdgeFuzz fills the gap by:

- **Finding real crashes automatically** — not just invalid-input 400s, but actual unhandled 500s your server throws
- **Working with any tech stack** — language-agnostic, output is `curl` commands that work everywhere
- **Running in seconds** — concurrent HTTP harness fires 100+ requests/second
- **Integrating with AI workflows** — runs as an MCP server so AI coding agents can self-audit their generated code

---

## Quick Start

```bash
# Zero-install: just point at your running server
npx edgefuzz http://localhost:8080

# With an explicit spec file
npx edgefuzz http://localhost:3000 ./openapi.yaml

# Auto-discovers /openapi.json on common ports if no spec given
npx edgefuzz http://localhost:8080
```

**That's it.** EdgeFuzz will:
1. Discover and parse your OpenAPI spec
2. Generate ~30-50 adversarial mutations per endpoint
3. Fire them all concurrently at your server
4. Print a live TUI dashboard with real-time crash detection
5. Write `edgefuzz-report.json` with `curl` reproducers for every crash

---

## Demo Output

```
 EdgeFuzz v1.0.0  |  target: http://localhost:8080
─────────────────────────────────────────────────────────
 Progress  ████████████████████  420/420 (100%)
 Speed     138 req/s    Elapsed  3.0s
─────────────────────────────────────────────────────────
 ✗ Found 2 unhandled crashes:

 1. POST /api/v1/orders
    ├─ Mutation   Field "quantity": MAX_INT + 1 (64-bit overflow)
    ├─ Result     HTTP 500  severity: medium
    ├─ Category   type-boundary
    └─ Reproducer:
       curl -i -X POST -H 'Content-Type: application/json' \
         -d '{"quantity":9223372036854775808,"coupon":null}' \
         'http://localhost:8080/api/v1/orders'

 2. PUT /api/v1/user/profile
    ├─ Mutation   Encoding "bio": Null byte (\x00)
    ├─ Result     HTTP 500  severity: high
    ├─ Category   encoding
    └─ Reproducer:
       curl -i -X PUT -H 'Content-Type: application/json' \
         -d '{"bio":"\u0000"}' \
         'http://localhost:8080/api/v1/user/profile'

─────────────────────────────────────────────────────────
 Report written to: edgefuzz-report.json
```

---

## Installation

```bash
# Temporary: use without installing
npx edgefuzz http://localhost:8080

# Global install
npm install -g edgefuzz

# Then run
edgefuzz http://localhost:8080
```

---

## Usage

```
Usage: edgefuzz [options] [target-url] [spec-path]

Arguments:
  target-url             Base URL of the running API server
  spec-path              Path or URL to OpenAPI 3.x spec (auto-discovered if omitted)

Options:
  -V, --version          Output the version number
  --mcp                  Start as an MCP server (for AI coding agents)
  -c, --concurrency <n>  Max concurrent requests (default: 20)
  -t, --timeout <ms>     Per-request timeout in milliseconds (default: 5000)
  -o, --output <path>    Report output path (default: edgefuzz-report.json)
  --no-report            Skip writing the JSON report file
  --ci                   CI mode: plain text output, no TUI
  -H, --header <header>  Add a request header. Repeatable.
  --include <paths>      Only fuzz paths matching this prefix (comma-separated)
  --exclude <paths>      Skip paths matching this prefix (comma-separated)
  --llm <provider>       LLM for fix suggestions: "openai" or "anthropic"
  --llm-model <model>    Override the LLM model name
  -h, --help             Display help
```

### Examples

```bash
# Fuzz with authentication
edgefuzz http://localhost:8080 -H "Authorization: Bearer my-token"

# Only audit /api/v1 endpoints
edgefuzz http://localhost:8080 --include /api/v1

# CI mode — exits with code 1 if crashes found
edgefuzz http://localhost:8080 --ci

# High concurrency (be careful with rate limits)
edgefuzz http://localhost:8080 -c 50

# With LLM fix suggestions (requires API key)
OPENAI_API_KEY=sk-... edgefuzz http://localhost:8080

# Use Anthropic instead
ANTHROPIC_API_KEY=sk-ant-... edgefuzz http://localhost:8080
```

---

## Environment Variables

| Variable | Description |
|:---------|:------------|
| `OPENAI_API_KEY` | Enable AI fix suggestions via OpenAI (uses `gpt-4o-mini` by default) |
| `ANTHROPIC_API_KEY` | Enable AI fix suggestions via Anthropic (uses `claude-3-5-haiku` by default) |
| `EDGEFUZZ_LLM_MODEL` | Override the default LLM model name |

---

## What EdgeFuzz Tests

### Type Boundary Mutations
- `MAX_INT + 1` / `MIN_INT - 1` (integer overflow/underflow)
- Float where integer expected
- Boolean coercion (`true`/`"true"`/`1`)
- Null in non-nullable fields
- Strings where numbers expected
- Values violating `minimum`/`maximum`/`minLength`/`maxLength` schema bounds

### Structural Mutations
- Empty body `{}`
- Null body
- Array instead of object
- Missing required fields (one by one)
- All fields set to null
- Extra unknown fields (`__proto__` pollution)
- Deeply nested objects (depth 100)
- Oversized payloads (~1MB)
- Wrong Content-Type headers

### Encoding & Security Mutations
- Null bytes (`\x00`, `\x00` embedded in strings)
- Unicode edge cases (surrogates, BOM, RTL override, ZWJ emoji sequences)
- CRLF injection
- SQL injection fragments (`' OR '1'='1`, `'; DROP TABLE users;--`)
- NoSQL injection (`$gt`, `$where`)
- Server-side template injection (`{{7*7}}`)
- Path traversal (`../../etc/passwd`)
- Oversized strings (1MB)

### Format Violations
- Invalid emails, malformed UUIDs
- Out-of-range dates (`9999-99-99`)
- `file://` and `javascript:` URIs
- Password fields with null bytes

---

## Report Format

`edgefuzz-report.json` is a structured, machine-readable report:

```json
{
  "version": "1",
  "generatedAt": "2024-01-15T10:30:00.000Z",
  "target": "http://localhost:8080",
  "specSource": "http://localhost:8080/openapi.json",
  "summary": {
    "totalRequests": 420,
    "totalEndpoints": 18,
    "totalCrashes": 2,
    "durationMs": 3050,
    "requestsPerSecond": 137
  },
  "crashes": [
    {
      "id": "a3f8c1d2e4b5",
      "severity": "medium",
      "endpoint": { "method": "POST", "path": "/api/v1/orders" },
      "mutationLabel": "Field \"quantity\": MAX_INT + 1 (64-bit overflow)",
      "mutationCategory": "type-boundary",
      "statusCode": 500,
      "latencyMs": 12,
      "timedOut": false,
      "triggeringPayload": { "quantity": 9223372036854775808 },
      "curlReproducer": "curl -i -X POST ...",
      "llmFixSuggestion": "The server is not validating integer bounds before passing to the database..."
    }
  ]
}
```

### Severity Levels

| Severity | Condition |
|:---------|:----------|
| `critical` | Server hang/timeout or network-level crash |
| `high` | 500 from encoding or security mutation (potential injection surface) |
| `medium` | 500 from type-boundary or structural mutation (logic error) |

---

## MCP Server Mode (AI Agent Integration)

EdgeFuzz can run as an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server, exposing its fuzzing engine as a tool that AI coding agents can call directly.

### Setup

```bash
# Start the MCP server
edgefuzz --mcp
```

Add to your AI agent's MCP config (e.g., Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "edgefuzz": {
      "command": "npx",
      "args": ["edgefuzz", "--mcp"]
    }
  }
}
```

Or for **OpenCode** (`.opencode/config.json`):

```json
{
  "mcp": {
    "edgefuzz": {
      "command": "npx",
      "args": ["edgefuzz@latest", "--mcp"]
    }
  }
}
```

### Available MCP Tools

#### `edgefuzz_audit`
Full API audit against an OpenAPI spec.

```
Parameters:
  target_url     (required) Base URL of the running API
  spec_url       (optional) URL or path to OpenAPI spec
  concurrency    (optional) Max concurrent requests, default 10
  timeout_ms     (optional) Per-request timeout, default 5000
  include_paths  (optional) Array of path prefixes to include
  exclude_paths  (optional) Array of path prefixes to exclude
  headers        (optional) Additional request headers
```

#### `edgefuzz_quick_check`
Targeted audit of a single endpoint path.

```
Parameters:
  target_url  (required) Base URL
  spec_url    (required) URL or path to OpenAPI spec
  path        (required) Endpoint path, e.g. /api/v1/users/{id}
  method      (optional) HTTP method filter
  concurrency (optional) default 5
  headers     (optional) Additional request headers
```

### Example AI Workflow

When you ask an AI agent to build a new API endpoint:

1. Agent generates the endpoint code
2. Agent calls `edgefuzz_quick_check` with the new endpoint path
3. EdgeFuzz fires adversarial payloads at the running server
4. If crashes are found, the agent reads the crash report and fixes the code
5. Re-runs until zero crashes — **shipping resilient code automatically**

---

## CI/CD Integration

```yaml
# .github/workflows/api-audit.yml
- name: Run EdgeFuzz Audit
  run: |
    npx edgefuzz@latest \
      http://localhost:8080 \
      http://localhost:8080/openapi.json \
      --ci \
      --output edgefuzz-report.json
  # Exits with code 1 if crashes found — blocks the PR

- name: Upload Report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: edgefuzz-report
    path: edgefuzz-report.json
```

See [`.github/workflows/edgefuzz-action.yml`](.github/workflows/edgefuzz-action.yml) for a complete example.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│             EdgeFuzz Core Engine            │
│  (Schema Parser + Smart Mutator + Fuzzer)   │
└──────────────────────┬──────────────────────┘
                       │
     ┌─────────────────┼──────────────────┐
     ▼                 ▼                  ▼
┌──────────┐    ┌──────────────┐   ┌──────────────┐
│ CLI/NPX  │    │  MCP Server  │   │ GitHub Action│
│ edgefuzz │    │ --mcp flag   │   │ CI/CD gate   │
└──────────┘    └──────────────┘   └──────────────┘
```

**5-stage pipeline:**

| Stage | Module | Description |
|:------|:-------|:------------|
| 1. Ingest | `src/parser/openapi.ts` | Parse OpenAPI 3.x spec, auto-discover on localhost |
| 2. Mutate | `src/mutator/` | Generate adversarial payload matrix |
| 3. Execute | `src/runner/executor.ts` | Concurrent HTTP harness (undici + p-limit) |
| 4. Analyze | `src/analyzer/crash.ts` | Classify and deduplicate 5xx findings |
| 5. Report | `src/reporter/` | `curl` reproducers, JSON report, optional LLM |

---

## Contributing

PRs welcome! Areas that would have the most impact:

- **New mutation rules** — add to `src/mutator/type-boundary.ts` or `encoding.ts`
- **GraphQL support** — add `src/parser/graphql.ts` and wire into `engine.ts`
- **Test harness** — integration tests against a simple Express server
- **Rate limiting** — smart backoff when the target returns 429

```bash
git clone https://github.com/rishuyadav/edgefuzz.git
cd edgefuzz
npm install
npm run build
node dist/cli/index.js --help
```

---

## License

MIT © [Rishu Yadav](https://github.com/rishuyadav)
