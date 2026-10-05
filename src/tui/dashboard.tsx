/**
 * TUI Dashboard — built with Ink (React for CLIs).
 *
 * Renders a live progress dashboard during fuzzing, then switches
 * to a summary view when the run completes.
 *
 * Phases:
 *  preparing  → LLM generating semantic mutations (if --llm-mutations)
 *  running    → Fuzzing in progress
 *  triaging   → LLM crash triage (if --triage and crashes > 0)
 *  done       → Summary + crash details
 *
 * UX design:
 *  - preparing: per-endpoint checklist with progress bar + elapsed timer.
 *    Each endpoint lights up as its LLM call completes rather than showing
 *    a static spinner for the entire ~14s generation window.
 *  - triaging: per-crash stream as each batch of 20 completes. Last 10
 *    classified crashes visible; overflow shown as "(+N classified above)".
 *    Progress bar advances per-batch, not at the end.
 *  - running: unchanged live progress bar with inline crash list.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, Newline, useApp } from 'ink';
import Spinner from 'ink-spinner';
import type { ProgressEvent, CrashFinding, FuzzReport, CrashTriageResult } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardProps {
  target: string;
  specSource: string;
  events: AsyncIterable<ProgressEvent>;
}

type Phase = 'preparing' | 'running' | 'triaging' | 'done';

interface EndpointResult {
  method: string;
  path: string;
  count: number;
}

/** Flat, display-ready row for a triaged crash. */
interface TriageRow {
  crashId: string;
  method: string;
  path: string;
  rootCause: string;
  confidence: number;
  isDuplicate: boolean;
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function Dashboard({ target, specSource, events }: DashboardProps) {
  const { exit } = useApp();

  // --- Phase ---
  const [phase, setPhase] = useState<Phase>('running');

  // --- Fuzzing state ---
  const [totalRequests, setTotalRequests] = useState(0);
  const [doneRequests, setDoneRequests] = useState(0);
  const [crashes, setCrashes] = useState<CrashFinding[]>([]);
  const [report, setReport] = useState<FuzzReport | null>(null);
  const [rps, setRps] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [llmMutationCount, setLlmMutationCount] = useState(0);

  // --- LLM mutation generation state ---
  const [preparingTotal, setPreparingTotal] = useState(0);
  const [endpointResults, setEndpointResults] = useState<EndpointResult[]>([]);
  const [preparingElapsed, setPreparingElapsed] = useState(0);

  // --- LLM triage state ---
  const [triagingCrashCount, setTriagingCrashCount] = useState(0);
  const [triageBatchDone, setTriageBatchDone] = useState(0);
  const [triageTotalBatches, setTriageTotalBatches] = useState(0);
  const [triageRows, setTriageRows] = useState<TriageRow[]>([]);
  const [triageElapsed, setTriageElapsed] = useState(0);

  // --- Refs for non-reactive values ---
  const startTimeRef = useRef(Date.now());
  const preparingStartRef = useRef<number | null>(null);
  const triagingStartRef = useRef<number | null>(null);
  const doneRef = useRef(0);
  // Mirror of crashes state for use inside async event loop without stale closure
  const crashesRef = useRef<CrashFinding[]>([]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;

    const consume = async () => {
      // Tick every 200ms — update elapsed counters for all active phases
      timer = setInterval(() => {
        const now = Date.now();
        const fuzzElapsed = (now - startTimeRef.current) / 1000;
        setElapsedSec(Math.floor(fuzzElapsed));
        setRps(fuzzElapsed > 0 ? Math.round(doneRef.current / fuzzElapsed) : 0);

        if (preparingStartRef.current !== null) {
          setPreparingElapsed(Math.floor((now - preparingStartRef.current) / 1000));
        }
        if (triagingStartRef.current !== null) {
          setTriageElapsed(Math.floor((now - triagingStartRef.current) / 1000));
        }
      }, 200);

      for await (const event of events) {
        switch (event.type) {

          case 'llm_mutations_generating':
            setPhase('preparing');
            setPreparingTotal(event.endpointCount);
            preparingStartRef.current = Date.now();
            break;

          case 'llm_mutation_endpoint_done':
            setEndpointResults((prev) => [
              ...prev,
              { method: event.method, path: event.path, count: event.count },
            ]);
            break;

          case 'llm_mutations_ready':
            setLlmMutationCount(event.count);
            break;

          case 'start':
            setTotalRequests(event.totalRequests);
            setLlmEnabled(event.llmEnabled);
            setPhase('running');
            // Reset fuzz timer at the moment fuzzing actually starts
            // (after any LLM mutation generation completes)
            startTimeRef.current = Date.now();
            doneRef.current = 0;
            preparingStartRef.current = null;
            break;

          case 'request_done':
            doneRef.current += 1;
            setDoneRequests((n) => n + 1);
            break;

          case 'crash_found':
            setCrashes((prev) => {
              if (prev.find((c) => c.id === event.crash.id)) return prev;
              const next = [...prev, event.crash];
              crashesRef.current = next;
              return next;
            });
            break;

          case 'triage_start':
            setTriagingCrashCount(event.crashCount);
            setTriageTotalBatches(Math.ceil(event.crashCount / 20));
            triagingStartRef.current = Date.now();
            setPhase('triaging');
            break;

          case 'triage_batch_done': {
            setTriageBatchDone(event.batchIndex + 1);
            // Resolve method + path from the crash ref so we can display them inline.
            // CrashFindings have already been mutated in-place by applyTriageResults,
            // but we build TriageRow from the event.results to ensure we have the
            // rootCause/confidence that came back from this specific batch.
            const newRows: TriageRow[] = event.results.map((r: CrashTriageResult) => {
              const crash = crashesRef.current.find((c) => c.id === r.crashId);
              return {
                crashId: r.crashId,
                method: crash?.endpoint.method ?? '',
                path: crash?.endpoint.path ?? '',
                rootCause: r.rootCause,
                confidence: r.confidence,
                isDuplicate: !!r.duplicateOf,
              };
            });
            setTriageRows((prev) => [...prev, ...newRows]);
            break;
          }

          case 'triage_done':
            // triage_done just signals completion; phase transitions via 'done'
            break;

          case 'done':
            clearInterval(timer);
            preparingStartRef.current = null;
            triagingStartRef.current = null;
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

  // --- Render by phase ---

  if (phase === 'preparing') {
    return (
      <PreparingView
        total={preparingTotal}
        results={endpointResults}
        elapsedSec={preparingElapsed}
      />
    );
  }

  if (phase === 'triaging') {
    return (
      <TriagingView
        crashCount={triagingCrashCount}
        batchDone={triageBatchDone}
        totalBatches={triageTotalBatches}
        rows={triageRows}
        elapsedSec={triageElapsed}
      />
    );
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
// Preparing view — per-endpoint LLM mutation generation checklist
// ---------------------------------------------------------------------------

interface PreparingViewProps {
  total: number;
  results: EndpointResult[];
  elapsedSec: number;
}

function PreparingView({ total, results, elapsedSec }: PreparingViewProps) {
  const done = results.length;
  const barWidth = 28;
  const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const stillRunning = done < total;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">⚡ EdgeFuzz</Text>
        <Text color="magenta">  [LLM mode]</Text>
        <Text dimColor>  —  generating semantic mutations</Text>
      </Box>

      {/* Progress bar */}
      <Box marginBottom={1}>
        <Text color="magenta">{bar}</Text>
        <Text>{'  '}</Text>
        <Text bold>{done}</Text>
        <Text dimColor> / {total} endpoints</Text>
        <Text dimColor>{'  '}{elapsedSec}s</Text>
      </Box>

      {/* Completed endpoint checklist */}
      {results.map((r) => (
        <Box key={`${r.method}:${r.path}`}>
          <Text color="green">  ✓ </Text>
          <Text bold color="white">{r.method.padEnd(6)}</Text>
          <Text>{r.path.padEnd(35)}</Text>
          <Text dimColor>
            {r.count > 0
              ? `${r.count} payload${r.count !== 1 ? 's' : ''}`
              : 'no domain-specific payloads'}
          </Text>
        </Box>
      ))}

      {/* In-flight indicator */}
      {stillRunning && (
        <Box marginTop={results.length > 0 ? 0 : 1}>
          <Text color="yellow">  </Text>
          <Spinner type="dots" />
          <Text dimColor>  generating...</Text>
        </Box>
      )}

      {/* Explanatory footer shown while waiting */}
      {stillRunning && (
        <Box marginTop={1}>
          <Text dimColor>
            LLM reads each endpoint schema and generates domain-specific adversarial payloads.
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Triaging view — per-batch streaming crash classification
// ---------------------------------------------------------------------------

interface TriagingViewProps {
  crashCount: number;
  batchDone: number;
  totalBatches: number;
  rows: TriageRow[];
  elapsedSec: number;
}

/** Max number of triage rows to show at once; older rows scroll off with a count. */
const TRIAGE_VISIBLE_ROWS = 10;

function TriagingView({ crashCount, batchDone, totalBatches, rows, elapsedSec }: TriagingViewProps) {
  const barWidth = 28;
  const filled = totalBatches > 0 ? Math.round((batchDone / totalBatches) * barWidth) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const stillRunning = batchDone < totalBatches;

  // Show only the last TRIAGE_VISIBLE_ROWS rows; surface overflow count above them
  const overflowCount = Math.max(0, rows.length - TRIAGE_VISIBLE_ROWS);
  const visibleRows = rows.slice(-TRIAGE_VISIBLE_ROWS);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">⚡ EdgeFuzz</Text>
        <Text color="magenta">  [LLM triage]</Text>
        <Text dimColor>
          {'  —  classifying '}
          <Text bold color="yellow">{crashCount}</Text>
          {` crash${crashCount !== 1 ? 'es' : ''}`}
        </Text>
      </Box>

      {/* Progress bar */}
      <Box marginBottom={1}>
        <Text color="magenta">{bar}</Text>
        <Text>{'  '}</Text>
        <Text bold>batch {batchDone}</Text>
        <Text dimColor> / {totalBatches}</Text>
        <Text dimColor>{'  '}{elapsedSec}s</Text>
      </Box>

      {/* Overflow indicator */}
      {overflowCount > 0 && (
        <Box>
          <Text dimColor>  (+{overflowCount} classified above)</Text>
        </Box>
      )}

      {/* Streaming classified crash rows */}
      {visibleRows.map((row, i) => (
        <TriageResultRow key={`${row.crashId}-${i}`} row={row} />
      ))}

      {/* In-flight indicator */}
      {stillRunning && (
        <Box marginTop={visibleRows.length > 0 ? 0 : 1}>
          <Text color="yellow">  </Text>
          <Spinner type="dots" />
          <Text dimColor>  batch {batchDone + 1} / {totalBatches} running...</Text>
        </Box>
      )}
    </Box>
  );
}

interface TriageResultRowProps {
  row: TriageRow;
}

function TriageResultRow({ row }: TriageResultRowProps) {
  const rootCauseColor =
    row.rootCause === 'sql-error' || row.rootCause === 'auth-bypass' || row.rootCause === 'injection'
      ? 'red'
      : row.rootCause === 'validation-missing' || row.rootCause === 'type-coercion'
        ? 'yellow'
        : 'white';

  if (row.isDuplicate) {
    return (
      <Box>
        <Text color="green">  ✓ </Text>
        <Text bold>{row.method.padEnd(6)}</Text>
        <Text>{row.path.padEnd(35)}</Text>
        <Text color={rootCauseColor}>{row.rootCause.padEnd(22)}</Text>
        <Text dimColor>  [dup]</Text>
      </Box>
    );
  }

  const pct = Math.round(row.confidence * 100);
  const confColor = pct >= 80 ? 'green' : pct >= 50 ? 'yellow' : 'gray';

  return (
    <Box>
      <Text color="green">  ✓ </Text>
      <Text bold>{row.method.padEnd(6)}</Text>
      <Text>{row.path.padEnd(35)}</Text>
      <Text color={rootCauseColor}>{row.rootCause.padEnd(22)}</Text>
      <Text color={confColor}>  {pct}%</Text>
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
        <Text dimColor>  |  </Text>
        {llmEnabled ? (
          <>
            <Text color="magenta" bold>LLM✓</Text>
            {llmMutationCount > 0 && (
              <Text dimColor> +{llmMutationCount} semantic</Text>
            )}
          </>
        ) : (
          <Text dimColor>static-only mode</Text>
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

      {/* Live crash list — last 5 */}
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

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">⚡ EdgeFuzz Audit Complete</Text>
        {summary.llmMutations > 0
          ? <Text color="magenta">  [LLM-augmented]</Text>
          : <Text dimColor>  [static-only — set OPENAI_API_KEY to enable LLM features]</Text>
        }
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
            ✗ Found {crashes.length} crash{crashes.length !== 1 ? 'es' : ''}
            {report.summary.totalDuplicates !== undefined && report.summary.totalDuplicates > 0 && (
              <Text color="magenta"> ({report.summary.totalDuplicates} duplicate{report.summary.totalDuplicates !== 1 ? 's' : ''} grouped)</Text>
            )}
          </Text>
          <Newline />
          {crashes.map((crash, i) => (
            <Box key={crash.id} flexDirection="column" marginBottom={2}>
              <Text bold>
                {i + 1}. {crash.endpoint.method} {crash.endpoint.path}
                {crash.mutationSource === 'llm' && <Text color="magenta"> [LLM payload]</Text>}
                {crash.duplicateOf && <Text dimColor> [dup]</Text>}
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
  const severityColor =
    crash.severity === 'critical' ? 'red'
      : crash.severity === 'high' ? 'yellow'
        : crash.severity === 'medium' ? 'white'
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

  const effectiveSeverity = crash.llmSeverity ?? crash.severity;

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
      </Box>
      {crash.rootCause && (
        <Box>
          <Text dimColor>├─ Root cause </Text>
          <Text color="magenta">{crash.rootCause}</Text>
          {crash.confidence !== undefined && (
            <Text dimColor>  ({Math.round(crash.confidence * 100)}% confidence)</Text>
          )}
        </Box>
      )}
      {crash.triageNotes && (
        <Box>
          <Text dimColor>├─ Analysis  </Text>
          <Text dimColor>{truncate(crash.triageNotes, 90)}</Text>
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
// Utils
// ---------------------------------------------------------------------------

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}
