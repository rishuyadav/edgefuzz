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
    'LLM provider for fix suggestions: "openai" or "anthropic" (auto-detected from env)',
  )
  .option('--llm-model <model>', 'Override the LLM model name');

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

Environment variables:
  OPENAI_API_KEY      Enable LLM fix suggestions via OpenAI
  ANTHROPIC_API_KEY   Enable LLM fix suggestions via Anthropic
  EDGEFUZZ_LLM_MODEL  Override default LLM model name
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

  const config: EdgeFuzzConfig = {
    targetUrl,
    specPath,
    concurrency: parseInt(opts.concurrency, 10),
    timeoutMs: parseInt(opts.timeout, 10),
    reportPath: opts.report ? opts.output : false,
    ci: opts.ci || !process.stdout.isTTY,
    headers,
    includePaths: opts.include ? opts.include.split(',').map((p) => p.trim()) : undefined,
    excludePaths: opts.exclude ? opts.exclude.split(',').map((p) => p.trim()) : undefined,
    llmProvider: opts.llm as EdgeFuzzConfig['llmProvider'],
    llmModel: opts.llmModel,
  };

  // Validate concurrency
  if (isNaN(config.concurrency) || config.concurrency < 1 || config.concurrency > 200) {
    console.error('Concurrency must be an integer between 1 and 200.');
    process.exit(1);
  }

  // Validate timeout
  if (isNaN(config.timeoutMs) || config.timeoutMs < 500) {
    console.error('Timeout must be >= 500ms.');
    process.exit(1);
  }

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
