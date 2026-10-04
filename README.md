# ⚡ EdgeFuzz

**Adversarial API fuzzer that finds unhandled 500 crashes in your REST APIs before they hit production.**

Point it at any OpenAPI 3.x server — no config files, no API key, no setup. Fires 70+ adversarial mutations per endpoint and gives you `curl` commands that reproduce every crash.

[![npm](https://img.shields.io/npm/v/edgefuzz)](https://www.npmjs.com/package/edgefuzz)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![EdgeFuzz demo](media/demo.gif)

---

## Quickstart

> **Requires:** Node.js 18+. First run downloads ~15 MB of dependencies (~20s); subsequent runs are instant.

### Try it right now — no server needed

```bash
npx edgefuzz --demo
```

This starts a built-in vulnerable Course Catalog API, fuzzes it, and shows you real crashes in ~5 seconds. Zero setup.

---

### Fuzz your own API

Your server needs to expose an [OpenAPI 3.x](https://swagger.io/specification/) spec. EdgeFuzz auto-discovers it at common paths (`/openapi.json`, `/swagger.json`, etc.).

```bash
# Auto-discover spec (checks /openapi.json, /swagger.json, and more)
npx edgefuzz http://localhost:8080

# Provide the spec explicitly (skip auto-discovery)
npx edgefuzz http://localhost:8080 --spec ./openapi.yaml
npx edgefuzz http://localhost:8080 --spec http://localhost:8080/api-docs

# Add LLM semantic mutations (domain-aware payloads)
OPENAI_API_KEY=sk-... npx edgefuzz http://localhost:8080 --llm-mutations

# Add LLM crash triage (root cause + severity after fuzzing)
OPENAI_API_KEY=sk-... npx edgefuzz http://localhost:8080 --triage

# Full LLM mode: semantic mutations + crash triage
OPENAI_API_KEY=sk-... npx edgefuzz http://localhost:8080 --llm-mutations --triage

# Via Anthropic
ANTHROPIC_API_KEY=sk-ant-... npx edgefuzz http://localhost:8080 --llm-mutations --triage

# Via LiteLLM proxy or any OpenAI-compatible endpoint (Ollama, Azure, etc.)
EDGEFUZZ_LLM_BASE_URL=http://localhost:4000/v1 \
OPENAI_API_KEY=<proxy-key> \
EDGEFUZZ_LLM_MODEL=claude-sonnet-4-5 \
npx edgefuzz http://localhost:8080 --llm-mutations --triage
```

**Output:** A live TUI progress bar, crash details with `curl` reproducers, and `edgefuzz-report.json`. Exits with code 1 if crashes are found — CI-friendly.

> **Don't have an OpenAPI spec?** EdgeFuzz requires one to know what to fuzz. If your server doesn't expose one, use `--demo` to explore the tool, or add OpenAPI generation to your framework ([Express](https://www.npmjs.com/package/swagger-autogen), [FastAPI](https://fastapi.tiangolo.com/tutorial/first-steps/), [Rails](https://github.com/rswag/rswag), etc.).

---

## Why EdgeFuzz?

Writing edge-case tests is tedious. Tools like Postman and unit test suites only cover the happy path. EdgeFuzz fills the gap by:

- **Finding real crashes automatically** — not just invalid-input 400s, but actual unhandled 500s
- **Working with any tech stack** — language-agnostic; output is `curl` commands that work everywhere
- **Running in seconds** — concurrent HTTP harness fires 100+ requests/second
- **Integrating with AI workflows** — MCP server mode lets AI coding agents self-audit their generated code

---

## How LLM Features Work

EdgeFuzz uses LLMs in two optional phases. **Static rules always run regardless** — the LLM only augments.

```
┌─────────────────────────────────────────────────────────────────────┐
│                      EdgeFuzz Pipeline                              │
├─────────────────┬───────────────────────────────────────────────────┤
│  Stage 1        │  Parse OpenAPI spec (auto-discover or --spec)     │
├─────────────────┬───────────────────────────────────────────────────┤
│  Stage 2        │  Static mutations (always runs, zero API cost)    │
│  LLM Phase 1    │  + LLM semantic mutations (--llm-mutations flag)  │
├─────────────────┼───────────────────────────────────────────────────┤
│  Stage 3        │  Concurrent HTTP execution (undici, 100+ req/s)   │
├─────────────────┼───────────────────────────────────────────────────┤
│  Stage 4        │  Crash deduplication (SHA-1 by rule family)       │
│  LLM Phase 2    │  + LLM crash triage (--triage flag, opt-in)      │
├─────────────────┼───────────────────────────────────────────────────┤
│  Stage 5        │  curl reproducers + edgefuzz-report.json          │
└─────────────────┴───────────────────────────────────────────────────┘
```

### LLM Phase 1 — Semantic Mutation Generation (`--llm-mutations`)

Static rules cover type-boundary and structural edge cases but can't understand your API's *business domain*. The LLM reads your endpoint schema and generates payloads that only domain knowledge can produce:

| Static rule generates | LLM generates for `POST /api/v1/orders` |
|:----------------------|:----------------------------------------|
| `quantity: MAX_INT+1` | `quantity: -5, coupon: "ADMIN_OVERRIDE"` (privilege escalation hint) |
| `quantity: null` | `quantity: 999999` (bulk order beyond inventory) |
| `coupon: ""` | `coupon: "EXPIRED2019"` (domain-aware: expired code) |
| `userId: "\x00"` | `start_date: "2030-01-01", end_date: "2020-01-01"` (chronological contradiction) |

**How it works:**
- One LLM call per endpoint (not per field) — minimal token cost
- LLM is told which categories static rules already cover — focuses on gaps
- Structured JSON output only — LLM cannot inject free text into the fuzzing pipeline
- Capped at 10 semantic mutations per endpoint
- Degrades gracefully: any LLM failure → static rules still run

### LLM Phase 2 — Crash Triage (`--triage`)

After fuzzing completes, pass `--triage` to have the LLM read each crash's response body (stack traces, SQL errors, ORM messages) and return structured analysis. This is opt-in and only runs if crashes were found — zero LLM calls on a clean audit.

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
- **Cross-crash deduplication** — identifies when 10 different field mutations hit the same code bug
- **Severity override** — LLM can upgrade severity based on reading the stack trace

---

## Demo Output

Run `npx edgefuzz --demo` to see this live. With an LLM key set, the demo auto-enables semantic mutations and crash triage to showcase the full pipeline.

### Static mode (no key needed)
```
⚡ EdgeFuzz Demo Mode  [static mode]
  Starting built-in vulnerable Course Catalog API...
  Tip: set OPENAI_API_KEY or ANTHROPIC_API_KEY to see LLM features.
  Running at http://127.0.0.1:54321
  Fuzzing now — this takes ~5 seconds

⚡ EdgeFuzz  |  http://127.0.0.1:54321  |  static-only mode
██████████████████████████████  100%  375/375
Speed  142 req/s    Elapsed  2.6s    Crashes  8

✗ Found 8 crashes:

1. POST /courses
   ├─ Mutation   Field "capacity": MAX_INT + 1 (64-bit overflow)
   ├─ Result     HTTP 500  severity: medium
   └─ Reproducer: curl -i -X POST -H 'Content-Type: application/json' \
        -d '{"title":"x","instructor":"x","capacity":9223372036854775808,"price":10}' \
        'http://127.0.0.1:54321/courses'

2. POST /enroll
   ├─ Mutation   Field "userId": null value
   ├─ Result     HTTP 500  severity: high
   └─ Reproducer: curl -i -X POST -H 'Content-Type: application/json' \
        -d '{"courseId":1,"userId":null}' 'http://127.0.0.1:54321/enroll'
```

### LLM-augmented mode (`OPENAI_API_KEY=sk-... npx edgefuzz --demo`)

With a key set, the demo auto-enables `--llm-mutations` and `--triage`:

```
⚡ EdgeFuzz Demo Mode  [LLM mode]
  LLM key detected — semantic mutations + crash triage auto-enabled.
  Starting built-in vulnerable Course Catalog API...
  Running at http://127.0.0.1:54321
  Fuzzing now — this takes ~15 seconds

  Generating semantic mutations via LLM for 7 endpoints...

⚡ EdgeFuzz  |  http://127.0.0.1:54321  |  LLM✓  +42 semantic
██████████████████████████████  100%  417/417
Speed  138 req/s    Elapsed  3.0s    Crashes  9

  Triaging 9 crashes — classifying root causes + grouping duplicates...

✗ Found 9 crashes (2 duplicates grouped):

1. POST /enroll  [LLM payload]
   ├─ Mutation   [LLM] Realistic promo code: "FREESHIP" applied at enrollment
   ├─ Result     HTTP 500  severity: high
   ├─ Root cause unhandled-exception  (confidence: 96%)
   ├─ Analysis   DiscountEngine crashes on alphabetic promo codes — the lookup
   │             service times out and the exception propagates unhandled.
   └─ Reproducer: curl -i -X POST -H 'Content-Type: application/json' \
        -d '{"courseId":1,"userId":"user-1","promoCode":"FREESHIP"}' \
        'http://127.0.0.1:54321/enroll'

2. POST /courses
   ├─ Mutation   Field "capacity": MAX_INT + 1 (64-bit overflow)
   ├─ Result     HTTP 500  severity: medium
   ├─ Root cause integer-overflow  (confidence: 99%)
   ├─ Analysis   Server performs arithmetic on capacity without bounds checking.
   └─ Reproducer: curl -i -X POST -H 'Content-Type: application/json' \
        -d '{"title":"x","instructor":"x","capacity":9223372036854775808,"price":10}' \
        'http://127.0.0.1:54321/courses'
```

The `[LLM payload]` crash (`promoCode: "FREESHIP"`) is **only found with `--llm-mutations`**. Static rules send `""`, `null`, `"\x00"` — never a plausible promo code string. The LLM understands the field semantics from the schema description and generates domain-realistic values that expose the bug.

---

## Installation

```bash
# Zero-install (recommended)
npx edgefuzz --demo

# Or point at your server directly
npx edgefuzz http://localhost:8080

# Global install
npm install -g edgefuzz
```

---

## Usage

```
Usage: edgefuzz [options] [target-url]

Arguments:
  target-url                    Base URL of the running API server

Options:
  -V, --version                 Output the version number
  --demo                        Start the built-in demo API and fuzz it (no setup needed)
  --spec <path>                 Path or URL to OpenAPI 3.x spec (auto-discovered if omitted)
  --mcp                         Start as an MCP server (for AI coding agents)
  -c, --concurrency <n>         Max concurrent requests (default: 20)
  -t, --timeout <ms>            Per-request timeout in milliseconds (default: 5000)
  -o, --output <path>           Report output path (default: edgefuzz-report.json)
  --no-report                   Skip writing the JSON report file
  --ci                          Force CI mode: plain text output, no TUI
                                (auto-detected when stdout is not a TTY)
  -H, --header <header>         Add a request header (repeatable)
  --auth-command <cmd>          Shell command that prints a bearer token.
                                Re-run automatically on 401 to handle expiry.
  --tls-insecure                Skip TLS certificate verification (self-signed certs)
  --delay <ms>                  Delay between requests — prevents rate limiting
  --no-response-validation      Disable response schema validation (crash-only mode)
  --include <paths>             Only fuzz paths matching this prefix (comma-separated)
  --exclude <paths>             Skip paths matching this prefix (comma-separated)
  --llm <provider>              LLM provider: "openai" or "anthropic"
  --llm-model <model>           Override the LLM model name
  --llm-base-url <url>          Custom LLM API base URL (LiteLLM, Ollama, Azure, etc.)
  --llm-mutations               Enable LLM semantic mutations. Requires key.
  --triage                      Enable LLM crash triage after fuzzing. Requires key.
                                Only runs if crashes are found — zero calls on clean audits.
  -h, --help                    Display help
```

### Auth Examples

```bash
# OAuth client credentials (auto-refreshes on 401)
edgefuzz http://localhost:8080 \
  --auth-command 'curl -s -X POST https://auth.example.com/token \
    -d "grant_type=client_credentials&client_id=x&client_secret=y" | jq -r .access_token'

# Simple API key from env
edgefuzz http://localhost:8080 --auth-command 'echo $MY_API_KEY'

# Short-lived JWT (re-run on 401 automatically)
edgefuzz http://localhost:8080 --auth-command './scripts/get-token.sh'

# Self-signed TLS cert (dev/staging)
edgefuzz https://localhost:8443 --tls-insecure

# Rate-limited API (50ms between requests)
edgefuzz http://localhost:8080 --delay 50
```

### LLM Modes

| Mode | Command | What runs |
|:-----|:--------|:----------|
| Static only | `edgefuzz http://localhost:8080` | 70+ hardcoded rules, no key needed |
| + Triage | `OPENAI_API_KEY=... edgefuzz ... --triage` | Static rules + LLM crash analysis |
| + Mutations | `OPENAI_API_KEY=... edgefuzz ... --llm-mutations` | Static + LLM domain-aware payloads |
| Full LLM | `OPENAI_API_KEY=... edgefuzz ... --llm-mutations --triage` | Static + LLM payloads + triage |
| Anthropic | `ANTHROPIC_API_KEY=... edgefuzz ... --llm-mutations --triage` | Same via Anthropic |
| Proxy / LiteLLM | `EDGEFUZZ_LLM_BASE_URL=... edgefuzz ... --llm-mutations` | Any OpenAI-compatible endpoint |

---

## Environment Variables

| Variable | Description |
|:---------|:------------|
| `OPENAI_API_KEY` | Enable LLM features via OpenAI (`gpt-4o-mini` default) |
| `ANTHROPIC_API_KEY` | Enable LLM features via Anthropic (`claude-3-5-haiku` default) |
| `EDGEFUZZ_LLM_MODEL` | Override default model name (e.g. `gpt-4o`, `claude-sonnet-4-5`) |
| `EDGEFUZZ_LLM_BASE_URL` | Custom LLM API base URL — point at LiteLLM, Ollama, Azure OpenAI, or any OpenAI-compatible proxy. When set, `OPENAI_API_KEY` is used as the proxy token. |

---

## Response Contract Validation

When your OpenAPI spec documents response schemas, EdgeFuzz validates every response body against them. It detects:

| Violation | Severity | Description |
|:----------|:---------|:------------|
| `missing-required-field` | medium | A `required` property is absent from a 2xx response body |
| `wrong-type` | low | A field is present but has the wrong JSON type vs. the spec |
| `error-body-leaked` | **high** | A 4xx response body contains a stack trace, ORM error, SQL exception, or credential |
| `undocumented-status` | low | Server returned a status code not listed in the spec's `responses` |
| `empty-success-body` | medium | 200/201 returned an empty body when the spec defines an object/array |

Data leakage detection recognises 16 patterns including: JS/Python/Java/PHP/Ruby stack traces, Sequelize, TypeORM, Prisma, MongoDB, ActiveRecord errors, and connection strings in response bodies.

These findings appear in a `mismatches[]` array in `edgefuzz-report.json` alongside the crash findings, and in a separate summary section in CI output.

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
    "totalMismatches": 2,
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

Add to Claude Desktop / OpenCode / Cursor config:

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

The MCP response includes LLM triage fields (`rootCause`, `confidence`, `triageNotes`) so the AI agent can locate and fix the bug in the codebase.

---

## CI/CD Integration

```yaml
- name: Run EdgeFuzz Audit
  run: |
    npx edgefuzz@latest http://localhost:8080 \
      --spec http://localhost:8080/openapi.json \
      --output edgefuzz-report.json
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}  # optional: add --triage to enable LLM crash analysis
```

Exits with code 1 if crashes are found → PR is blocked. `--ci` mode is auto-detected when stdout is not a TTY (always the case in GitHub Actions). See [`.github/workflows/edgefuzz-action.yml`](.github/workflows/edgefuzz-action.yml) for the full example.

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

## Limitations

- **Requires OpenAPI 3.x** — Swagger 2.0 / JSON Schema specs are not supported. Use [swagger2openapi](https://www.npmjs.com/package/swagger2openapi) to convert.
- **REST / HTTP only** — no GraphQL, gRPC, WebSocket, or GraphQL subscriptions support.
- **Stateless requests** — EdgeFuzz fires each mutation independently. It cannot chain requests (e.g. create → update → delete) or maintain session state between calls.
- **No Swagger 3.0.4+ strict validation** — OpenAPI 3.0.4 parses with a graceful warning; use 3.0.0–3.0.3 for strict spec compliance.
- **Self-reported crashes only** — EdgeFuzz detects what the server tells it (5xx, timeouts, network errors). Bugs that silently corrupt data and return 200 are out of scope.
- **LLM features require a key** — `--triage` and `--llm-mutations` degrade gracefully to static-only mode if no key is found.

---

## Troubleshooting

**Got 0 crashes on an API I know is buggy?**
- Check that your server is actually returning 5xx and not swallowing errors into 200/400 responses.
- Run with `--no-response-validation` to see if mismatches are being counted instead.
- Some servers return 422 for invalid input — that's expected behaviour, not a crash. EdgeFuzz counts 5xx / timeouts / network errors only.
- If the spec has very strict `enum` or `format` constraints, your server may reject invalid inputs at the validation layer before crashing. This is actually good — it means your server has input validation!

**Spec auto-discovery failed / parse error on startup?**
- Provide the spec explicitly: `--spec ./path/to/openapi.yaml` or `--spec http://localhost:8080/openapi.json`
- Auto-discovery tries: `/openapi.json`, `/openapi.yaml`, `/swagger.json`, `/swagger.yaml`, `/api-docs`, `/api/openapi.json`
- If you get a parse error, check the OpenAPI version — EdgeFuzz requires 3.x. Use `swagger2openapi` to convert from Swagger 2.0.

**All requests are timing out?**
- Increase the timeout: `--timeout 15000` (15 seconds)
- Reduce concurrency: `--concurrency 5`
- Check that your server is actually running and reachable at the target URL
- If behind a rate limiter: `--delay 200` adds 200ms between each request

**LLM features not activating?**
- `--llm-mutations` and `--triage` both require an API key set in the environment (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`).
- LLM errors are non-fatal — EdgeFuzz logs a warning and falls back to static-only mode. Check stderr for the exact error.
- For LiteLLM / proxy: set `EDGEFUZZ_LLM_BASE_URL` and use `OPENAI_API_KEY` as the proxy token.

**Getting false positive crashes (server-side rate limiting or auth errors)?**
- Add auth headers: `--header "Authorization: Bearer $TOKEN"`
- Or use `--auth-command` to auto-refresh tokens on 401.
- Use `--exclude /admin,/internal` to skip endpoints you don't have access to.
- Check `edgefuzz-report.json` — each crash includes the HTTP status code and curl reproducer so you can verify manually.

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
node dist/cli/index.js --demo   # verify end-to-end with built-in demo
```

---

## License

MIT © [Rishu Yadav](https://github.com/rishuyadav)
