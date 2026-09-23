/**
 * TUI Dashboard — built with Ink (React for CLIs).
 *
 * Renders a live progress dashboard during fuzzing, then switches
 * to a summary view when the run completes.
 *
 * Phases:
 *  preparing  → LLM generating semantic mutations (if --llm-mutations)
 *  running    → Fuzzing in progress
 *  triaging   → LLM triage of crashes (if key present)
 *  done       → Summary + crash details
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, Newline, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { ProgressEvent, CrashFinding, FuzzReport, CrashRootCause } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardProps {
  target: string;
  specSource: string;
  events: AsyncIterable<ProgressEvent>;
}

type Phase = 'preparing' | 'running' | 'triaging' | 'done';

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function Dashboard({ target, specSource, events }: DashboardProps) {
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>('running');
  const [totalRequests, setTotalRequests] = useState(0);
  const [doneRequests, setDoneRequests] = useState(0);
  const [crashes, setCrashes] = useState<CrashFinding[]>([]);
  const [report, setReport] = useState<FuzzReport | null>(null);
  const [rps, setRps] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [llmMutationCount, setLlmMutationCount] = useState(0);
  const [preparingEndpoints, setPreparingEndpoints] = useState(0);
  const [triageCount, setTriageCount] = useState(0);

  const startTimeRef = useRef(Date.now());
  const doneRef = useRef(0);

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
          case 'llm_mutations_generating':
            setPhase('preparing');
            setPreparingEndpoints(event.endpointCount);
            break;

          case 'llm_mutations_ready':
            setLlmMutationCount(event.count);
            break;

          case 'start':
            setTotalRequests(event.totalRequests);
            setLlmEnabled(event.llmEnabled);
            setPhase('running');
            startTimeRef.current = Date.now();
            break;

          case 'request_done':
            doneRef.current += 1;
            setDoneRequests((n) => n + 1);
            break;

          case 'crash_found':
            setCrashes((prev) => {
              if (prev.find((c) => c.id === event.crash.id)) return prev;
              return [...prev, event.crash];
            });
            break;

          case 'triage_start':
            setPhase('triaging');
            setTriageCount(event.crashCount);
            break;

          case 'triage_done':
            // Replace crashes with triage-enriched versions
            setCrashes(event.crashes);
            break;

          case 'done':
            clearInterval(timer);
            setReport(event.report);
            setPhase('done');
            setTimeout(() => exit(), 100);
            break;
        }
      }
    };

    void consume();
    return () => clearInterval(timer);
  }, [events, exit]);

  if (phase === 'preparing') {
    return <PreparingView endpointCount={preparingEndpoints} />;
  }

  if (phase === 'triaging') {
    return <TriagingView crashCount={triageCount} />;
  }

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
        llmEnabled={llmEnabled}
        llmMutationCount={llmMutationCount}
      />
    );
  }

  return <SummaryView report={report!} crashes={crashes} />;
}

// ---------------------------------------------------------------------------
// Preparing view (LLM semantic mutation generation)
// ---------------------------------------------------------------------------

function PreparingView({ endpointCount }: { endpointCount: number }) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">⚡ EdgeFuzz</Text>
        <Text dimColor>  —  LLM mode</Text>
      </Box>
      <Box gap={2}>
        <Spinner type="dots" />
        <Text>
          Generating semantic mutations via LLM for{' '}
          <Text bold color="yellow">{endpointCount}</Text> endpoint{endpointCount !== 1 ? 's' : ''}
          <Text dimColor>  (this runs once before fuzzing starts)</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          The LLM is reading each endpoint schema and generating domain-specific adversarial payloads...
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Triaging view (LLM crash triage in progress)
// ---------------------------------------------------------------------------

function TriagingView({ crashCount }: { crashCount: number }) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">⚡ EdgeFuzz</Text>
        <Text dimColor>  —  LLM triage</Text>
      </Box>
      <Box gap={2}>
        <Spinner type="dots" />
        <Text>
          Triaging{' '}
          <Text bold color="red">{crashCount}</Text> crash{crashCount !== 1 ? 'es' : ''}
          {' '}— LLM is reading stack traces and classifying root causes...
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Identifying duplicates, severity overrides, and root-cause labels...</Text>
      </Box>
    </Box>
  );
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
  llmEnabled: boolean;
  llmMutationCount: number;
}

function RunningView({
  target, specSource, totalRequests, doneRequests, crashes,
  rps, elapsedSec, llmEnabled, llmMutationCount,
}: RunningViewProps) {
  const pct = totalRequests > 0 ? Math.round((doneRequests / totalRequests) * 100) : 0;
  const barWidth = 30;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">⚡ EdgeFuzz</Text>
        <Text dimColor>  |  </Text>
        <Text color="white">{truncate(target, 40)}</Text>
        <Text dimColor>  |  spec: </Text>
        <Text color="white">{truncate(specSource, 40)}</Text>
        {llmEnabled && (
          <>
            <Text dimColor>  |  </Text>
            <Text color="magenta">LLM✓</Text>
            {llmMutationCount > 0 && (
              <Text dimColor> +{llmMutationCount} semantic</Text>
            )}
          </>
        )}
      </Box>

      {/* Progress bar */}
      <Box marginBottom={1}>
        <Text>
          <Text color="green">{bar}</Text>
          {'  '}
          <Text bold>{pct}%</Text>
          <Text dimColor>  {doneRequests}/{totalRequests}</Text>
        </Text>
      </Box>

      {/* Stats */}
      <Box marginBottom={1} gap={4}>
        <Box><Text dimColor>Speed  </Text><Text bold color="yellow">{rps} req/s</Text></Box>
        <Box><Text dimColor>Elapsed  </Text><Text bold>{elapsedSec}s</Text></Box>
        <Box>
          <Text dimColor>Crashes  </Text>
          <Text bold color={crashes.length > 0 ? 'red' : 'green'}>{crashes.length}</Text>
        </Box>
        <Box><Spinner type="dots" /><Text dimColor>  fuzzing...</Text></Box>
      </Box>

      {/* Live crash list */}
      {crashes.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="red">Crashes Found:</Text>
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

function SummaryView({ report, crashes }: { report: FuzzReport; crashes: CrashFinding[] }) {
  const { summary } = report;
  const hascrashes = crashes.length > 0;
  // Show canonical crashes only (exclude duplicates in the list, but note them)
  const primaryCrashes = crashes.filter((c) => !c.duplicateOf);
  const duplicateCount = crashes.filter((c) => c.duplicateOf).length;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">⚡ EdgeFuzz Audit Complete</Text>
        {report.llmEnabled && <Text color="magenta">  [LLM-augmented]</Text>}
      </Box>

      {/* Stats */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={hascrashes ? 'red' : 'green'}
        paddingX={2}
        marginBottom={1}
      >
        <Box gap={4}>
          <Text><Text dimColor>Requests  </Text><Text bold>{summary.totalRequests}</Text></Text>
          <Text><Text dimColor>Endpoints  </Text><Text bold>{summary.totalEndpoints}</Text></Text>
          <Text><Text dimColor>Duration  </Text><Text bold>{(summary.durationMs / 1000).toFixed(1)}s</Text></Text>
          <Text><Text dimColor>Speed  </Text><Text bold>{summary.requestsPerSecond} req/s</Text></Text>
          {summary.llmMutations > 0 && (
            <Text><Text dimColor>LLM mutations  </Text><Text bold color="magenta">{summary.llmMutations}</Text></Text>
          )}
        </Box>
      </Box>

      {!hascrashes && (
        <Text bold color="green">✓ No unhandled crashes found.</Text>
      )}

      {hascrashes && (
        <Box flexDirection="column">
          <Text bold color="red">
            ✗ Found {primaryCrashes.length} unique crash{primaryCrashes.length !== 1 ? 'es' : ''}
            {duplicateCount > 0 && <Text dimColor> (+{duplicateCount} duplicate root causes)</Text>}
          </Text>
          <Newline />
          {primaryCrashes.map((crash, i) => (
            <Box key={crash.id} flexDirection="column" marginBottom={2}>
              <Text bold>
                {i + 1}. {crash.endpoint.method} {crash.endpoint.path}
                {crash.mutationSource === 'llm' && <Text color="magenta"> [LLM payload]</Text>}
              </Text>
              <CrashRow crash={crash} compact={false} />
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Report: </Text>
        <Text color="cyan">edgefuzz-report.json</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Crash row component
// ---------------------------------------------------------------------------

function CrashRow({ crash, compact }: { crash: CrashFinding; compact: boolean }) {
  // Use LLM severity when available, fall back to static
  const effectiveSeverity = crash.llmSeverity ?? crash.severity;
  const severityColor =
    effectiveSeverity === 'critical' ? 'red'
      : effectiveSeverity === 'high' ? 'yellow'
        : effectiveSeverity === 'medium' ? 'white'
          : 'gray';

  const statusLabel = crash.timedOut ? 'TIMEOUT'
    : crash.networkError ? 'NETWORK ERROR'
      : `HTTP ${crash.statusCode}`;

  if (compact) {
    return (
      <Box>
        <Text color="red">  ❌ </Text>
        <Text bold>{crash.endpoint.method.padEnd(7)}</Text>
        <Text>{crash.endpoint.path.padEnd(35)}</Text>
        <Text color={severityColor}> → {statusLabel}</Text>
        {crash.mutationSource === 'llm' && <Text color="magenta"> [LLM]</Text>}
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
        <Text color={severityColor}>{effectiveSeverity}</Text>
        {crash.llmSeverity && crash.llmSeverity !== crash.severity && (
          <Text dimColor> (LLM override from {crash.severity})</Text>
        )}
      </Box>
      {/* LLM triage fields */}
      {crash.rootCause && (
        <Box>
          <Text dimColor>├─ Root cause </Text>
          <Text color="yellow">{crash.rootCause}</Text>
          {crash.confidence !== undefined && (
            <Text dimColor>  (confidence: {Math.round(crash.confidence * 100)}%)</Text>
          )}
        </Box>
      )}
      {crash.triageNotes && (
        <Box>
          <Text dimColor>├─ Analysis  </Text>
          <Text>{truncate(crash.triageNotes, 100)}</Text>
        </Box>
      )}
      {crash.duplicateOf && (
        <Box>
          <Text dimColor>├─ Note      </Text>
          <Text color="gray">Same root cause as crash {crash.duplicateOf}</Text>
        </Box>
      )}
      {crash.responseBody && (
        <Box>
          <Text dimColor>├─ Response  </Text>
          <Text>{truncate(crash.responseBody.replace(/\n/g, ' '), 80)}</Text>
        </Box>
      )}
      <Box flexDirection="column">
        <Text dimColor>└─ Reproducer:</Text>
        <Box paddingLeft={3}>
          <Text color="cyan" dimColor>
            {truncate(crash.curlReproducer.replace(/\s*\\\n\s*/g, ' '), 100)}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Root cause label display helper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function rootCauseColor(rc: CrashRootCause): string {
  switch (rc) {
    case 'sql-error':
    case 'nosql-error':
    case 'injection':
    case 'path-traversal':
    case 'auth-bypass':
      return 'red';
    case 'integer-overflow':
    case 'null-pointer':
    case 'memory-error':
    case 'timeout-hang':
      return 'yellow';
    default:
      return 'white';
  }
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
