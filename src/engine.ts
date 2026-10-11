/**
 * EdgeFuzz Core Engine.
 *
 * Orchestrates all pipeline stages and emits ProgressEvents
 * for consumption by the TUI or CI reporter.
 *
 *   Stage 1: Parse OpenAPI spec
 *   Stage 2: Generate mutations (static always, +LLM semantic if --llm-mutations)
 *   Stage 3: Execute requests concurrently
 *   Stage 4: Analyse and deduplicate crashes
 *   Stage 4b: LLM crash triage (opt-in via --triage, only when crashes > 0)
 *   Stage 5: Generate reports (JSON)
 */

import { parseSpec } from './parser/openapi.js';
import { generateMutations, countStaticMutations } from './mutator/index.js';
import { executeRequests } from './runner/executor.js';
import { analyseCrash, deduplicateFindings } from './analyzer/crash.js';
import { analyseResponse } from './analyzer/response.js';
import { triageCrashes } from './analyzer/triage.js';
import { buildReport, writeReport } from './reporter/json.js';
import { detectLLMProvider } from './reporter/llm.js';
import { TokenProvider } from './auth/token-provider.js';
import type {
  EdgeFuzzConfig,
  ProgressEvent,
  CrashFinding,
  ResponseMismatch,
  FuzzReport,
  HttpMethod,
  PreflightSummary,
  RunDiagnostics,
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

  // Initialise auth token provider if --auth-command is configured
  const tokenProvider = config.authCommand
    ? new TokenProvider(config.authCommand)
    : undefined;

  // ------------------------------------------------------------------
  // Stage 1: Parse spec
  // ------------------------------------------------------------------
  const spec = await parseSpec(config.specPath, config.targetUrl);

  // Apply path and method filters
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
  if (config.includeMethods && config.includeMethods.length > 0) {
    const methods = new Set(config.includeMethods);
    endpoints = endpoints.filter((e) => methods.has(e.method));
  }
  const filteredSpec = { ...spec, endpoints };

  // ------------------------------------------------------------------
  // Preflight summary — emitted before any mutations or requests
  // ------------------------------------------------------------------

  const WRITE_METHODS: HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];
  const activatedWriteMethods = filteredSpec.endpoints
    .map((e) => e.method)
    .filter((m): m is HttpMethod => WRITE_METHODS.includes(m))
    .filter((m, i, arr) => arr.indexOf(m) === i)  // deduplicate
    .sort();

  const estimatedRequests = countStaticMutations(filteredSpec.endpoints);

  const preflight: PreflightSummary = {
    specSource: filteredSpec.specSource,
    totalOperations: spec.endpoints.length,
    filteredOperations: filteredSpec.endpoints.length,
    estimatedRequests,
    writeMethods: activatedWriteMethods,
    concurrency: config.concurrency,
    llmMutations: config.llmMutations && llmEnabled,
    llmTriage: (config.llmTriage ?? false) && llmEnabled,
    dryRun: config.dryRun ?? false,
    operations: filteredSpec.endpoints.map((e) => ({ method: e.method, path: e.path })),
  };

  emit({ type: 'preflight', summary: preflight });

  // Dry run: stop here — no mutations generated, no requests sent.
  if (config.dryRun) {
    const report = buildReport({
      spec: filteredSpec,
      crashes: [],
      mismatches: [],
      totalRequests: 0,
      llmMutationCount: 0,
      llmEnabled,
      durationMs: Date.now() - startTime,
      triageEnabled: false,
    });
    emit({ type: 'done', report });
    return report;
  }

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
    // Fire a per-endpoint event as each LLM call completes so the TUI can
    // render a live checklist of which endpoints have been processed.
    onLlmProgress: useLlmMutations
      ? (done, total, endpoint, count) =>
          emit({ type: 'llm_mutation_endpoint_done', method: endpoint.method, path: endpoint.path, count, done, total })
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
  const allMismatches: ResponseMismatch[] = [];
  const seenCrashIds = new Set<string>();
  const seenMismatchIds = new Set<string>();

  // Diagnostics counters — distinguish server crashes from transport failures
  const diag: RunDiagnostics = {
    serverErrors: 0,
    timeouts: 0,
    transportErrors: 0,
    clientErrors: 0,
    successResponses: 0,
    total: 0,
  };

  await executeRequests(mutations, {
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    tokenProvider,
    tlsInsecure: config.tlsInsecure,
    requestDelay: config.requestDelay,
    onResult: (result) => {
      emit({ type: 'request_done', result });

      // Track outcome for diagnostics
      diag.total += 1;
      if (result.timedOut) {
        diag.timeouts += 1;
      } else if (result.networkError) {
        // Distinguish pre-connection failures (ECONNREFUSED = server not running)
        // from mid-connection failures (server crashed mid-response)
        const code = (result.networkErrorCode ?? '').toUpperCase();
        const msg = (result.networkErrorMessage ?? '').toLowerCase();
        const isPreConnect = code === 'ECONNREFUSED' || msg.includes('econnrefused');
        if (isPreConnect) {
          diag.transportErrors += 1;
        } else {
          // Server accepted the connection then died — counts as a server-side failure
          diag.serverErrors += 1;
        }
      } else if (result.statusCode >= 500) {
        diag.serverErrors += 1;
      } else if (result.statusCode >= 400) {
        diag.clientErrors += 1;
      } else {
        diag.successResponses += 1;
      }

      // Crash detection (5xx / timeout / network error)
      const crash = analyseCrash(result);
      if (crash && !seenCrashIds.has(crash.id)) {
        seenCrashIds.add(crash.id);
        allCrashes.push(crash);
        emit({ type: 'crash_found', crash });
      }

      // Response contract validation (wrong types, missing fields, data leakage)
      // Skipped when --no-response-validation is set
      if (!config.skipResponseValidation) {
        const mismatches = analyseResponse(result);
        for (const m of mismatches) {
          if (!seenMismatchIds.has(m.id)) {
            seenMismatchIds.add(m.id);
            allMismatches.push(m);
            emit({ type: 'mismatch_found', mismatch: m });
          }
        }
      }
    },
  });

  // Emit a diagnostics event so reporters can surface it
  emit({ type: 'diagnostics', diag });

  // ------------------------------------------------------------------
  // Stage 4: Deduplicate
  // ------------------------------------------------------------------
  const dedupedCrashes = deduplicateFindings(allCrashes);

  // ------------------------------------------------------------------
  // Stage 4b: LLM crash triage (opt-in — only when --triage is set)
  // ------------------------------------------------------------------
  // Key guardrails vs. the old always-on design:
  //   1. Only runs if --triage flag was explicitly passed
  //   2. Only runs if there are actual crashes (no LLM call on clean runs)
  //   3. Crashes pre-sorted by endpoint path inside triageCrashes() to improve
  //      duplicateOf detection accuracy
  const useLlmTriage = config.llmTriage === true && llmEnabled && dedupedCrashes.length > 0;

  if (useLlmTriage && llmConfig) {
    emit({ type: 'triage_start', crashCount: dedupedCrashes.length });
    // Pass onBatchDone so the TUI receives partial results in real time,
    // rendering classified crashes as each batch of 20 completes rather than
    // waiting for the full triage run to finish.
    await triageCrashes(dedupedCrashes, llmConfig, (batchIndex, totalBatches, results) => {
      emit({ type: 'triage_batch_done', batchIndex, totalBatches, results });
    });
    const duplicateCount = dedupedCrashes.filter((c) => c.duplicateOf !== undefined).length;
    emit({ type: 'triage_done', duplicateCount });
  }

  // ------------------------------------------------------------------
  // Stage 5: Build report
  // ------------------------------------------------------------------
  const durationMs = Date.now() - startTime;

  const report = buildReport({
    spec: filteredSpec,
    crashes: dedupedCrashes,
    mismatches: allMismatches,
    totalRequests: mutations.length,
    llmMutationCount,
    llmEnabled,
    durationMs,
    triageEnabled: useLlmTriage,
    diagnostics: diag,
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

  let sessionError: unknown = undefined;
  const sessionPromise = runFuzzSession(config, push).then(
    () => {
      done = true;
      resolve?.();
      resolve = null;
    },
    (err) => {
      sessionError = err;
      done = true;
      resolve?.();
      resolve = null;
    },
  );

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
  if (sessionError !== undefined) {
    throw sessionError;
  }
}
