import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  startMockServer,
  parseCurlCommand,
  normalizeConfig,
  evaluateAssertions,
  evaluateThresholds,
  parseHeaders,
  parseArgs,
  computeAbDiff,
  generateMarkdownReport,
  generateAbMarkdownReport,
  HARD_LIMITS
} from '../bin/safe-load-lab.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'safe-load-lab.js');

function runCLI(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
}

// ─── 1. Mock Server QA Tests ──────────────────────────────────────────

test('QA Mock Server - handles /health endpoint', async () => {
  const port = 4101;
  const server = startMockServer(port, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.version);
    assert.ok(typeof body.uptime === 'number');
  } finally {
    server.close();
  }
});

test('QA Mock Server - handles /fast endpoint', async () => {
  const port = 4102;
  const server = startMockServer(port, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/fast`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.route, 'fast');
  } finally {
    server.close();
  }
});

test('QA Mock Server - handles /slow endpoint with custom delay', async () => {
  const port = 4103;
  const server = startMockServer(port, '127.0.0.1');
  try {
    const start = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/slow?delay=80`);
    const duration = Date.now() - start;
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.route, 'slow');
    assert.equal(body.delayedMs, 80);
    assert.ok(duration >= 70, `Expected duration >= 70ms, got ${duration}ms`);
  } finally {
    server.close();
  }
});

test('QA Mock Server - handles /error endpoint with custom status code', async () => {
  const port = 4104;
  const server = startMockServer(port, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/error?status=503`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, 503);
    assert.match(body.error, /Simulated error 503/);
  } finally {
    server.close();
  }
});

test('QA Mock Server - simulates rate limiting with 429 and Retry-After header', async () => {
  const port = 4105;
  const server = startMockServer(port, '127.0.0.1');
  try {
    // Limit is 3 requests per 2 seconds
    for (let i = 0; i < 3; i++) {
      const okRes = await fetch(`http://127.0.0.1:${port}/rate-limit?limit=3&window=2`);
      assert.equal(okRes.status, 200);
    }
    // 4th request must be rate limited
    const rateLimitedRes = await fetch(`http://127.0.0.1:${port}/rate-limit?limit=3&window=2`);
    assert.equal(rateLimitedRes.status, 429);
    assert.equal(rateLimitedRes.headers.get('retry-after'), '2');
    const body = await rateLimitedRes.json();
    assert.equal(body.error, 'Too Many Requests');
  } finally {
    server.close();
  }
});

test('QA Mock Server - echoes JSON body and headers', async () => {
  const port = 4106;
  const server = startMockServer(port, '127.0.0.1');
  try {
    const payload = { action: 'test', value: 12345 };
    const res = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Custom-Auth': 'secret-token'
      },
      body: JSON.stringify(payload)
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.method, 'POST');
    assert.equal(body.headers['x-custom-auth'], 'secret-token');
    assert.deepEqual(body.body, payload);
  } finally {
    server.close();
  }
});

// ─── 2. cURL Parser QA Tests ──────────────────────────────────────────

test('QA cURL Parser - parses simple GET', () => {
  const ep = parseCurlCommand('curl https://api.mytest.com/users');
  assert.equal(ep.method, 'GET');
  assert.equal(ep.url, 'https://api.mytest.com/users');
  assert.deepEqual(ep.headers, {});
  assert.equal(ep.body, null);
});

test('QA cURL Parser - parses POST with headers and data', () => {
  const ep = parseCurlCommand(
    `curl -X POST "https://api.mytest.com/orders" -H "Content-Type: application/json" -H "Authorization: Bearer my-secret-jwt" -d '{"item":"widget","qty":5}'`
  );
  assert.equal(ep.method, 'POST');
  assert.equal(ep.url, 'https://api.mytest.com/orders');
  assert.equal(ep.headers['Content-Type'], 'application/json');
  assert.equal(ep.headers['Authorization'], 'Bearer my-secret-jwt');
  assert.equal(ep.body, '{"item":"widget","qty":5}');
});

test('QA cURL Parser - infers POST when -d provided without -X', () => {
  const ep = parseCurlCommand(`curl https://api.mytest.com/submit -d 'message=hello'`);
  assert.equal(ep.method, 'POST');
  assert.equal(ep.body, 'message=hello');
});

test('QA cURL Parser - throws on invalid command without URL', () => {
  assert.throws(() => parseCurlCommand('curl -X GET -H "Auth: x"'), /No HTTP\/HTTPS URL found/);
});

// ─── 3. Assertions Engine QA Tests ────────────────────────────────────

test('QA Assertions - evaluates status, jsonPath, header, responseTime', () => {
  const mockResult = {
    status: 200,
    durationMs: 42.5,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-cache': 'HIT' },
    body: JSON.stringify({ user: { id: 101, name: 'Alice', active: true } })
  };

  const assertions = [
    { type: 'status', value: 200 },
    { type: 'jsonPath', path: 'user.name', equals: 'Alice' },
    { type: 'jsonPath', path: 'user.name', contains: 'Ali' },
    { type: 'header', name: 'x-cache', equals: 'HIT' },
    { type: 'header', name: 'content-type', contains: 'json' },
    { type: 'responseTime', lessThan: 100 }
  ];

  const results = evaluateAssertions(mockResult, assertions);
  assert.equal(results.length, 6);
  for (const r of results) {
    assert.equal(r.passed, true, `Assertion failed: ${r.type} ${r.message}`);
  }
});

test('QA Assertions - correctly fails when values mismatch', () => {
  const mockResult = {
    status: 500,
    durationMs: 250,
    headers: { 'content-type': 'text/plain' },
    body: 'Server Error'
  };

  const assertions = [
    { type: 'status', value: 200 },
    { type: 'responseTime', lessThan: 100 }
  ];

  const results = evaluateAssertions(mockResult, assertions);
  assert.equal(results.length, 2);
  assert.equal(results[0].passed, false);
  assert.equal(results[1].passed, false);
});

// ─── 4. Threshold Evaluation QA Tests ─────────────────────────────────

test('QA Thresholds - evaluates pass and fail', () => {
  const thresholds = { maxErrorRate: 0.05, p95Ms: 200, p99Ms: 400 };

  const passingMetrics = { errorRate: 0.01, p95: 150, p99: 300 };
  const passChecks = evaluateThresholds(thresholds, passingMetrics);
  assert.equal(passChecks.maxErrorRate.pass, true);
  assert.equal(passChecks.p95Ms.pass, true);
  assert.equal(passChecks.p99Ms.pass, true);

  const failingMetrics = { errorRate: 0.08, p95: 250, p99: 450 };
  const failChecks = evaluateThresholds(thresholds, failingMetrics);
  assert.equal(failChecks.maxErrorRate.pass, false);
  assert.equal(failChecks.p95Ms.pass, false);
  assert.equal(failChecks.p99Ms.pass, false);
});

// ─── 5. CLI Arguments & Safety QA Tests ───────────────────────────────

test('QA CLI - enforces safety flag requirement', () => {
  const res = runCLI(['run', '--url', 'http://127.0.0.1:8080/fast']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Missing required safety flag: --i-own-this-target/);
});

test('QA CLI - supports mock server command', () => {
  const port = 4107;
  const server = startMockServer(port, '127.0.0.1');
  assert.ok(server);
  server.close();
});

test('QA CLI - supports cURL execution via --curl', () => {
  const config = normalizeConfig({
    curl: 'curl -X GET http://127.0.0.1:8080/fast',
    duration: 5,
    concurrency: 2,
    rps: 5
  });
  assert.equal(config.endpoints.length, 1);
  assert.equal(config.endpoints[0].method, 'GET');
  assert.equal(config.endpoints[0].url, 'http://127.0.0.1:8080/fast');
});

test('QA CLI - clamps excessive parameters to safe limits', () => {
  const config = normalizeConfig({
    url: 'http://127.0.0.1:8080/fast',
    duration: 99999, // Should be clamped to 600
    concurrency: 500, // Should be clamped to 100
    rps: 1000 // Should be clamped to 200
  });

  assert.equal(config.durationSeconds, HARD_LIMITS.maxDurationSeconds);
  assert.equal(config.concurrency, HARD_LIMITS.maxConcurrency);
  assert.equal(config.rps, HARD_LIMITS.maxRps);
});

// ─── 6. Markdown Report Generation QA Tests ──────────────────────────

test('QA Markdown - generateMarkdownReport produces formatted markdown', () => {
  const summary = {
    testName: 'Smoke QA',
    startedAt: '2026-10-18T10:00:00Z',
    finishedAt: '2026-10-18T10:00:05Z',
    elapsedSeconds: 5,
    totals: { requests: 50, failed: 1, errorRate: 0.02, achievedRps: 10 },
    latencyMs: { avg: 15, p50: 12, p90: 20, p95: 25, p99: 30, min: 5, max: 40 },
    byStatus: { 200: 49, 500: 1 },
    byEndpoint: {
      '/api': { total: 50, failed: 1, errorRate: 0.02, avgMs: 15, p95Ms: 25, p99Ms: 30 }
    },
    thresholds: {
      maxErrorRate: { pass: true, actual: 0.02, expected: 0.05 }
    }
  };

  const md = generateMarkdownReport(summary);
  assert.match(md, /# Load Test Report/);
  assert.match(md, /Smoke QA/);
  assert.match(md, /\| Total Requests \| 50 \|/);
  assert.match(md, /✅ PASS/);
});

test('QA Markdown - generateAbMarkdownReport formats differential comparisons', () => {
  const summaryA = {
    testName: 'Variant A',
    totals: { requests: 100, failed: 0, errorRate: 0, achievedRps: 10 },
    latencyMs: { avg: 20, p50: 18, p90: 25, p95: 28, p99: 35 }
  };
  const summaryB = {
    testName: 'Variant B',
    totals: { requests: 100, failed: 0, errorRate: 0, achievedRps: 10 },
    latencyMs: { avg: 15, p50: 14, p90: 19, p95: 22, p99: 28 }
  };
  const diff = computeAbDiff(summaryA, summaryB);
  const md = generateAbMarkdownReport(diff, summaryA, summaryB);

  assert.ok(md.includes('# ⚖️ A/B Differential Load Test Report'));
  assert.ok(md.includes('Variant A'));
  assert.ok(md.includes('Variant B'));
  assert.ok(md.includes('🏆 **Variant B is the WINNER**'));
});

