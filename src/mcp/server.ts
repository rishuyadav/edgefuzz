/**
 * MCP Server Mode.
 *
 * Exposes EdgeFuzz as a Model Context Protocol tool server.
 * AI agents (Cursor, Claude Desktop, OpenCode) can call `edgefuzz_audit`
 * to fuzz a local endpoint directly from their workflow.
 *
 * Start with: edgefuzz --mcp
 * Transport: stdio (standard MCP transport)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runFuzzSession } from '../engine.js';
import type { EdgeFuzzConfig, FuzzReport } from '../types/index.js';

const SERVER_VERSION = '1.0.0';

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'edgefuzz',
    version: SERVER_VERSION,
  });

  // -------------------------------------------------------------------------
  // Tool: edgefuzz_audit
  // -------------------------------------------------------------------------
  server.tool(
    'edgefuzz_audit',
    'Fuzz a running local API using its OpenAPI spec and return all discovered unhandled 500 crashes with curl reproducers. Use this after generating a new API endpoint to verify it handles edge cases correctly.',
    {
      target_url: z
        .string()
        .url()
        .describe('Base URL of the running API server, e.g. http://localhost:8080'),
      spec_url: z
        .string()
        .optional()
        .describe(
          'URL or file path to the OpenAPI 3.x spec. If omitted, EdgeFuzz auto-discovers it on localhost.',
        ),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe('Max concurrent requests (default: 10)'),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(30000)
        .default(5000)
        .describe('Per-request timeout in milliseconds (default: 5000)'),
      include_paths: z
        .array(z.string())
        .optional()
        .describe('Only fuzz endpoints matching these path prefixes'),
      exclude_paths: z
        .array(z.string())
        .optional()
        .describe('Skip endpoints matching these path prefixes'),
      headers: z
        .record(z.string())
        .optional()
        .describe('Additional headers to include in all requests (e.g. Authorization)'),
    },
    async (params) => {
      const config: EdgeFuzzConfig = {
        targetUrl: params.target_url,
        specPath: params.spec_url,
        concurrency: params.concurrency,
        timeoutMs: params.timeout_ms,
        reportPath: false, // Don't write a file in MCP mode — return JSON inline
        ci: true,          // No TUI in MCP mode
        headers: params.headers ?? {},
        includePaths: params.include_paths,
        excludePaths: params.exclude_paths,
        llmMutations: false, // Not in MCP semantic mode by default
        llmTriage: true,     // Always triage in MCP — agents benefit most from it
      };

      let report: FuzzReport;
      try {
        report = await runFuzzSession(config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text',
              text: `EdgeFuzz audit failed: ${message}`,
            },
          ],
          isError: true,
        };
      }

      const responseText = formatMcpResponse(report);

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: edgefuzz_quick_check
  // -------------------------------------------------------------------------
  server.tool(
    'edgefuzz_quick_check',
    'Run a fast, targeted fuzz check against a single endpoint path. Useful for spot-checking a newly generated endpoint without fuzzing the entire API.',
    {
      target_url: z.string().url().describe('Base URL of the running API server'),
      spec_url: z.string().describe('URL or file path to the OpenAPI spec'),
      path: z.string().describe('The specific endpoint path to fuzz, e.g. /api/v1/users/{id}'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
        .optional()
        .describe('HTTP method to fuzz. If omitted, all methods for the path are fuzzed.'),
      concurrency: z.number().int().min(1).max(50).default(5).describe('Max concurrent requests'),
      headers: z.record(z.string()).optional().describe('Additional request headers'),
    },
    async (params) => {
      const config: EdgeFuzzConfig = {
        targetUrl: params.target_url,
        specPath: params.spec_url,
        concurrency: params.concurrency,
        timeoutMs: 5000,
        reportPath: false,
        ci: true,
        headers: params.headers ?? {},
        includePaths: [params.path],
        llmMutations: false,
        llmTriage: true,
      };

      let report: FuzzReport;
      try {
        report = await runFuzzSession(config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `EdgeFuzz quick check failed: ${message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: formatMcpResponse(report) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Start transport
  // -------------------------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Response formatting for MCP
// ---------------------------------------------------------------------------

function formatMcpResponse(report: FuzzReport): string {
  const { summary, crashes } = report;
  const lines: string[] = [];

  lines.push(`## EdgeFuzz Audit Report`);
  lines.push('');
  lines.push(`**Target:** ${report.target}`);
  lines.push(`**Spec:** ${report.specSource}`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**LLM-augmented:** ${report.llmEnabled ? 'Yes' : 'No'}`);
  lines.push('');
  lines.push(`### Summary`);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Requests | ${summary.totalRequests} |`);
  lines.push(`| Endpoints Tested | ${summary.totalEndpoints} |`);
  lines.push(`| Unique Crashes | ${summary.totalCrashes} |`);
  lines.push(`| Duplicate Root Causes | ${summary.totalDuplicates} |`);
  if (summary.llmMutations > 0) {
    lines.push(`| LLM Semantic Mutations | ${summary.llmMutations} |`);
  }
  lines.push(`| Duration | ${(summary.durationMs / 1000).toFixed(1)}s |`);
  lines.push(`| Speed | ${summary.requestsPerSecond} req/s |`);
  lines.push('');

  // Separate primary from duplicate crashes for cleaner output
  const primaryCrashes = crashes.filter((c) => !c.duplicateOf);
  const dupCrashes = crashes.filter((c) => c.duplicateOf);

  if (crashes.length === 0) {
    lines.push(`### ✅ Result: No unhandled crashes found`);
    lines.push('');
    lines.push(
      'All edge cases tested were handled gracefully (4xx responses or correct validation errors). Your API is resilient to the tested mutation patterns.',
    );
  } else {
    lines.push(
      `### ❌ Result: ${primaryCrashes.length} Unique Crash${primaryCrashes.length !== 1 ? 'es' : ''} Found` +
        (dupCrashes.length > 0 ? ` (+${dupCrashes.length} duplicate root causes)` : ''),
    );
    lines.push('');
    lines.push(
      'The following requests caused unhandled 5xx errors. Fix these before merging to production.',
    );
    lines.push('');

    for (let i = 0; i < primaryCrashes.length; i++) {
      const crash = primaryCrashes[i]!;
      const statusLabel = crash.timedOut ? 'TIMEOUT' : `HTTP ${crash.statusCode}`;
      const effectiveSeverity = crash.llmSeverity ?? crash.severity;

      lines.push(`#### ${i + 1}. \`${crash.endpoint.method} ${crash.endpoint.path}\``);
      lines.push(
        `- **Status:** ${statusLabel}` +
          ` (severity: **${effectiveSeverity}**` +
          (crash.llmSeverity && crash.llmSeverity !== crash.severity
            ? ` — LLM override from ${crash.severity}`
            : '') +
          ')',
      );
      lines.push(
        `- **Mutation:** ${crash.mutationLabel}` +
          (crash.mutationSource === 'llm' ? ' ⚡ _LLM-generated payload_' : ''),
      );
      lines.push(`- **Category:** ${crash.mutationCategory}`);

      // LLM triage fields — most valuable signal for the AI agent
      if (crash.rootCause) {
        const confidenceStr =
          crash.confidence !== undefined
            ? ` (${Math.round(crash.confidence * 100)}% confidence)`
            : '';
        lines.push(`- **Root cause:** \`${crash.rootCause}\`${confidenceStr}`);
      }
      if (crash.triageNotes) {
        lines.push(`- **Analysis:** ${crash.triageNotes}`);
      }

      if (crash.triggeringPayload !== null) {
        const payloadStr = JSON.stringify(crash.triggeringPayload, null, 2);
        const truncated = payloadStr.length > 800
          ? payloadStr.slice(0, 800) + '\n  ... [truncated]'
          : payloadStr;
        lines.push(`- **Triggering payload:**`);
        lines.push('  ```json');
        lines.push(`  ${truncated.replace(/\n/g, '\n  ')}`);
        lines.push('  ```');
      }

      lines.push(`- **Curl reproducer:**`);
      lines.push('  ```bash');
      lines.push(`  ${crash.curlReproducer}`);
      lines.push('  ```');

      lines.push('');
    }

    // List duplicate crashes compactly (they share a root cause with a primary crash)
    if (dupCrashes.length > 0) {
      lines.push('#### Duplicate Root Causes (same underlying bug)');
      lines.push('');
      lines.push('These crashes share the same root cause as a primary crash above:');
      lines.push('');
      for (const dup of dupCrashes) {
        const statusLabel = dup.timedOut ? 'TIMEOUT' : `HTTP ${dup.statusCode}`;
        lines.push(
          `- \`${dup.endpoint.method} ${dup.endpoint.path}\` → ${statusLabel}` +
            (dup.rootCause ? ` [${dup.rootCause}]` : '') +
            (dup.duplicateOf ? ` — same as crash \`${dup.duplicateOf}\`` : ''),
        );
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`*Generated by EdgeFuzz v${SERVER_VERSION} — https://github.com/rishuyadav/edgefuzz*`);

  return lines.join('\n');
}
