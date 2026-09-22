/**
 * CI Reporter — plain-text output for non-interactive terminals.
 *
 * Used when --ci flag is passed or stdout is not a TTY.
 * Outputs structured, parseable lines suitable for GitHub Actions logs.
 */

import chalk from 'chalk';
import type { ProgressEvent, CrashFinding, FuzzReport } from '../types/index.js';

export async function runCiReporter(events: AsyncIterable<ProgressEvent>): Promise<void> {
  let totalRequests = 0;
  let doneRequests = 0;
  const crashes: CrashFinding[] = [];

  console.log(chalk.cyan('⚡ EdgeFuzz') + chalk.dim(' — CI mode'));
  console.log(chalk.dim('─'.repeat(60)));

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        totalRequests = event.totalRequests;
        console.log(
          chalk.dim(`[EdgeFuzz] Starting: ${event.totalEndpoints} endpoints, ${totalRequests} total requests`),
        );
        break;

      case 'request_done':
        doneRequests++;
        // Print progress every 50 requests or at 25/50/75/100%
        if (doneRequests % 50 === 0 || [25, 50, 75, 100].includes(Math.round((doneRequests / totalRequests) * 100))) {
          const pct = totalRequests > 0 ? Math.round((doneRequests / totalRequests) * 100) : 0;
          process.stdout.write(`\r${chalk.dim(`[EdgeFuzz] ${pct}% (${doneRequests}/${totalRequests})`)}`);
        }
        break;

      case 'crash_found': {
        const crash = event.crash;
        // Deduplicate
        if (!crashes.find((c) => c.id === crash.id)) {
          crashes.push(crash);
          process.stdout.write('\n');
          console.log(
            chalk.red(`[CRASH] ${crash.endpoint.method} ${crash.endpoint.path}`) +
              chalk.dim(` → HTTP ${crash.statusCode}`) +
              chalk.yellow(` [${crash.mutationLabel}]`),
          );
        }
        break;
      }

      case 'llm_suggestion':
        // Already handled via crash update — not printed separately in CI mode
        break;

      case 'done':
        process.stdout.write('\n');
        printCiSummary(event.report, crashes);
        break;
    }
  }
}

function printCiSummary(report: FuzzReport, crashes: CrashFinding[]): void {
  const { summary } = report;
  console.log(chalk.dim('─'.repeat(60)));
  console.log(chalk.cyan('⚡ EdgeFuzz Audit Complete'));
  console.log(
    chalk.dim(
      `Requests: ${summary.totalRequests}  |  Endpoints: ${summary.totalEndpoints}  |  ` +
        `Duration: ${(summary.durationMs / 1000).toFixed(1)}s  |  Speed: ${summary.requestsPerSecond} req/s`,
    ),
  );

  if (crashes.length === 0) {
    console.log(chalk.green('✓ No unhandled crashes found.'));
    return;
  }

  console.log(chalk.red(`\n✗ Found ${crashes.length} unhandled crash${crashes.length !== 1 ? 'es' : ''}:\n`));

  for (let i = 0; i < crashes.length; i++) {
    const crash = crashes[i]!;
    const statusLabel = crash.timedOut ? 'TIMEOUT' : `HTTP ${crash.statusCode}`;

    console.log(
      chalk.bold(`${i + 1}. ${crash.endpoint.method} ${crash.endpoint.path}`) +
        chalk.red(` → ${statusLabel}`) +
        chalk.dim(` [severity: ${crash.severity}]`),
    );
    console.log(chalk.dim(`   Mutation: ${crash.mutationLabel}`));
    console.log(chalk.dim('   Reproducer:'));
    console.log(chalk.cyan(`   ${crash.curlReproducer.replace(/\s*\\\n\s*/g, ' ')}`));

    if (crash.llmFixSuggestion) {
      console.log(chalk.yellow('\n   💡 Fix suggestion:'));
      console.log(`   ${crash.llmFixSuggestion.replace(/\n/g, '\n   ')}`);
    }

    console.log();
  }

  console.log(
    chalk.dim(
      `Report written to: ${chalk.cyan('edgefuzz-report.json')}`,
    ),
  );
}
