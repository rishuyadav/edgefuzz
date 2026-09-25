#!/usr/bin/env node
/**
 * EdgeFuzz CLI Entry Point.
 *
 * Usage:
 *   edgefuzz <target-url> [spec-path]
 *   edgefuzz --mcp
 *   npx edgefuzz http://localhost:8080 ./openapi.json
 */

import { Command } from 'commander';
import { createRequire } from 'module';
import { render as inkRender } from 'ink';
import React from 'react';
import { runFuzzSessionStream } from '../engine.js';
import { runCiReporter } from '../tui/ci-reporter.js';
import { startMcpServer } from '../mcp/server.js';
import { Dashboard } from '../tui/dashboard.js';
import { detectLLMProvider } from '../reporter/llm.js';
import type { EdgeFuzzConfig, FuzzReport, ProgressEvent } from '../types/index.js';

// ---------------------------------------------------------------------------
// Version from package.json
// ---------------------------------------------------------------------------
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pkg = _require('../../package.json') as any;
const VERSION: string = pkg.version as string;

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('edgefuzz')
  .description(
    'Zero-config adversarial API fuzzer that finds unhandled 500 crashes in your REST APIs before they hit production.',
  )
  .version(VERSION)
  .argument('[target-url]', 'Base URL of the running API server (e.g. http://localhost:8080)')
  .argument('[spec-path]', 'Path or URL to OpenAPI 3.x spec (auto-discovered if omitted)')
  .option('--mcp', 'Start as an MCP server (for AI coding agents like Cursor / Claude / OpenCode)')
  .option('-c, --concurrency <n>', 'Max concurrent requests', '20')
  .option('-t, --timeout <ms>', 'Per-request timeout in milliseconds', '5000')
  .option('-o, --output <path>', 'Report output path', 'edgefuzz-report.json')
  .option('--no-report', 'Skip writing the JSON report file')
  .option('--ci', 'CI mode: plain text output, no TUI (auto-detected if stdout is not a TTY)')
  .option(
    '-H, --header <header>',
    'Add a request header (format: "Name: Value"). Can be repeated.',
    collect,
    [] as string[],
  )
  .option('--include <paths>', 'Only fuzz paths matching this prefix (comma-separated)')
  .option('--exclude <paths>', 'Skip paths matching this prefix (comma-separated)')
  .option(
    '--llm <provider>',
    'LLM provider: "openai" or "anthropic" (auto-detected from env if omitted)',
  )
  .option('--llm-model <model>', 'Override the LLM model name')
  .option(
    '--llm-base-url <url>',
    'Custom base URL for the LLM API (e.g. LiteLLM proxy). Overrides EDGEFUZZ_LLM_BASE_URL env var.',
  )
  .option(
    '--llm-mutations',
    'Enable LLM-generated semantic mutations (Phase A). Requires OPENAI_API_KEY or ANTHROPIC_API_KEY.',
  )
  .option(
    '--no-triage',
    'Disable LLM crash triage (Phase C). Triage runs by default when a key is present.',
  );

program.addHelpText(
  'after',
  `
Examples:
  # Auto-discover spec and fuzz localhost
  $ edgefuzz http://localhost:8080

  # Point at a specific spec file
  $ edgefuzz http://localhost:3000 ./openapi.yaml

  # Point at a remote spec URL
  $ edgefuzz http://localhost:8080 http://localhost:8080/openapi.json

  # CI mode (no TUI, exits with code 1 if crashes found)
  $ edgefuzz http://localhost:8080 --ci

  # With auth header
  $ edgefuzz http://localhost:8080 -H "Authorization: Bearer my-token"

  # Start as MCP server (for AI agents)
  $ edgefuzz --mcp

  # Only fuzz /api/v1 endpoints
  $ edgefuzz http://localhost:8080 --include /api/v1

  # LLM-augmented mode: semantic mutations + crash triage
  $ OPENAI_API_KEY=sk-... edgefuzz http://localhost:8080 --llm-mutations

  # LLM triage only (no semantic mutations, just root-cause analysis of crashes)
  $ ANTHROPIC_API_KEY=sk-ant-... edgefuzz http://localhost:8080

  # Disable triage even when key is present
  $ OPENAI_API_KEY=sk-... edgefuzz http://localhost:8080 --no-triage

LLM Modes:
  Static only (default):  no key needed — hardcoded adversarial rules
  + Triage (auto):        key present → LLM classifies crashes by root cause
  + Mutations (opt-in):   --llm-mutations → LLM generates semantic payloads too

Environment variables:
  OPENAI_API_KEY          Enable LLM features via OpenAI (gpt-4o-mini by default)
  ANTHROPIC_API_KEY       Enable LLM features via Anthropic (claude-3-5-haiku by default)
  EDGEFUZZ_LLM_MODEL      Override default LLM model name
  EDGEFUZZ_LLM_BASE_URL   Custom LLM API base URL (LiteLLM proxy, Ollama, etc.)
`,
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  program.parse(process.argv);

  const opts = program.opts<{
    mcp: boolean;
    concurrency: string;
    timeout: string;
    output: string;
    report: boolean;
    ci: boolean;
    header: string[];
    include?: string;
    exclude?: string;
    llm?: string;
    llmModel?: string;
    llmMutations?: boolean;
    triage: boolean; // commander uses --no-triage → opts.triage = false
  }>();

  // ---- MCP mode ----
  if (opts.mcp) {
    await startMcpServer();
    return;
  }

  // ---- Normal CLI mode ----
  const [targetUrl, specPath] = program.args as [string | undefined, string | undefined];

  if (!targetUrl) {
    program.help({ error: true });
    return;
  }

  // Parse headers
  const headers: Record<string, string> = {};
  for (const h of opts.header) {
    const colonIdx = h.indexOf(':');
    if (colonIdx === -1) {
      console.error(`Invalid header format: "${h}". Use "Name: Value".`);
      process.exit(1);
    }
    const name = h.slice(0, colonIdx).trim();
    const value = h.slice(colonIdx + 1).trim();
    headers[name] = value;
  }

  // Validate concurrency and timeout early — before any expensive work
  const concurrency = parseInt(opts.concurrency, 10);
  if (isNaN(concurrency) || concurrency < 1 || concurrency > 200) {
    console.error('Concurrency must be an integer between 1 and 200.');
    process.exit(1);
  }

  const timeoutMs = parseInt(opts.timeout, 10);
  if (isNaN(timeoutMs) || timeoutMs < 500) {
    console.error('Timeout must be >= 500ms.');
    process.exit(1);
  }

  // Resolve LLM availability and emit actionable warnings for misconfigurations.
  // This runs before building EdgeFuzzConfig so the config always reflects reality.
  const { llmMutations, llmTriage } = resolveLlmFlags({
    requestedMutations: opts.llmMutations === true,
    requestedTriage: opts.triage !== false,
    providerOverride: opts.llm as EdgeFuzzConfig['llmProvider'],
    modelOverride: opts.llmModel,
    isCi: opts.ci || !process.stdout.isTTY,
  });

  const config: EdgeFuzzConfig = {
    targetUrl,
    specPath,
    concurrency,
    timeoutMs,
    reportPath: opts.report ? opts.output : false,
    ci: opts.ci || !process.stdout.isTTY,
    headers,
    includePaths: opts.include ? opts.include.split(',').map((p) => p.trim()) : undefined,
    excludePaths: opts.exclude ? opts.exclude.split(',').map((p) => p.trim()) : undefined,
    llmProvider: opts.llm as EdgeFuzzConfig['llmProvider'],
    llmModel: opts.llmModel,
    llmBaseUrl: (opts as Record<string, unknown>)['llmBaseUrl'] as string | undefined,
    llmMutations,
    llmTriage,
  };

  const events = runFuzzSessionStream(config);

  let report;

  if (config.ci) {
    // CI / non-TTY mode: plain text output
    await runCiReporter(events);
    report = null;
  } else {
    report = await renderTui(config, events);
  }

  // Exit with code 1 if crashes were found (useful for CI gates)
  if (report && (report as import('../types/index.js').FuzzReport).summary.totalCrashes > 0) {
    process.exit(1);
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// TUI renderer — isolated to prevent type inference issues with dynamic imports
// ---------------------------------------------------------------------------

async function renderTui(
  config: EdgeFuzzConfig,
  events: AsyncGenerator<ProgressEvent>,
): Promise<FuzzReport | null> {

  type PEvent = import('../types/index.js').ProgressEvent;

  // Use a shared mutable object to avoid TypeScript CFA narrowing closures to `never`
  const state = {
    buffer: [] as PEvent[],
    resolve: null as ((...args: unknown[]) => void) | null,
    done: false,
    report: null as FuzzReport | null,
  };

  const bufferedEvents: AsyncIterable<PEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<PEvent>> {
          while (true) {
            if (state.buffer.length > 0) {
              return { value: state.buffer.shift() as PEvent, done: false };
            }
            if (state.done) return { value: undefined as never, done: true };
            await new Promise<void>((r) => {
              state.resolve = r as ((...args: unknown[]) => void);
            });
          }
        },
      };
    },
  };

  const drainPromise = (async () => {
    for await (const event of events) {
      if (event.type === 'done') state.report = event.report;
      state.buffer.push(event);
      const notify = state.resolve;
      state.resolve = null;
      if (notify) notify();
    }
    state.done = true;
    const notify = state.resolve;
    state.resolve = null;
    if (notify) notify();
  })();

  const { waitUntilExit } = inkRender(
    React.createElement(Dashboard, {
      target: config.targetUrl,
      specSource: config.specPath ?? '(auto-discovered)',
      events: bufferedEvents,
    }),
  );

  await drainPromise;
  await waitUntilExit();
  return state.report;
}

// ---------------------------------------------------------------------------
// LLM flag resolution — single source of truth for key-presence checks
// ---------------------------------------------------------------------------

interface ResolveLlmFlagsInput {
  requestedMutations: boolean;
  requestedTriage: boolean;
  providerOverride?: EdgeFuzzConfig['llmProvider'];
  modelOverride?: string;
  isCi: boolean;
}

interface ResolvedLlmFlags {
  llmMutations: boolean;
  llmTriage: boolean;
}

/**
 * Validates LLM flag combinations against actual key availability and returns
 * the final effective values, emitting clear warnings for misconfigurations.
 *
 * Rules:
 *  - If no key is detected, both llmMutations and llmTriage are forced to false.
 *  - If --llm-mutations is passed but no key is found, a warning is printed.
 *  - llmTriage defaults to true only when a key is actually present.
 *    This makes config semantics honest — the engine never silently ignores it.
 *  - --no-triage is always respected even when a key is present.
 */
function resolveLlmFlags(input: ResolveLlmFlagsInput): ResolvedLlmFlags {
  const { requestedMutations, requestedTriage, providerOverride, modelOverride, isCi } = input;

  const llmConfig = detectLLMProvider(providerOverride, modelOverride);
  const keyPresent = llmConfig !== null;

  // --llm-mutations requested but no key available
  if (requestedMutations && !keyPresent) {
    const warning = [
      '',
      '  Warning: --llm-mutations requires OPENAI_API_KEY or ANTHROPIC_API_KEY.',
      '           No key found — falling back to static-only mode.',
      '           Set one of those environment variables to enable LLM mutations.',
      '',
    ].join('\n');
    // Always write to stderr so it appears even when stdout is piped
    process.stderr.write(warning + '\n');
  }

  // --no-triage is an explicit opt-out — respect it even when key is present.
  // llmTriage defaults to true only when the user has a key (opt-out model),
  // not when they don't (which would create a silently-ignored true in the config).
  const llmTriage = requestedTriage && keyPresent;
  const llmMutations = requestedMutations && keyPresent;

  // In static-only mode, print a brief mode note to stderr so it's clear
  // what is running. Omit in CI to avoid polluting structured log output.
  if (!keyPresent && !isCi) {
    process.stderr.write(
      '  EdgeFuzz: running in static-only mode (no LLM key detected)\n' +
        '            Set OPENAI_API_KEY or ANTHROPIC_API_KEY to enable LLM features.\n\n',
    );
  }

  return { llmMutations, llmTriage };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function collect(val: string, prev: string[]): string[] {
  return [...prev, val];
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nEdgeFuzz error: ${msg}`);
  if (process.env['DEBUG']) {
    console.error(err);
  }
  process.exit(1);
});
