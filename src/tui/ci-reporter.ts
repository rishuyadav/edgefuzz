/**
 * CI Reporter — plain-text output for non-interactive terminals.
 *
 * Used when --ci flag is passed or stdout is not a TTY.
 * Outputs structured, parseable lines suitable for GitHub Actions logs.
 */

import chalk from 'chalk';
import type { ProgressEvent, CrashFinding, ResponseMismatch, FuzzReport } from '../types/index.js';

export async function runCiReporter(events: AsyncIterable<ProgressEvent>): Promise<{ totalCrashes: number }> {
  let totalRequests = 0;
  let doneRequests = 0;
  const crashes: CrashFinding[] = [];
  const mismatches: ResponseMismatch[] = [];

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
              chalk.dim(' (use --llm-mutations for semantic payloads)'),
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

      case 'mismatch_found': {
        const m = event.mismatch;
        if (!mismatches.find((x) => x.id === m.id)) {
          mismatches.push(m);
          // Only print high-severity mismatches inline to avoid flooding CI logs
          if (m.severity === 'high' || m.kind === 'error-body-leaked') {
            process.stdout.write('\n');
            console.log(
              chalk.yellow(`[LEAK] ${m.endpoint.method} ${m.endpoint.path}`) +
                chalk.dim(` → HTTP ${m.statusCode} — ${m.kind}`),
            );
          }
        }
        break;
      }

      case 'triage_start':
        process.stdout.write('\n');
        console.log(
          chalk.magenta(`[triage] Analysing ${event.crashCount} crash${event.crashCount !== 1 ? 'es' : ''} with LLM — classifying root causes + grouping duplicates...`),
        );
        break;

      case 'triage_done':
        if (event.duplicateCount > 0) {
          console.log(
            chalk.magenta(`[triage] Done — ${event.duplicateCount} duplicate${event.duplicateCount !== 1 ? 's' : ''} identified`),
          );
        } else {
          console.log(chalk.magenta('[triage] Done — no duplicates detected'));
        }
        break;

      case 'done':
        process.stdout.write('\n');
        printCiSummary(event.report, crashes, mismatches);
        break;
    }
  }

  return { totalCrashes: crashes.length };
}

function printCiSummary(report: FuzzReport, crashes: CrashFinding[], mismatches: ResponseMismatch[]): void {
  const { summary } = report;

  console.log(chalk.dim('─'.repeat(60)));
  console.log(
    chalk.cyan('⚡ EdgeFuzz Audit Complete') +
      (summary.llmMutations > 0 ? chalk.magenta('  [LLM-augmented]') : ''),
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
  if (summary.totalDuplicates !== undefined) {
    console.log(chalk.dim(`Duplicates identified: ${summary.totalDuplicates}`));
  }

  if (crashes.length === 0 && mismatches.length === 0) {
    console.log(chalk.green('✓ No crashes or contract violations found.'));
    return;
  }

  if (crashes.length === 0) {
    console.log(chalk.green('✓ No unhandled crashes found.'));
  }

  if (crashes.length > 0) {
    console.log(
      chalk.red(`\n✗ Found ${crashes.length} crash${crashes.length !== 1 ? 'es' : ''}:\n`),
    );

    for (let i = 0; i < crashes.length; i++) {
      const crash = crashes[i]!;
      const statusLabel = crash.timedOut ? 'TIMEOUT' : `HTTP ${crash.statusCode}`;
      const source = crash.mutationSource === 'llm' ? ' [LLM payload]' : '';

      console.log(
        chalk.bold(`${i + 1}. ${crash.endpoint.method} ${crash.endpoint.path}`) +
          chalk.red(` → ${statusLabel}`) +
          chalk.dim(` [severity: ${crash.llmSeverity ?? crash.severity}]`) +
          (source ? chalk.magenta(source) : '') +
          (crash.duplicateOf ? chalk.dim(` [dup of ${crash.duplicateOf.slice(0, 8)}...]`) : ''),
      );
      console.log(chalk.dim(`   Mutation : ${crash.mutationLabel}`));
      if (crash.rootCause) {
        const conf = crash.confidence !== undefined ? ` (${Math.round(crash.confidence * 100)}% confidence)` : '';
        console.log(chalk.dim(`   Root cause: ${crash.rootCause}${conf}`));
      }
      if (crash.triageNotes) {
        console.log(chalk.dim(`   Analysis : ${crash.triageNotes}`));
      }
      console.log(chalk.dim('   Reproducer:'));
      console.log(chalk.cyan(`   ${crash.curlReproducer.replace(/\s*\\\n\s*/g, ' ')}`));
      console.log();
    }
  }

  // Contract violation summary
  if (mismatches.length > 0) {
    const highMismatches = mismatches.filter((m) => m.severity === 'high' || m.kind === 'error-body-leaked');
    const otherMismatches = mismatches.filter((m) => m.severity !== 'high' && m.kind !== 'error-body-leaked');

    console.log(
      chalk.yellow(
        `\n⚠ Found ${mismatches.length} contract violation${mismatches.length !== 1 ? 's' : ''}` +
          ` (wrong types, missing fields, data leakage):\n`,
      ),
    );

    for (const m of highMismatches) {
      console.log(
        chalk.bold(`  ${m.endpoint.method} ${m.endpoint.path}`) +
          chalk.yellow(` → ${m.kind}`) +
          chalk.dim(` [severity: ${m.severity}]`),
      );
      console.log(chalk.dim(`   ${m.message}`));
      if (m.responseExcerpt) {
        console.log(chalk.dim(`   Body: ${m.responseExcerpt.slice(0, 120)}...`));
      }
      console.log();
    }

    if (otherMismatches.length > 0) {
      console.log(chalk.dim(`  (+${otherMismatches.length} lower-severity violations — see report)`));
    }
  }

  console.log(chalk.dim(`Report: ${chalk.cyan('edgefuzz-report.json')}`));
}
