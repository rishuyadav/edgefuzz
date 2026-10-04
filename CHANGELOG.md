# Changelog

All notable changes to EdgeFuzz are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.2.0] — 2026-09-28

### Added
- `--auth-command <cmd>` — shell command that prints a bearer token; re-executed automatically on 401 to handle expiring tokens (OAuth, short-lived JWTs)
- `--tls-insecure` — skip TLS certificate verification for self-signed certs in dev/staging environments
- `--delay <ms>` — fixed delay between requests to prevent rate limiting
- `--no-response-validation` — crash-only mode; skip response schema contract checks for faster runs
- `--triage` — opt-in LLM crash triage after fuzzing: root cause labels, confidence scores, cross-crash deduplication, severity overrides. Zero LLM calls on clean audits.
- Response contract validation (on by default): detects `missing-required-field`, `wrong-type`, `error-body-leaked`, `undocumented-status`, `empty-success-body`
- Data leakage detection: 16 patterns — JS/Python/Java/PHP/Ruby stack traces, Sequelize/TypeORM/Prisma/MongoDB/ActiveRecord ORM errors, connection strings

### Fixed
- `response_format: json_object` stripped when `llmBaseUrl` is set (LiteLLM proxy compatibility)
- LiteLLM/Claude responses wrapped in markdown fences (`\`\`\`json`) now parsed correctly
- OpenAPI 3.0.4 specs now produce a clear, actionable error instead of a cryptic parse failure
- HTTP 0 false positives from oversized path param mutations (`enc-long-string-1mb`, `enc-long-string-repeated-unicode`) — these now correctly excluded from crash classification
- `error-body-leaked` false positives on .NET ModelState validation errors — `password`/`secret`/`connectionString` patterns now require a quoted string value of 6+ chars

### Changed
- LLM triage changed from automatic (when key present) to explicit opt-in (`--triage` flag) — prevents unexpected LLM calls and token costs

---

## [1.1.0] — 2026-09-20

### Added
- `--demo` — zero-setup demo mode: starts a built-in vulnerable Course Catalog API and immediately fuzzes it. No server, no spec, no API key required.
- `--spec <path>` — explicit spec path or URL (previously positional argument only)
- Auto-discovery of OpenAPI spec at common paths: `/openapi.json`, `/openapi.yaml`, `/swagger.json`, `/swagger.yaml`, `/api-docs`, `/api/openapi.json`
- CI exit code: exits with code 1 when crashes are found (PR gate compatible)
- LiteLLM / OpenAI-compatible proxy support via `EDGEFUZZ_LLM_BASE_URL` and `--llm-base-url`
- `--include` / `--exclude` path prefix filters

### Fixed
- `--ci` flag now auto-detected when stdout is not a TTY (GitHub Actions always uses CI mode)

---

## [1.0.0] — 2026-09-14

### Added
- Initial release
- OpenAPI 3.x spec parsing
- 70+ static adversarial mutations: type boundary, structural, encoding/security, format violations
- Concurrent HTTP fuzzing harness (undici + p-limit, 100+ req/s)
- Crash deduplication by SHA-1 rule family hash
- `curl` reproducer generation for every crash
- `edgefuzz-report.json` machine-readable report
- Live TUI dashboard (Ink/React) with progress bar and crash stream
- CI plain-text mode (auto-detected from TTY)
- Optional LLM semantic mutations (`--llm-mutations`) via OpenAI or Anthropic
- MCP server mode (`--mcp`) for AI coding agent integration
- MIT license
