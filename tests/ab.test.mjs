import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeAbDiff,
  runAbTest,
  startMockServer
} from '../bin/safe-load-lab.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('computeAbDiff - detects Variant B as winner when faster', () => {
  const summaryA = {
    testName: 'API v1',
    totals: { requests: 100, failed: 0, errorRate: 0, achievedRps: 10 },
    latencyMs: { avg: 50, p50: 45, p90: 80, p95: 100, p99: 120 }
  };
  const summaryB = {
    testName: 'API v2',
    totals: { requests: 150, failed: 0, errorRate: 0, achievedRps: 15 },
    latencyMs: { avg: 25, p50: 20, p90: 40, p95: 50, p99: 60 }
  };

  const diff = computeAbDiff(summaryA, summaryB, { maxLatencyDiff: 15, maxErrorDiff: 0 });

  assert.equal(diff.winner, 'B');
  assert.equal(diff.isRegression, false);
  assert.ok(diff.latencies.p95.pct < 0, 'p95 should be lower in B');
  assert.equal(diff.latencies.p95.pct, -50);
});

test('computeAbDiff - flags regression when Variant B is slower than allowed tolerance', () => {
  const summaryA = {
    testName: 'Base',
    totals: { requests: 100, failed: 0, errorRate: 0, achievedRps: 10 },
    latencyMs: { avg: 50, p50: 45, p90: 80, p95: 100, p99: 120 }
  };
  const summaryB = {
    testName: 'Canary',
    totals: { requests: 100, failed: 0, errorRate: 0, achievedRps: 10 },
    latencyMs: { avg: 80, p50: 75, p90: 120, p95: 140, p99: 160 }
  };

  const diff = computeAbDiff(summaryA, summaryB, { maxLatencyDiff: 15, maxErrorDiff: 0 });

  assert.equal(diff.isRegression, true);
  assert.equal(diff.winner, 'A');
  assert.match(diff.regressionReason, /Latency degraded in Variant B/);
});

test('computeAbDiff - flags regression when Variant B has higher error rate', () => {
  const summaryA = {
    testName: 'Base',
    totals: { requests: 100, failed: 0, errorRate: 0, achievedRps: 10 },
    latencyMs: { avg: 50, p50: 45, p90: 80, p95: 100, p99: 120 }
  };
  const summaryB = {
    testName: 'Canary',
    totals: { requests: 100, failed: 5, errorRate: 0.05, achievedRps: 10 },
    latencyMs: { avg: 45, p50: 40, p90: 70, p95: 85, p99: 100 }
  };

  const diff = computeAbDiff(summaryA, summaryB, { maxLatencyDiff: 15, maxErrorDiff: 0 });

  assert.equal(diff.isRegression, true);
  assert.match(diff.regressionReason, /Error rate increased/);
});

test('computeAbDiff - detects similar performance within tolerance', () => {
  const summaryA = {
    testName: 'A',
    totals: { requests: 100, failed: 0, errorRate: 0, achievedRps: 10 },
    latencyMs: { avg: 50, p50: 45, p90: 80, p95: 100, p99: 120 }
  };
  const summaryB = {
    testName: 'B',
    totals: { requests: 100, failed: 0, errorRate: 0, achievedRps: 10 },
    latencyMs: { avg: 51, p50: 46, p90: 81, p95: 101, p99: 121 }
  };

  const diff = computeAbDiff(summaryA, summaryB, { maxLatencyDiff: 15, maxErrorDiff: 0 });

  assert.equal(diff.winner, 'similar');
  assert.equal(diff.isRegression, false);
});

test('runAbTest - end-to-end A/B differential load test with mock server', async () => {
  const mockPort = 3948;
  const server = startMockServer(mockPort, '127.0.0.1');

  try {
    const jsonOut = path.join(root, 'reports', 'test-ab-e2e.json');
    const htmlOut = path.join(root, 'reports', 'test-ab-e2e.html');
    const mdOut = path.join(root, 'reports', 'test-ab-e2e.md');

    const result = await runAbTest({
      'url-a': `http://127.0.0.1:${mockPort}/fast`,
      'url-b': `http://127.0.0.1:${mockPort}/slow?delay=100`,
      duration: 2,
      concurrency: 2,
      rps: 5,
      'i-own-this-target': true,
      out: jsonOut,
      html: htmlOut,
      markdown: mdOut
    });

    assert.ok(result.diff);
    assert.ok(result.runA);
    assert.ok(result.runB);
    assert.equal(result.diff.winner, 'A', 'Fast endpoint should win against slow endpoint');

    assert.ok(fs.existsSync(jsonOut), 'JSON report created');
    assert.ok(fs.existsSync(htmlOut), 'HTML report created');
    assert.ok(fs.existsSync(mdOut), 'Markdown report created');

    const jsonContent = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
    assert.equal(jsonContent.diff.winner, 'A');

    const htmlContent = fs.readFileSync(htmlOut, 'utf8');
    assert.match(htmlContent, /A\/B Differential Report/);

    const mdContent = fs.readFileSync(mdOut, 'utf8');
    assert.match(mdContent, /A\/B Differential Load Test Report/);
  } finally {
    server.close();
  }
});
