/**
 * Tests for the includeMethods filter introduced in P0-2.
 *
 * Verifies that when includeMethods is set, only operations with matching
 * HTTP methods are fuzzed, and non-matching operations are silently skipped
 * rather than producing zero-request scans that look like success.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDemoServer } from '../src/demo/server.js';
import { runFuzzSession } from '../src/engine.js';
import type { EdgeFuzzConfig } from '../src/types/index.js';

let demoUrl = '';
let demoSpecUrl = '';
let closeDemo: () => Promise<void>;

before(async () => {
  const demo = await startDemoServer();
  demoUrl = demo.url;
  demoSpecUrl = demo.specUrl;
  closeDemo = demo.close;
});

after(async () => {
  await closeDemo();
});

function cfg(overrides: Partial<EdgeFuzzConfig> = {}): EdgeFuzzConfig {
  return {
    targetUrl: demoUrl,
    specPath: demoSpecUrl,
    concurrency: 10,
    timeoutMs: 8000,
    reportPath: false,
    ci: true,
    headers: {},
    llmMutations: false,
    llmTriage: false,
    ...overrides,
  };
}

describe('includeMethods filter', () => {

  it('fuzz only GET when includeMethods=["GET"]', async () => {
    const report = await runFuzzSession(cfg({ includeMethods: ['GET'] }));

    const nonGetCrashes = report.crashes.filter(c => c.endpoint.method !== 'GET');
    assert.equal(
      nonGetCrashes.length,
      0,
      `Expected 0 non-GET crashes with includeMethods=["GET"]; got ${nonGetCrashes.length}: ` +
      nonGetCrashes.map(c => `${c.endpoint.method} ${c.endpoint.path}`).join(', '),
    );
  });

  it('fuzz only POST when includeMethods=["POST"]', async () => {
    const report = await runFuzzSession(cfg({ includeMethods: ['POST'] }));

    const nonPostCrashes = report.crashes.filter(c => c.endpoint.method !== 'POST');
    assert.equal(
      nonPostCrashes.length,
      0,
      `Expected 0 non-POST crashes with includeMethods=["POST"]; got ${nonPostCrashes.length}`,
    );

    // POST /courses and POST /enroll both have known bugs — at least one must appear
    assert.ok(
      report.crashes.length >= 1,
      'Expected at least 1 crash from POST endpoints',
    );
  });

  it('path + method filter: only POST /enroll is fuzzed', async () => {
    const report = await runFuzzSession(cfg({
      includePaths: ['/enroll'],
      includeMethods: ['POST'],
    }));

    // Every crash must be POST /enroll
    for (const crash of report.crashes) {
      assert.equal(crash.endpoint.method, 'POST', `Method must be POST, got ${crash.endpoint.method}`);
      assert.equal(crash.endpoint.path, '/enroll', `Path must be /enroll, got ${crash.endpoint.path}`);
    }

    // We know POST /enroll has at least one bug
    assert.ok(report.crashes.length >= 1, 'Expected at least 1 crash from POST /enroll');
  });

  it('method filter does not affect totalRequests count (> 0)', async () => {
    const report = await runFuzzSession(cfg({ includeMethods: ['POST'] }));
    assert.ok(report.summary.totalRequests > 0, 'Must send at least some requests');
  });

  it('path+method filter: no requests generated for non-existent combination', async () => {
    // /stats only exposes GET — filtering for DELETE should send 0 requests
    const report = await runFuzzSession(cfg({
      includePaths: ['/stats'],
      includeMethods: ['DELETE'],
    }));

    assert.equal(
      report.summary.totalRequests,
      0,
      `Expected 0 requests for DELETE /stats (not in spec); got ${report.summary.totalRequests}`,
    );
    assert.equal(report.crashes.length, 0, 'Expected 0 crashes when no operations match');
  });

  it('no includeMethods = fuzz all methods (baseline check)', async () => {
    // Without a method filter, mixed methods are covered
    const allReport = await runFuzzSession(cfg());
    const getOnlyReport = await runFuzzSession(cfg({ includeMethods: ['GET'] }));

    // A full run should generally send more requests than a GET-only run
    assert.ok(
      allReport.summary.totalRequests > getOnlyReport.summary.totalRequests,
      `Full run (${allReport.summary.totalRequests}) must send more requests than GET-only (${getOnlyReport.summary.totalRequests})`,
    );
  });

});
