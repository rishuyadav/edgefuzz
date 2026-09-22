/**
 * TUI Dashboard — built with Ink (React for CLIs).
 *
 * Renders a live progress dashboard during fuzzing, then switches
 * to a summary view when the run completes.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, Newline, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { ProgressEvent, CrashFinding, FuzzReport } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardProps {
  target: string;
  specSource: string;
  events: AsyncIterable<ProgressEvent>;
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function Dashboard({ target, specSource, events }: DashboardProps) {
  const { exit } = useApp();

  const [phase, setPhase] = useState<'running' | 'done'>('running');
  const [totalRequests, setTotalRequests] = useState(0);
  const [doneRequests, setDoneRequests] = useState(0);
  const [crashes, setCrashes] = useState<CrashFinding[]>([]);
  const [report, setReport] = useState<FuzzReport | null>(null);
  const [rps, setRps] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);

  const startTimeRef = useRef(Date.now());
  const doneRef = useRef(0);

  // Consume progress events
  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;

    const consume = async () => {
      timer = setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000;
        setElapsedSec(Math.floor(elapsed));
        setRps(elapsed > 0 ? Math.round(doneRef.current / elapsed) : 0);
      }, 200);

      for await (const event of events) {
        switch (event.type) {
          case 'start':
            setTotalRequests(event.totalRequests);
            startTimeRef.current = Date.now();
            break;

          case 'request_done':
            doneRef.current += 1;
            setDoneRequests((n) => n + 1);
            break;

          case 'crash_found':
            setCrashes((prev) => {
              // Deduplicate by id in the TUI state
              if (prev.find((c) => c.id === event.crash.id)) return prev;
              return [...prev, event.crash];
            });
            break;

          case 'llm_suggestion':
            setCrashes((prev) =>
              prev.map((c) =>
                c.id === event.crashId
                  ? { ...c, llmFixSuggestion: event.suggestion }
                  : c,
              ),
            );
            break;

          case 'done':
            clearInterval(timer);
            setReport(event.report);
            setPhase('done');
            // Give React one tick to render the summary before exiting
            setTimeout(() => exit(), 100);
            break;
        }
      }
    };

    void consume();
    return () => clearInterval(timer);
  }, [events, exit]);

  if (phase === 'running') {
    return (
      <RunningView
        target={target}
        specSource={specSource}
        totalRequests={totalRequests}
        doneRequests={doneRequests}
        crashes={crashes}
        rps={rps}
        elapsedSec={elapsedSec}
      />
    );
  }

  return <SummaryView report={report!} crashes={crashes} />;
}

// ---------------------------------------------------------------------------
// Running view
// ---------------------------------------------------------------------------

interface RunningViewProps {
  target: string;
  specSource: string;
  totalRequests: number;
  doneRequests: number;
  crashes: CrashFinding[];
  rps: number;
  elapsedSec: number;
}

function RunningView({
  target,
  specSource,
  totalRequests,
  doneRequests,
  crashes,
  rps,
  elapsedSec,
}: RunningViewProps) {
  const pct = totalRequests > 0 ? Math.round((doneRequests / totalRequests) * 100) : 0;
  const barWidth = 30;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">
          ⚡ EdgeFuzz
        </Text>
        <Text dimColor>  |  target: </Text>
        <Text color="white">{target}</Text>
        <Text dimColor>  |  spec: </Text>
        <Text color="white">{truncate(specSource, 50)}</Text>
      </Box>

      {/* Progress bar */}
      <Box marginBottom={1}>
        <Text>
          <Text color="green">{bar}</Text>
          {'  '}
          <Text bold>{pct}%</Text>
          <Text dimColor>  {doneRequests}/{totalRequests} requests</Text>
        </Text>
      </Box>

      {/* Stats row */}
      <Box marginBottom={1} gap={4}>
        <Box>
          <Text dimColor>Speed  </Text>
          <Text bold color="yellow">{rps} req/s</Text>
        </Box>
        <Box>
          <Text dimColor>Elapsed  </Text>
          <Text bold>{elapsedSec}s</Text>
        </Box>
        <Box>
          <Text dimColor>Crashes  </Text>
          <Text bold color={crashes.length > 0 ? 'red' : 'green'}>
            {crashes.length}
          </Text>
        </Box>
        <Box>
          <Spinner type="dots" />
          <Text dimColor>  fuzzing...</Text>
        </Box>
      </Box>

      {/* Live crash list (last 5) */}
      {crashes.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="red">
            Crashes Found:
          </Text>
          {crashes.slice(-5).map((crash) => (
            <CrashRow key={crash.id} crash={crash} compact />
          ))}
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Summary view
// ---------------------------------------------------------------------------

interface SummaryViewProps {
  report: FuzzReport;
  crashes: CrashFinding[];
}

function SummaryView({ report, crashes }: SummaryViewProps) {
  const { summary } = report;
  const hascrashes = crashes.length > 0;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ⚡ EdgeFuzz Audit Complete
        </Text>
      </Box>

      {/* Summary stats */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={hascrashes ? 'red' : 'green'}
        paddingX={2}
        paddingY={0}
        marginBottom={1}
      >
        <Box gap={4} marginBottom={0}>
          <Text>
            <Text dimColor>Requests  </Text>
            <Text bold>{summary.totalRequests}</Text>
          </Text>
          <Text>
            <Text dimColor>Endpoints  </Text>
            <Text bold>{summary.totalEndpoints}</Text>
          </Text>
          <Text>
            <Text dimColor>Duration  </Text>
            <Text bold>{(summary.durationMs / 1000).toFixed(1)}s</Text>
          </Text>
          <Text>
            <Text dimColor>Speed  </Text>
            <Text bold>{summary.requestsPerSecond} req/s</Text>
          </Text>
        </Box>
      </Box>

      {/* Crash list or clean bill */}
      {!hascrashes && (
        <Box>
          <Text bold color="green">
            ✓ No unhandled crashes found. Your API handles edge cases correctly.
          </Text>
        </Box>
      )}

      {hascrashes && (
        <Box flexDirection="column">
          <Text bold color="red">
            ✗ Found {crashes.length} unhandled crash{crashes.length !== 1 ? 'es' : ''}:
          </Text>
          <Newline />
          {crashes.map((crash, i) => (
            <Box key={crash.id} flexDirection="column" marginBottom={2}>
              <Text bold>
                {i + 1}. {crash.endpoint.method} {crash.endpoint.path}
              </Text>
              <CrashRow crash={crash} compact={false} />
            </Box>
          ))}
        </Box>
      )}

      {/* Report path */}
      {report && (
        <Box marginTop={1}>
          <Text dimColor>Report written to: </Text>
          <Text color="cyan">edgefuzz-report.json</Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Shared crash row component
// ---------------------------------------------------------------------------

interface CrashRowProps {
  crash: CrashFinding;
  compact: boolean;
}

function CrashRow({ crash, compact }: CrashRowProps) {
  const severityColor =
    crash.severity === 'critical' ? 'red' : crash.severity === 'high' ? 'yellow' : 'white';

  const statusLabel = crash.timedOut
    ? 'TIMEOUT'
    : crash.networkError
      ? 'NETWORK ERROR'
      : `HTTP ${crash.statusCode}`;

  if (compact) {
    return (
      <Box>
        <Text color="red">  ❌ </Text>
        <Text bold>{crash.endpoint.method.padEnd(7)}</Text>
        <Text>{crash.endpoint.path.padEnd(35)}</Text>
        <Text color={severityColor}> → {statusLabel}</Text>
        <Text dimColor>  [{crash.mutationCategory}]</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text dimColor>├─ Mutation   </Text>
        <Text>{crash.mutationLabel}</Text>
      </Box>
      <Box>
        <Text dimColor>├─ Result     </Text>
        <Text color={severityColor}>{statusLabel}</Text>
        <Text dimColor>  severity: </Text>
        <Text color={severityColor}>{crash.severity}</Text>
      </Box>
      <Box>
        <Text dimColor>├─ Category   </Text>
        <Text>{crash.mutationCategory}</Text>
      </Box>
      {crash.responseBody && (
        <Box>
          <Text dimColor>├─ Response   </Text>
          <Text>{truncate(crash.responseBody.replace(/\n/g, ' '), 80)}</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={0}>
        <Text dimColor>└─ Reproducer:</Text>
        <Box paddingLeft={3} marginTop={0}>
          <Text color="cyan" dimColor>
            {truncate(crash.curlReproducer.replace(/\s*\\\n\s*/g, ' '), 100)}
          </Text>
        </Box>
      </Box>
      {crash.llmFixSuggestion && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          <Text bold color="yellow">
            💡 LLM Fix Suggestion:
          </Text>
          <Text>{crash.llmFixSuggestion}</Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
