/**
 * EdgeFuzz Core Engine.
 *
 * Orchestrates all five pipeline stages and emits ProgressEvents
 * for consumption by the TUI or CI reporter.
 *
 *   Stage 1: Parse OpenAPI spec
 *   Stage 2: Generate adversarial mutations
 *   Stage 3: Execute requests concurrently
 *   Stage 4: Analyse and deduplicate crashes
 *   Stage 5: Generate reports (JSON + optional LLM)
 */

import { parseSpec } from './parser/openapi.js';
import { generateMutations } from './mutator/index.js';
import { executeRequests } from './runner/executor.js';
import { analyseCrash, deduplicateFindings } from './analyzer/crash.js';
import { buildReport, writeReport } from './reporter/json.js';
import { detectLLMProvider, generateFixSuggestion } from './reporter/llm.js';
import type {
  EdgeFuzzConfig,
  ProgressEvent,
  CrashFinding,
  FuzzReport,
} from './types/index.js';

// ---------------------------------------------------------------------------
// Primary entry point — returns a FuzzReport
// ---------------------------------------------------------------------------

/**
 * Run a complete EdgeFuzz fuzzing session.
 *
 * Accepts a config and an optional event emitter callback for progress updates.
 * Returns the final FuzzReport when complete.
 */
export async function runFuzzSession(
  config: EdgeFuzzConfig,
  onEvent?: (event: ProgressEvent) => void,
): Promise<FuzzReport> {
  const emit = onEvent ?? (() => {});
  const startTime = Date.now();

  // ------------------------------------------------------------------
  // Stage 1: Parse spec
  // ------------------------------------------------------------------
  const spec = await parseSpec(config.specPath, config.targetUrl);

  // Apply path filters
  let endpoints = spec.endpoints;
  if (config.includePaths && config.includePaths.length > 0) {
    endpoints = endpoints.filter((e) =>
      config.includePaths!.some((prefix) => e.path.startsWith(prefix)),
    );
  }
  if (config.excludePaths && config.excludePaths.length > 0) {
    endpoints = endpoints.filter(
      (e) => !config.excludePaths!.some((prefix) => e.path.startsWith(prefix)),
    );
  }
  const filteredSpec = { ...spec, endpoints };

  // ------------------------------------------------------------------
  // Stage 2: Generate mutations
  // ------------------------------------------------------------------
  const mutations = generateMutations(filteredSpec);

  // Inject any custom headers from config
  if (Object.keys(config.headers).length > 0) {
    for (const mut of mutations) {
      mut.headers = { ...config.headers, ...mut.headers };
    }
  }

  emit({ type: 'start', totalRequests: mutations.length, totalEndpoints: filteredSpec.endpoints.length });

  // ------------------------------------------------------------------
  // Stage 3: Execute concurrently
  // ------------------------------------------------------------------
  const allCrashes: CrashFinding[] = [];
  const seenIds = new Set<string>();

  await executeRequests(mutations, {
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    onResult: (result) => {
      emit({ type: 'request_done', result });

      const crash = analyseCrash(result);
      if (crash && !seenIds.has(crash.id)) {
        seenIds.add(crash.id);
        allCrashes.push(crash);
        emit({ type: 'crash_found', crash });
      }
    },
  });

  // ------------------------------------------------------------------
  // Stage 4: Deduplicate
  // ------------------------------------------------------------------
  const dedupedCrashes = deduplicateFindings(allCrashes);

  // ------------------------------------------------------------------
  // Stage 5: Build report
  // ------------------------------------------------------------------
  const durationMs = Date.now() - startTime;

  const report = buildReport({
    spec: filteredSpec,
    crashes: dedupedCrashes,
    totalRequests: mutations.length,
    durationMs,
  });

  // Write JSON report to disk (unless disabled)
  if (config.reportPath !== false) {
    await writeReport(report, config.reportPath);
  }

  // ------------------------------------------------------------------
  // Optional: LLM fix suggestions
  // ------------------------------------------------------------------
  const llmConfig = config.llmProvider
    ? { provider: config.llmProvider, apiKey: '', model: config.llmModel }
    : detectLLMProvider();

  if (llmConfig && dedupedCrashes.length > 0) {
    // Run LLM suggestions in parallel (max 3 concurrent to avoid rate limits)
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(3);

    await Promise.all(
      dedupedCrashes.map((crash) =>
        limit(async () => {
          const suggestion = await generateFixSuggestion(crash, llmConfig);
          if (suggestion) {
            crash.llmFixSuggestion = suggestion;
            emit({ type: 'llm_suggestion', crashId: crash.id, suggestion });
          }
        }),
      ),
    );

    // Re-write the report with suggestions included
    if (config.reportPath !== false) {
      await writeReport(report, config.reportPath);
    }
  }

  emit({ type: 'done', report });

  return report;
}

// ---------------------------------------------------------------------------
// Async generator wrapper — for TUI consumption
// ---------------------------------------------------------------------------

/**
 * Run a fuzz session and yield ProgressEvents as an async iterable.
 * This is the interface consumed by the TUI Dashboard component.
 */
export async function* runFuzzSessionStream(
  config: EdgeFuzzConfig,
): AsyncGenerator<ProgressEvent> {
  const buffer: ProgressEvent[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  const push = (event: ProgressEvent) => {
    buffer.push(event);
    resolve?.();
    resolve = null;
  };

  // Run session in background, pushing events into the buffer
  const sessionPromise = runFuzzSession(config, push).then(() => {
    done = true;
    resolve?.();
    resolve = null;
  });

  // Yield events as they arrive
  while (true) {
    if (buffer.length > 0) {
      yield buffer.shift()!;
    } else if (done) {
      break;
    } else {
      // Park until next event
      await new Promise<void>((r) => {
        resolve = r;
      });
    }
  }

  // Ensure session promise is awaited (surfaces errors)
  await sessionPromise;
}
