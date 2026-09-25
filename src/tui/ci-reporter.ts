/**
 * CI Reporter — plain-text output for non-interactive terminals.
 *
 * Used when --ci flag is passed or stdout is not a TTY.
 * Outputs structured, parseable lines suitable for GitHub Actions logs.
 */

import chalk from 'chalk';
import type { ProgressEvent, CrashFinding, FuzzReport } from '../types/index.js';

export async function runCiReporter(events: AsyncIterable<ProgressEvent>): Promise<{ totalCrashes: number }> {
  let totalRequests = 0;
  let doneRequests = 0;
  const crashes: CrashFinding[] = [];

  console.log(chalk.cyan('⚡ EdgeFuzz') + chalk.dim(' — CI mode'));
  console.log(chalk.dim('─'.repeat(60)));

  for await (const event of events) {
    switch (event.type) {
      case 'llm_mutations_generating':
        console.log(
          chalk.magenta(`[EdgeFuzz] LLM generating semantic mutations for ${event.endpointCount} endpoints...`),
        );
        break;

      case 'llm_mutations_ready':
        console.log(
          chalk.magenta(`[EdgeFuzz] LLM generated ${event.count} semantic mutations`),
        );
        break;

      case 'start':
        totalRequests = event.totalRequests;
        if (event.llmEnabled) {
          console.log(
            chalk.magenta('[EdgeFuzz] Mode: LLM-augmented') +
              chalk.dim(' (crash triage enabled; use --llm-mutations for semantic payloads)'),
          );
        } else {
          console.log(
            chalk.dim('[EdgeFuzz] Mode: static-only') +
              chalk.dim(' (set OPENAI_API_KEY or ANTHROPIC_API_KEY to enable LLM features)'),
          );
        }
        console.log(
          chalk.dim(
            `[EdgeFuzz] Starting: ${event.totalEndpoints} endpoints, ${totalRequests} requests`,
          ),
        );
        break;

      case 'request_done':
        doneRequests++;
        if (
          doneRequests % 50 === 0 ||
          [25, 50, 75, 100].includes(Math.round((doneRequests / totalRequests) * 100))
        ) {
          const pct = totalRequests > 0 ? Math.round((doneRequests / totalRequests) * 100) : 0;
          process.stdout.write(
            `\r${chalk.dim(`[EdgeFuzz] ${pct}% (${doneRequests}/${totalRequests})`)}`,
          );
        }
        break;

      case 'crash_found': {
        const crash = event.crash;
        if (!crashes.find((c) => c.id === crash.id)) {
          crashes.push(crash);
          process.stdout.write('\n');
          const source = crash.mutationSource === 'llm' ? chalk.magenta(' [LLM payload]') : '';
          console.log(
            chalk.red(`[CRASH] ${crash.endpoint.method} ${crash.endpoint.path}`) +
              chalk.dim(` → HTTP ${crash.statusCode}`) +
              source +
              chalk.yellow(` [${crash.mutationLabel}]`),
          );
        }
        break;
      }

      case 'triage_start':
        process.stdout.write('\n');
        console.log(
          chalk.magenta(`[EdgeFuzz] LLM triaging ${event.crashCount} crash${event.crashCount !== 1 ? 'es' : ''}...`),
        );
        break;

      case 'triage_done':
        // Update local crash array with triage-enriched versions
        for (const enriched of event.crashes) {
          const idx = crashes.findIndex((c) => c.id === enriched.id);
          if (idx >= 0) crashes[idx] = enriched;
        }
        console.log(chalk.magenta('[EdgeFuzz] Triage complete'));
        break;

      case 'done':
        process.stdout.write('\n');
        printCiSummary(event.report, crashes);
        break;
    }
  }

  return { totalCrashes: crashes.filter((c) => !c.duplicateOf).length };
}

function printCiSummary(report: FuzzReport, crashes: CrashFinding[]): void {
  const { summary } = report;

  console.log(chalk.dim('─'.repeat(60)));
  console.log(
    chalk.cyan('⚡ EdgeFuzz Audit Complete') +
      (report.llmEnabled ? chalk.magenta('  [LLM-augmented]') : ''),
  );
  console.log(
    chalk.dim(
      `Requests: ${summary.totalRequests}  |  Endpoints: ${summary.totalEndpoints}  |  ` +
        `Duration: ${(summary.durationMs / 1000).toFixed(1)}s  |  Speed: ${summary.requestsPerSecond} req/s`,
    ),
  );
  if (summary.llmMutations > 0) {
    console.log(chalk.dim(`LLM mutations: ${summary.llmMutations}`));
  }

  if (crashes.length === 0) {
    console.log(chalk.green('✓ No unhandled crashes found.'));
    return;
  }

  // Separate primary from duplicates
  const primaryCrashes = crashes.filter((c) => !c.duplicateOf);
  const dupCount = crashes.filter((c) => c.duplicateOf).length;

  console.log(
    chalk.red(
      `\n✗ Found ${primaryCrashes.length} unique crash${primaryCrashes.length !== 1 ? 'es' : ''}` +
        (dupCount > 0 ? ` (+${dupCount} duplicate root causes)` : '') +
        ':\n',
    ),
  );

  for (let i = 0; i < primaryCrashes.length; i++) {
    const crash = primaryCrashes[i]!;
    const statusLabel = crash.timedOut ? 'TIMEOUT' : `HTTP ${crash.statusCode}`;
    const effectiveSeverity = crash.llmSeverity ?? crash.severity;
    const source = crash.mutationSource === 'llm' ? ' [LLM payload]' : '';

    console.log(
      chalk.bold(`${i + 1}. ${crash.endpoint.method} ${crash.endpoint.path}`) +
        chalk.red(` → ${statusLabel}`) +
        chalk.dim(` [severity: ${effectiveSeverity}]`) +
        (source ? chalk.magenta(source) : ''),
    );
    console.log(chalk.dim(`   Mutation : ${crash.mutationLabel}`));

    // LLM triage fields
    if (crash.rootCause) {
      const confidence =
        crash.confidence !== undefined
          ? ` (${Math.round(crash.confidence * 100)}% confidence)`
          : '';
      console.log(chalk.yellow(`   Root cause: ${crash.rootCause}${confidence}`));
    }
    if (crash.triageNotes) {
      console.log(chalk.dim(`   Analysis : ${crash.triageNotes}`));
    }

    console.log(chalk.dim('   Reproducer:'));
    console.log(chalk.cyan(`   ${crash.curlReproducer.replace(/\s*\\\n\s*/g, ' ')}`));
    console.log();
  }

  console.log(chalk.dim(`Report: ${chalk.cyan('edgefuzz-report.json')}`));
}
