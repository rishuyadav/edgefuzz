/**
 * JSON report writer.
 *
 * Writes a structured `edgefuzz-report.json` file that is:
 *  - CI-parseable (exit-code + structured output)
 *  - Human-readable (pretty-printed)
 *  - Machine-readable for downstream tooling
 */

import { writeFile } from 'fs/promises';
import path from 'path';
import type { FuzzReport, CrashFinding, ParsedSpec } from '../types/index.js';

export interface ReportInput {
  spec: ParsedSpec;
  crashes: CrashFinding[];
  totalRequests: number;
  durationMs: number;
}

/**
 * Build the structured FuzzReport object from a completed fuzzing session.
 */
export function buildReport(input: ReportInput): FuzzReport {
  const { spec, crashes, totalRequests, durationMs } = input;
  const requestsPerSecond =
    durationMs > 0 ? Math.round((totalRequests / durationMs) * 1000) : 0;

  return {
    version: '1',
    generatedAt: new Date().toISOString(),
    target: spec.baseUrl,
    specSource: spec.specSource,
    summary: {
      totalRequests,
      totalEndpoints: spec.endpoints.length,
      totalCrashes: crashes.length,
      durationMs,
      requestsPerSecond,
    },
    crashes,
  };
}

/**
 * Write the report to disk as a pretty-printed JSON file.
 * Returns the resolved absolute path it was written to.
 */
export async function writeReport(report: FuzzReport, reportPath: string): Promise<string> {
  const resolved = path.resolve(reportPath);
  const content = JSON.stringify(report, null, 2);
  await writeFile(resolved, content, 'utf-8');
  return resolved;
}
