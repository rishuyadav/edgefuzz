# ⚡ EdgeFuzz

**Zero-config adversarial API fuzzer — static rules + optional LLM intelligence — finds unhandled 500 crashes in your REST APIs before they hit production.**

EdgeFuzz works in two modes:

- **Static mode** (default, zero cost): Fires 70+ hardcoded adversarial mutations per endpoint. No API key needed. Fast.
- **LLM-augmented mode** (opt-in): Adds LLM-generated semantic payloads and crash triage. Bring your own key.

[![CI](https://github.com/rishuyadav/edgefuzz/actions/workflows/ci.yml/badge.svg)](https://github.com/rishuyadav/edgefuzz/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/edgefuzz)](https://www.npmjs.com/package/edgefuzz)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Why EdgeFuzz?

Writing edge-case tests is tedious. Tools like Postman and unit test suites only cover the happy path. EdgeFuzz fills the gap by:

- **Finding real crashes automatically** — not just invalid-input 400s, but actual unhandled 500s
- **Working with any tech stack** — language-agnostic, output is `curl` commands that work everywhere
- **Running in seconds** — concurrent HTTP harness fires 100+ requests/second
- **Integrating with AI workflows** — MCP server mode lets AI coding agents self-audit their generated code

---

## Quick Start

```bash
# Zero-install, static mode — no API key needed
npx edgefuzz http://localhost:8080

# With LLM crash triage (auto-enabled when key is set)
OPENAI_API_KEY=sk-... npx edgefuzz http://localhost:8080

# Full LLM mode: semantic mutations + crash triage
OPENAI_API_KEY=sk-... npx edgefuzz http://localhost:8080 --llm-mutations

# Via Anthropic instead of OpenAI
ANTHROPIC_API_KEY=sk-ant-... npx edgefuzz http://localhost:8080 --llm-mutations

# Via LiteLLM proxy or any OpenAI-compatible endpoint (Ollama, Azure, etc.)
EDGEFUZZ_LLM_BASE_URL=http://localhost:4000/v1 \
OPENAI_API_KEY=<proxy-key> \
EDGEFUZZ_LLM_MODEL=claude-sonnet-4-5 \
npx edgefuzz http://localhost:8080 --llm-mutations
```

---

## How LLM is Used

EdgeFuzz uses LLMs in two distinct, optional phases. **Static rules always run regardless** — the LLM only augments.

```
┌─────────────────────────────────────────────────────────────────────┐
│                      EdgeFuzz Pipeline                              │
├─────────────────┬───────────────────────────────────────────────────┤
│  Stage 1        │  Parse OpenAPI spec (auto-discover or explicit)   │
├─────────────────┼───────────────────────────────────────────────────┤
│  Stage 2        │  Static mutations (always runs, zero API cost)    │
│  Phase A (LLM)  │  + LLM semantic mutations (--llm-mutations flag)  │
├─────────────────┼───────────────────────────────────────────────────┤
│  Stage 3        │  Concurrent HTTP execution (undici, 100+ req/s)   │
├─────────────────┼───────────────────────────────────────────────────┤
│  Stage 4        │  Crash deduplication (SHA-1 by rule family)       │
│  Phase C (LLM)  │  + LLM crash triage (auto when key present)      │
├─────────────────┼───────────────────────────────────────────────────┤
│  Stage 5        │  curl reproducers + edgefuzz-report.json          │
└─────────────────┴───────────────────────────────────────────────────┘
```

### Phase A — LLM Semantic Mutation Generation (`--llm-mutations`)

Static rules cover type-boundary and structural edge cases but can't understand your API's *business domain*. The LLM reads your endpoint schema and generates payloads that only domain knowledge can produce:

| Static rule generates | LLM generates for `POST /api/v1/orders` |
|:----------------------|:----------------------------------------|
| `quantity: MAX_INT+1` | `quantity: -5, coupon: "ADMIN_OVERRIDE"` (privilege escalation hint) |
| `quantity: null` | `quantity: 999999` (bulk order beyond inventory) |
| `coupon: ""` | `coupon: "EXPIRED2019"` (domain-aware: expired code) |
| `userId: "\x00"` | `start_date: "2030-01-01", end_date: "2020-01-01"` (chronological contradiction) |

**How it works:**
- One LLM call per endpoint (not per field) — minimal token cost
- LLM is explicitly told which categories static rules already cover — focuses on gaps
- Structured JSON output only — LLM cannot inject free text into the fuzzing pipeline
- Capped at 10 semantic mutations per endpoint
- Degrades gracefully: any LLM failure → static rules still run

### Phase C — LLM Crash Triage (automatic when key present)

After fuzzing, the LLM reads each crash's response body (which may contain stack traces, SQL errors, ORM messages) and returns structured analysis:

```json
{
  "rootCause": "sql-error",
  "confidence": 0.92,
  "notes": "The server passes the coupon field directly into an SQL query without parameterization.",
  "duplicateOf": null,
  "severityOverride": "high"
}
```

**What this provides:**
- **Root cause labels** — 14 canonical categories (`integer-overflow`, `sql-error`, `null-pointer`, `injection`, etc.) — never free text, always structured
- **Confidence score** — filters out low-confidence findings (test environment artifacts)
- **Cross-crash deduplication** — identifies when 10 different field mutations hit the same code bug, reducing noise
- **Severity override** — LLM can upgrade severity when it sees a SQL error vs. downgrade when the response body is a generic 500 with no useful information

---

## Demo Output

### Static mode
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
    └─ Reproducer: curl -i -X POST -H 'Content-Type: application/json' \
         -d '{"quantity":9223372036854775808}' 'http://localhost:8080/api/v1/orders'
```

### LLM-augmented mode (`--llm-mutations`)
```
 EdgeFuzz v1.0.0  |  target: http://localhost:8080  |  LLM✓ +24 semantic
─────────────────────────────────────────────────────────────────────────
 Progress  ████████████████████  444/444 (100%)
─────────────────────────────────────────────────────────────────────────
 ✗ Found 3 unique crashes (+1 duplicate root cause):

 1. POST /api/v1/orders  [LLM payload]
    ├─ Mutation   [LLM] Expired promotional coupon code
    ├─ Result     HTTP 500  severity: high (LLM override)
    ├─ Root cause sql-error  (confidence: 91%)
    ├─ Analysis   The server passes the coupon field directly into an SQL
    │             query without validation, causing a parse error on special chars.
    └─ Reproducer: curl -i -X POST -d '{"quantity":1,"coupon":"EXPIRED'\''19"}' ...
```

---

## Installation

```bash
# Zero-install (recommended)
npx edgefuzz http://localhost:8080

# Global
npm install -g edgefuzz
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
  --llm <provider>       LLM provider: "openai" or "anthropic"
  --llm-model <model>    Override the LLM model name
  --llm-base-url <url>   Custom LLM API base URL (LiteLLM, Ollama, Azure, etc.)
  --llm-mutations        Enable LLM semantic mutations (Phase A). Requires key.
  --no-triage            Disable LLM crash triage (Phase C)
  -h, --help             Display help
```

### LLM Modes

| Mode | Command | What runs |
|:-----|:--------|:----------|
| Static only | `edgefuzz http://localhost:8080` | 70+ hardcoded rules, no key needed |
| + Triage | `OPENAI_API_KEY=... edgefuzz ...` | Static + LLM crash analysis |
| + Mutations | `OPENAI_API_KEY=... edgefuzz ... --llm-mutations` | Static + LLM payloads + triage |
| Anthropic | `ANTHROPIC_API_KEY=... edgefuzz ...` | Same as above via Anthropic |
| Proxy / LiteLLM | `EDGEFUZZ_LLM_BASE_URL=... edgefuzz ...` | Any OpenAI-compatible endpoint |

---

## Environment Variables

| Variable | Description |
|:---------|:------------|
| `OPENAI_API_KEY` | Enable LLM features via OpenAI (`gpt-4o-mini` default) |
| `ANTHROPIC_API_KEY` | Enable LLM features via Anthropic (`claude-3-5-haiku` default) |
| `EDGEFUZZ_LLM_MODEL` | Override default model name (e.g. `gpt-4o`, `claude-sonnet-4-5`) |
| `EDGEFUZZ_LLM_BASE_URL` | Custom LLM API base URL — point at LiteLLM, Ollama, Azure OpenAI, or any OpenAI-compatible proxy. When set, `OPENAI_API_KEY` is used as the proxy token. |

---

## What EdgeFuzz Tests (Static Rules)

### Type Boundary Mutations
- `MAX_INT + 1` / `MIN_INT - 1` (integer overflow/underflow)
- Float where integer expected, NaN, Infinity
- Null in non-nullable fields, empty string, whitespace-only
- Values violating `minimum`/`maximum`/`minLength`/`maxLength` schema bounds
- Enum violations (value outside declared enum set)

### Structural Mutations
- Empty body `{}`, null body, array/string/integer instead of object
- Missing required fields (each individually — isolates which field breaks the server)
- All fields set to null simultaneously
- Deeply nested objects (depth 100), oversized payloads (~1MB)
- Extra unknown fields, `__proto__` pollution attempt
- Wrong Content-Type headers (form-encoded, text/plain, XML to JSON endpoints)

### Encoding & Security Mutations
- Null bytes (`\x00`, embedded in strings)
- Unicode edge cases (surrogates, BOM, RTL override, ZWJ sequences)
- CRLF injection, SQL/NoSQL injection fragments
- Server-side template injection (`{{7*7}}`)
- Path traversal (`../../etc/passwd`, encoded variant)
- Oversized strings (1MB ASCII, 100K Unicode)

### Format Violations
- Invalid emails, malformed UUIDs, out-of-range dates
- `file://` and `javascript:` URIs in URL fields

---

## Report Format

`edgefuzz-report.json` — structured, machine-readable:

```json
{
  "version": "1",
  "generatedAt": "2024-01-15T10:30:00.000Z",
  "target": "http://localhost:8080",
  "llmEnabled": true,
  "summary": {
    "totalRequests": 444,
    "totalEndpoints": 18,
    "totalCrashes": 3,
    "totalDuplicates": 1,
    "llmMutations": 24,
    "durationMs": 3200,
    "requestsPerSecond": 138
  },
  "crashes": [
    {
      "id": "a3f8c1d2e4b5",
      "severity": "medium",
      "llmSeverity": "high",
      "mutationSource": "llm",
      "mutationCategory": "semantic",
      "mutationLabel": "[LLM] Expired promotional coupon code",
      "rootCause": "sql-error",
      "confidence": 0.91,
      "triageNotes": "The server passes the coupon field directly into SQL without sanitization.",
      "duplicateOf": null,
      "statusCode": 500,
      "curlReproducer": "curl -i -X POST ..."
    }
  ]
}
```

---

## MCP Server Mode (AI Agent Integration)

```bash
edgefuzz --mcp
```

Add to Claude Desktop / OpenCode config:

```json
{
  "mcpServers": {
    "edgefuzz": {
      "command": "npx",
      "args": ["edgefuzz@latest", "--mcp"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|:-----|:------------|
| `edgefuzz_audit` | Full API audit — returns Markdown report with crash details, root causes, and curl reproducers |
| `edgefuzz_quick_check` | Targeted audit of a single endpoint path |

The MCP response includes LLM triage fields (`rootCause`, `confidence`, `triageNotes`) which give the AI agent the information it needs to locate and fix the bug in the codebase.

---

## CI/CD Integration

```yaml
- name: Run EdgeFuzz Audit
  run: |
    npx edgefuzz@latest \
      http://localhost:8080 \
      http://localhost:8080/openapi.json \
      --ci \
      --output edgefuzz-report.json
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}  # optional, enables triage
```

Exit code 1 if crashes found → PR is blocked. See [`.github/workflows/edgefuzz-action.yml`](.github/workflows/edgefuzz-action.yml) for the full example.

---

## Architecture

**5-stage pipeline:**

| Stage | Module | Description |
|:------|:-------|:------------|
| 1. Ingest | `src/parser/openapi.ts` | Parse OpenAPI 3.x, auto-discover on localhost |
| 2. Mutate | `src/mutator/` | Static rules + optional LLM semantic mutations |
| 3. Execute | `src/runner/executor.ts` | Concurrent HTTP (undici + p-limit) |
| 4. Analyze | `src/analyzer/` | Dedup + optional LLM triage (root cause, confidence, cross-crash dedup) |
| 5. Report | `src/reporter/` | curl reproducers + JSON report |

---

## Contributing

PRs welcome. High-impact areas:

- **New static mutation rules** — add to `src/mutator/type-boundary.ts` or `encoding.ts`
- **GraphQL support** — add `src/parser/graphql.ts`
- **Integration tests** — test against a minimal Express server fixture
- **LLM prompt tuning** — improve semantic mutation diversity or triage accuracy

```bash
git clone https://github.com/rishuyadav/edgefuzz.git
cd edgefuzz && npm install && npm run build
node dist/cli/index.js --help
```

---

## License

MIT © [Rishu Yadav](https://github.com/rishuyadav)
