/**
 * EdgeFuzz Core Engine.
 *
 * Orchestrates all five pipeline stages and emits ProgressEvents
 * for consumption by the TUI or CI reporter.
 *
 *   Stage 1: Parse OpenAPI spec
 *   Stage 2: Generate mutations (static always, +LLM semantic if --llm-mutations)
 *   Stage 3: Execute requests concurrently
 *   Stage 4: Analyse and deduplicate crashes
 *   Stage 4b: LLM crash triage (if key present and llmTriage enabled)
 *   Stage 5: Generate reports (JSON)
 */

import { parseSpec } from './parser/openapi.js';
import { generateMutations } from './mutator/index.js';
import { executeRequests } from './runner/executor.js';
import { analyseCrash, deduplicateFindings } from './analyzer/crash.js';
import { buildReport, writeReport } from './reporter/json.js';
import { detectLLMProvider } from './reporter/llm.js';
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

  // Detect LLM availability once — used across multiple stages
  const llmConfig = detectLLMProvider(config.llmProvider, config.llmModel, config.llmBaseUrl);
  const llmEnabled = llmConfig !== null;

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
  // Stage 2: Generate mutations (static + optional LLM semantic)
  // ------------------------------------------------------------------

  const useLlmMutations = config.llmMutations && llmEnabled;

  if (useLlmMutations) {
    emit({
      type: 'llm_mutations_generating',
      endpointCount: filteredSpec.endpoints.length,
    });
  }

  const mutations = await generateMutations(filteredSpec, {
    llmMutations: useLlmMutations,
    llmConfig: llmConfig ?? undefined,
    onLlmProgress: useLlmMutations
      ? (done, total) => emit({ type: 'llm_mutations_ready', count: done })
      : undefined,
  });

  // Count how many mutations are LLM-generated for the report summary
  const llmMutationCount = mutations.filter((m) => m.mutationSource === 'llm').length;

  if (useLlmMutations) {
    emit({ type: 'llm_mutations_ready', count: llmMutationCount });
  }

  // Inject any custom headers from config
  if (Object.keys(config.headers).length > 0) {
    for (const mut of mutations) {
      mut.headers = { ...config.headers, ...mut.headers };
    }
  }

  emit({
    type: 'start',
    totalRequests: mutations.length,
    totalEndpoints: filteredSpec.endpoints.length,
    llmEnabled,
  });

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
  // Stage 4b: LLM Crash Triage (Phase C)
  // ------------------------------------------------------------------
  if (llmEnabled && config.llmTriage && dedupedCrashes.length > 0) {
    emit({ type: 'triage_start', crashCount: dedupedCrashes.length });

    // Dynamically import triage to avoid loading it when LLM is disabled
    const { triageCrashes } = await import('./analyzer/triage.js');
    await triageCrashes(dedupedCrashes, llmConfig!);

    emit({ type: 'triage_done', crashes: dedupedCrashes });
  }

  // ------------------------------------------------------------------
  // Stage 5: Build report
  // ------------------------------------------------------------------
  const durationMs = Date.now() - startTime;

  const report = buildReport({
    spec: filteredSpec,
    crashes: dedupedCrashes,
    totalRequests: mutations.length,
    llmMutationCount,
    llmEnabled,
    durationMs,
  });

  if (config.reportPath !== false) {
    await writeReport(report, config.reportPath);
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

  const sessionPromise = runFuzzSession(config, push).then(() => {
    done = true;
    resolve?.();
    resolve = null;
  });

  while (true) {
    if (buffer.length > 0) {
      yield buffer.shift()!;
    } else if (done) {
      break;
    } else {
      await new Promise<void>((r) => {
        resolve = r;
      });
    }
  }

  await sessionPromise;
}
