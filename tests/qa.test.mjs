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
  HARD_LIMITS,
  parseCsvData,
  probeEndpoint,
  generateCiWorkflow,
  parseHarRecording,
  exportToK6,
  exportToPostman,
  renderTemplate,
  resolveDynamicGenerator,
  setHighCapacityMode,
  compareReports,
  generateSparkline,
  runTest,
  computeLatencyDistribution,
  generateTrafficProfile,
  runCapacityTest,
  generateCapacityMarkdownReport,
  writeCapacityHtmlReport,
  writeHtmlReport,
  computeBottleneckDiagnosis,
  generateCrudScenarioFromOpenApi
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

// ─── 7. CSV Data Parser QA Tests ──────────────────────────────────────

test('QA CSV Parser - parses standard comma-delimited data', () => {
  const csv = `id,name,role\n1,Alice,admin\n2,Bob,user\n3,Charlie,guest`;
  const rows = parseCsvData(csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, '1');
  assert.equal(rows[0].name, 'Alice');
  assert.equal(rows[0].role, 'admin');
  assert.equal(rows[2].name, 'Charlie');
});

test('QA CSV Parser - handles quoted values and commas within quotes', () => {
  const csv = `id,title,query\n101,"Senior Engineer, Core","latency, p95"\n102,"QA Specialist","error rate"`;
  const rows = parseCsvData(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Senior Engineer, Core');
  assert.equal(rows[0].query, 'latency, p95');
});

test('QA CSV Parser - handles tab and semicolon delimiters', () => {
  const tabCsv = `id\ttoken\tscore\n1\tabc\t99\n2\tdef\t88`;
  const tabRows = parseCsvData(tabCsv);
  assert.equal(tabRows.length, 2);
  assert.equal(tabRows[0].token, 'abc');

  const semiCsv = `id;path;tag\n1;/items;test\n2;/users;prod`;
  const semiRows = parseCsvData(semiCsv);
  assert.equal(semiRows.length, 2);
  assert.equal(semiRows[1].path, '/users');
});

// ─── 8. Preflight Probe Engine QA Tests ───────────────────────────────

test('QA Probe - sends single preflight probe and validates status & assertions', async () => {
  const port = 4120;
  const server = startMockServer(port, '127.0.0.1');
  try {
    const probe = await probeEndpoint({
      url: `http://127.0.0.1:${port}/json`,
      method: 'GET',
      assertions: [
        { type: 'status', value: 200 },
        { type: 'jsonPath', path: 'meta.total', equals: 2 }
      ]
    });

    assert.equal(probe.status, 200);
    assert.equal(probe.passed, true);
    assert.ok(probe.durationMs >= 0);
    assert.ok(probe.headers['content-type']);
    assert.equal(probe.assertions.length, 2);
    assert.equal(probe.assertions[0].passed, true);
    assert.equal(probe.assertions[1].passed, true);
  } finally {
    server.close();
  }
});

test('QA Probe - returns failed status on error route', async () => {
  const port = 4121;
  const server = startMockServer(port, '127.0.0.1');
  try {
    const probe = await probeEndpoint({
      url: `http://127.0.0.1:${port}/error?status=500`,
      method: 'GET'
    });
    assert.equal(probe.status, 500);
    assert.equal(probe.passed, false);
  } finally {
    server.close();
  }
});

// ─── 9. CI/CD Workflow Generator QA Tests ─────────────────────────────

test('QA CI/CD Generator - produces valid GitHub Actions workflow', () => {
  const yaml = generateCiWorkflow('github', { config: 'load-test.json', cron: '0 3 * * *' });
  assert.match(yaml, /name: Safe Load Lab/);
  assert.match(yaml, /cron: '0 3 \* \* \*'/);
  assert.match(yaml, /--config load-test\.json/);
  assert.match(yaml, /mikepenz\/action-junit-report/);
});

test('QA CI/CD Generator - produces valid GitLab CI workflow', () => {
  const yaml = generateCiWorkflow('gitlab', { config: 'load-test.json' });
  assert.match(yaml, /stages:\n  - test\n  - performance/);
  assert.match(yaml, /load-test:/);
  assert.match(yaml, /reports:\n      junit: reports\/junit\.xml/);
});

// ─── 10. New Mock Server Routes QA Tests ──────────────────────────────

test('QA Mock Server - handles /auth with and without Bearer token', async () => {
  const port = 4122;
  const server = startMockServer(port, '127.0.0.1');
  try {
    // Without token: 401
    const unauth = await fetch(`http://127.0.0.1:${port}/auth`);
    assert.equal(unauth.status, 401);

    // With token: 200
    const authed = await fetch(`http://127.0.0.1:${port}/auth`, {
      headers: { Authorization: 'Bearer test-token-123' }
    });
    assert.equal(authed.status, 200);
    const body = await authed.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.token, 'test-token-123');
  } finally {
    server.close();
  }
});

test('QA Mock Server - handles in-memory /items CRUD', async () => {
  const port = 4123;
  const server = startMockServer(port, '127.0.0.1');
  try {
    const listRes = await fetch(`http://127.0.0.1:${port}/items`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.ok(Array.isArray(list.items));

    const postRes = await fetch(`http://127.0.0.1:${port}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Widget' })
    });
    assert.equal(postRes.status, 201);
    const created = await postRes.json();
    assert.equal(created.name, 'New Widget');
    assert.ok(created.id);
  } finally {
    server.close();
  }
});

// ─── 11. CLI Commands Probe & CI QA Tests ─────────────────────────────

test('QA CLI - probe command validates arguments when missing target', () => {
  const res = runCLI(['probe']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /probe requires --url <url>, --config <file>, or --curl/);
});

test('QA CLI - ci command outputs workflow yaml', () => {
  const res = runCLI(['ci', '--type', 'github']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Safe Load Lab/);
});

// ─── 12. HAR Importer QA Tests ────────────────────────────────────────

test('QA HAR Importer - parses entries and excludes static assets by default', () => {
  const sampleHar = {
    log: {
      version: '1.2',
      entries: [
        {
          request: {
            method: 'GET',
            url: 'http://127.0.0.1:8080/api/users',
            headers: [{ name: 'Accept', value: 'application/json' }]
          }
        },
        {
          request: {
            method: 'GET',
            url: 'http://127.0.0.1:8080/static/bundle.css',
            headers: []
          }
        },
        {
          request: {
            method: 'GET',
            url: 'http://127.0.0.1:8080/images/logo.png',
            headers: []
          }
        },
        {
          request: {
            method: 'POST',
            url: 'http://127.0.0.1:8080/api/login',
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            postData: { mimeType: 'application/json', text: '{"user":"test"}' }
          }
        }
      ]
    }
  };

  const config = parseHarRecording(JSON.stringify(sampleHar));
  assert.equal(config.endpoints.length, 2);
  assert.equal(config.endpoints[0].method, 'GET');
  assert.equal(config.endpoints[0].url, 'http://127.0.0.1:8080/api/users');
  assert.equal(config.endpoints[0].headers.Accept, 'application/json');

  assert.equal(config.endpoints[1].method, 'POST');
  assert.equal(config.endpoints[1].body, '{"user":"test"}');
});

test('QA HAR Importer - includes assets when explicitly requested', () => {
  const sampleHar = {
    log: {
      entries: [
        { request: { method: 'GET', url: 'http://127.0.0.1:8080/style.css' } },
        { request: { method: 'GET', url: 'http://127.0.0.1:8080/api/ping' } }
      ]
    }
  };

  const config = parseHarRecording(sampleHar, { includeAssets: true });
  assert.equal(config.endpoints.length, 2);
});

test('QA HAR Importer - throws error on invalid or empty recording', () => {
  assert.throws(() => parseHarRecording({}), /Invalid HAR recording/);
  assert.throws(() => parseHarRecording({ log: { entries: [] } }), /Invalid HAR recording/);
});

// ─── 13. Enhanced Assertions QA Tests ─────────────────────────────────

test('QA Assertions - evaluates regex on response body', () => {
  const res = { status: 200, durationMs: 40, body: '{"token":"abc-12345-xyz"}' };
  const assertions = [
    { type: 'regex', pattern: 'token":"[a-z]+-[0-9]+-[a-z]+"' },
    { type: 'regex', pattern: 'error' }
  ];
  const evalResults = evaluateAssertions(res, assertions);
  assert.equal(evalResults[0].passed, true);
  assert.equal(evalResults[1].passed, false);
});

test('QA Assertions - evaluates jsonSchema required fields', () => {
  const res = { status: 200, durationMs: 20, body: JSON.stringify({ id: 42, name: 'Sample', nested: { active: true } }) };
  const assertions = [
    { type: 'jsonSchema', required: ['id', 'name', 'nested.active'] },
    { type: 'jsonSchema', required: ['id', 'missingField'] }
  ];
  const evalResults = evaluateAssertions(res, assertions);
  assert.equal(evalResults[0].passed, true);
  assert.equal(evalResults[1].passed, false);
});

test('QA Assertions - evaluates status.in and jsonPath thresholds', () => {
  const res = { status: 204, durationMs: 15, body: JSON.stringify({ count: 15 }) };
  const assertions = [
    { type: 'status', in: [200, 201, 204] },
    { type: 'status', in: [400, 404] },
    { type: 'jsonPath', path: 'count', greaterThan: 10 },
    { type: 'jsonPath', path: 'count', lessThan: 5 },
    { type: 'jsonPath', path: 'count', exists: true },
    { type: 'jsonPath', path: 'missing', exists: false }
  ];
  const evalResults = evaluateAssertions(res, assertions);
  assert.equal(evalResults[0].passed, true);
  assert.equal(evalResults[1].passed, false);
  assert.equal(evalResults[2].passed, true);
  assert.equal(evalResults[3].passed, false);
  assert.equal(evalResults[4].passed, true);
  assert.equal(evalResults[5].passed, true);
});

// ─── 14. CLI Bench Command QA Tests ───────────────────────────────────

test('QA CLI - bench command requires safety ownership flag', () => {
  const res = runCLI(['bench', 'http://127.0.0.1:8080/fast']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Missing required safety flag: --i-own-this-target/);
});

test('QA CLI - bench command validates target URL', () => {
  const res = runCLI(['bench', '--i-own-this-target']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /bench requires a target URL/);
});

// ─── 15. Dynamic Built-in Generators QA Tests ─────────────────────────

test('QA Dynamic Generators - generates uuid, timestamp, and random values', () => {
  const rendered = renderTemplate({
    id: '{{$uuid}}',
    time: '{{$timestamp}}',
    iso: '{{$isoDate}}',
    email: '{{$randomEmail}}',
    num: '{{$randomInt:50:60}}',
    str: '{{$randomAlpha:10}}',
    ip: '{{$randomIp}}'
  }, {});

  assert.match(rendered.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.ok(Number(rendered.time) > 1700000000000);
  assert.match(rendered.iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.match(rendered.email, /^user_[a-z0-9]+@example\.com$/);
  const n = parseInt(rendered.num, 10);
  assert.ok(n >= 50 && n <= 60, `Number ${n} should be between 50 and 60`);
  assert.equal(rendered.str.length, 10);
  assert.match(rendered.ip, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
});

// ─── 16. High-Capacity Limit Unlock QA Tests ──────────────────────────

test('QA High Capacity - toggles unlocked limits with flag', () => {
  const argsNormal = parseArgs(['--duration', '60']);
  assert.equal(argsNormal['unlock-limits'], undefined);

  const argsUnlocked = parseArgs(['--unlock-limits', '--duration', '1200', '--concurrency', '250', '--rps', '500']);
  assert.equal(argsUnlocked['unlock-limits'], true);

  const config = normalizeConfig({
    ...argsUnlocked,
    url: 'http://127.0.0.1:8080/fast',
    duration: 1200,
    concurrency: 250,
    rps: 500
  });

  assert.equal(config.durationSeconds, 1200);
  assert.equal(config.concurrency, 250);
  assert.equal(config.rps, 500);

  // Restore base limits
  setHighCapacityMode(false);
});

// ─── 17. Bi-directional Script Exporters QA Tests ─────────────────────

test('QA Exporter - exportToK6 generates valid executable k6 script', () => {
  const sampleConfig = {
    name: 'k6-test',
    durationSeconds: 15,
    concurrency: 8,
    rps: 20,
    thresholds: { p95Ms: 250, maxErrorRate: 0.02 },
    endpoints: [
      { name: 'get-users', method: 'GET', url: 'http://127.0.0.1:8080/items', headers: { Accept: 'application/json' } }
    ]
  };

  const script = exportToK6(sampleConfig);
  assert.match(script, /import http from 'k6\/http'/);
  assert.match(script, /http_req_duration: \['p\(95\)<250'\]/);
  assert.match(script, /http\.get\('http:\/\/127\.0\.0\.1:8080\/items'/);
  assert.match(script, /check\(res1/);
});

test('QA Exporter - exportToPostman generates valid Postman v2.1 collection', () => {
  const sampleConfig = {
    name: 'my-postman-export',
    endpoints: [
      { name: 'create-item', method: 'POST', url: 'http://127.0.0.1:8080/items', body: '{"name":"test"}' }
    ]
  };

  const jsonStr = exportToPostman(sampleConfig);
  const collection = JSON.parse(jsonStr);
  assert.ok(collection.info);
  assert.equal(collection.info.name, 'my-postman-export');
  assert.equal(collection.item.length, 1);
  assert.equal(collection.item[0].request.method, 'POST');
  assert.equal(collection.item[0].request.body.raw, '{"name":"test"}');
});

// ─── 18. Multi-Step User Journey Scenarios QA Tests ───────────────────

test('QA Scenarios - normalizes multi-step user flows', () => {
  const scenarioConfig = {
    name: 'ecommerce-flow',
    durationSeconds: 10,
    concurrency: 2,
    rps: 5,
    scenarios: [
      {
        name: 'auth-and-fetch',
        weight: 1,
        steps: [
          { name: 'login', method: 'POST', url: 'http://127.0.0.1:8080/auth', extract: { token: 'body.token' } },
          { name: 'get-items', method: 'GET', url: 'http://127.0.0.1:8080/items', headers: { Authorization: 'Bearer {{token}}' } }
        ]
      }
    ]
  };

  const norm = normalizeConfig(scenarioConfig);
  assert.ok(norm.scenarios);
  assert.equal(norm.scenarios.length, 1);
  assert.equal(norm.scenarios[0].steps.length, 2);
  assert.equal(norm.scenarios[0].steps[0].extract.token, 'body.token');
});

// ─── 19. Sparkline and Regression Gate Tests ──────────────────────────

test('QA Sparkline - generates valid Unicode sparklines from duration distributions', () => {
  const durations = [10, 12, 15, 20, 25, 40, 60, 80, 120, 150];
  const spark = generateSparkline(durations, 10);
  assert.equal(spark.length, 10);
  assert.match(spark, /^[ ▂▃▄▅▆▇█]+$/);

  const emptySpark = generateSparkline([]);
  assert.equal(emptySpark, '');

  const uniformSpark = generateSparkline([50, 50, 50, 50]);
  assert.equal(uniformSpark, '▄▄▄▄▄▄▄▄▄▄');
});

test('QA Regression Gate - compareReports detects latency regressions & passes valid runs', () => {
  const baseline = {
    testName: 'api-baseline',
    totals: { requests: 1000, failed: 0, errorRate: 0, achievedRps: 100 },
    latencyMs: { avg: 20, p95: 35, p99: 50 }
  };

  const passingRun = {
    testName: 'api-optimized',
    totals: { requests: 1050, failed: 0, errorRate: 0, achievedRps: 105 },
    latencyMs: { avg: 19, p95: 36, p99: 48 }
  };

  const regressedRun = {
    testName: 'api-regressed',
    totals: { requests: 800, failed: 50, errorRate: 0.0625, achievedRps: 80 },
    latencyMs: { avg: 60, p95: 90, p99: 150 }
  };

  const passResult = compareReports(baseline, passingRun, { maxLatencyDiff: 15, maxErrorDiff: 0 });
  assert.equal(passResult.isRegression, false);

  const failResult = compareReports(baseline, regressedRun, { maxLatencyDiff: 15, maxErrorDiff: 0 });
  assert.equal(failResult.isRegression, true);
  assert.match(failResult.regressionReason, /p95 Latency degraded/);
});

test('QA CLI - diff command runs and exits cleanly on identical reports', () => {
  const sampleReport = path.join(root, 'reports', 'baseline-temp.json');
  fs.mkdirSync(path.dirname(sampleReport), { recursive: true });
  const data = JSON.stringify({
    summary: {
      testName: 'temp-test',
      totals: { requests: 50, failed: 0, errorRate: 0, achievedRps: 10 },
      latencyMs: { avg: 10, p95: 15, p99: 20 }
    }
  });
  fs.writeFileSync(sampleReport, data);
  try {
    const res = runCLI(['diff', sampleReport, sampleReport]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /No regression detected/);
  } finally {
    try { fs.unlinkSync(sampleReport); } catch {}
  }
});

// ─── 14. Latency Distribution & Anomaly Detection Tests ───────────────

test('QA Latency - computeLatencyDistribution classifies 8 logarithmic buckets', () => {
  const empty = computeLatencyDistribution([]);
  assert.equal(empty.buckets.length, 8);
  assert.equal(empty.anomalies.tailDivergence, false);

  const sample = [5, 8, 15, 22, 45, 90, 150, 400, 800, 1500];
  const dist = computeLatencyDistribution(sample);
  assert.equal(dist.buckets.length, 8);
  assert.equal(dist.buckets[0].label, '<10ms');
  assert.equal(dist.buckets[0].count, 2);
  assert.equal(dist.buckets[7].label, '>1s');
  assert.equal(dist.buckets[7].count, 1);
  assert.equal(typeof dist.anomalies.tailRatio, 'number');
});

test('QA Latency - computeLatencyDistribution detects tail divergence', () => {
  // 50 requests around 10ms, but 2 requests at 200ms
  const latencies = [];
  for (let i = 0; i < 48; i++) latencies.push(10);
  latencies.push(150);
  latencies.push(200);

  const dist = computeLatencyDistribution(latencies);
  assert.equal(dist.anomalies.tailDivergence, true);
  assert.ok(dist.anomalies.tailRatio >= 3.5);
});

test('QA Latency - computeLatencyDistribution detects bimodal distribution', () => {
  // Two distinct peaks: one around 10ms, one around 500ms
  const latencies = [];
  for (let i = 0; i < 20; i++) latencies.push(8);
  for (let i = 0; i < 20; i++) latencies.push(450);

  const dist = computeLatencyDistribution(latencies);
  assert.equal(dist.anomalies.bimodal, true);
});

// ─── 15. Traffic Waveform Shaping Tests ────────────────────────────────

test('QA Waveform - generateTrafficProfile creates valid profiles', () => {
  const sine = generateTrafficProfile('sine', { duration: 30, baseRps: 10, peakRps: 40 });
  assert.ok(sine.stages.length >= 6);
  assert.equal(sine.waveform, 'sine');
  assert.ok(sine.stages.some(s => s.targetRps > 10));

  const ladder = generateTrafficProfile('ladder', { duration: 30, baseRps: 10, peakRps: 50 });
  assert.ok(ladder.stages.length >= 4);
  // monotonic increasing up to peak
  for (let i = 1; i < 4; i++) {
    assert.ok(ladder.stages[i].targetRps >= ladder.stages[i - 1].targetRps);
  }
  assert.equal(ladder.stages[4].name, 'step-cooldown');

  const burst = generateTrafficProfile('burst', { duration: 30, baseRps: 5, peakRps: 30 });
  assert.ok(burst.stages.length >= 4);
  assert.equal(burst.waveform, 'burst');

  const constant = generateTrafficProfile('constant', { duration: 20, baseRps: 15 });
  assert.equal(constant.stages.length, 1);
  assert.equal(constant.stages[0].targetRps, 15);
});

// ─── 16. Mock Server Chaos & Custom Dynamic Routes Tests ───────────────

test('QA Mock Server - handles /chaos endpoint with failure injection', async () => {
  const port = 4130;
  const server = startMockServer(port, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/chaos?failRate=1.0`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /Chaos/i);
  } finally {
    server.close();
  }
});

test('QA Mock Server - handles /slow-stream endpoint', async () => {
  const port = 4131;
  const server = startMockServer(port, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/slow-stream?chunks=3&chunkDelay=5`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"chunk":1/);
    assert.match(text, /"chunk":2/);
    assert.match(text, /"chunk":3/);
  } finally {
    server.close();
  }
});

test('QA Mock Server - registers, serves, and deletes dynamic /mock/routes', async () => {
  const port = 4132;
  const server = startMockServer(port, '127.0.0.1');
  try {
    // 1. Register custom route
    const regRes = await fetch(`http://127.0.0.1:${port}/mock/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/api/custom-endpoint',
        method: 'GET',
        status: 201,
        body: { custom: true, key: 'abc-123' }
      })
    });
    assert.equal(regRes.status, 200);
    const regBody = await regRes.json();
    assert.equal(regBody.success, true);

    // 2. Query registered route
    const queryRes = await fetch(`http://127.0.0.1:${port}/api/custom-endpoint`);
    assert.equal(queryRes.status, 201);
    const queryBody = await queryRes.json();
    assert.equal(queryBody.custom, true);
    assert.equal(queryBody.key, 'abc-123');

    // 3. List routes
    const listRes = await fetch(`http://127.0.0.1:${port}/mock/routes`);
    const listData = await listRes.json();
    const routes = Array.isArray(listData) ? listData : listData.routes || [];
    assert.ok(routes.some(r => r.path === '/api/custom-endpoint'));

    // 4. Delete route
    const delRes = await fetch(`http://127.0.0.1:${port}/mock/routes?path=/api/custom-endpoint`, {
      method: 'DELETE'
    });
    assert.equal(delRes.status, 200);

    // 5. Query after delete returns 404
    const notFound = await fetch(`http://127.0.0.1:${port}/api/custom-endpoint`);
    assert.equal(notFound.status, 404);
  } finally {
    server.close();
  }
});

// ─── 17. Autonomous Capacity Engine Tests ──────────────────────────────

test('QA Capacity Engine - runCapacityTest discovers safe headroom and writes reports', async () => {
  const port = 4133;
  const server = startMockServer(port, '127.0.0.1');
  const tempDir = path.join(root, 'reports', 'test-capacity-tmp');
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const result = await runCapacityTest({
      url: `http://127.0.0.1:${port}/fast`,
      targetSla: 200,
      startRps: 5,
      stepIncrement: 5,
      maxRps: 15,
      stepDuration: 2,
      concurrency: 2,
      reportName: 'test-qa-capacity'
    });

    assert.ok(result);
    assert.ok(result.steps.length >= 1);
    assert.equal(typeof result.safeHeadroomRps, 'number');
    assert.ok(result.safeHeadroomRps > 0);

    // Test markdown report generation
    const md = generateCapacityMarkdownReport(result);
    assert.match(md, /Safe Load Lab/);
    assert.match(md, /Capacity/i);

    // Test HTML report generation
    const htmlPath = path.join(tempDir, 'cap-report.html');
    writeCapacityHtmlReport(htmlPath, result);
    assert.ok(fs.existsSync(htmlPath));
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    assert.match(htmlContent, /Safe Load Lab/);
    assert.match(htmlContent, /Probe Matrix/);
  } finally {
    server.close();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test('QA Executive HTML Report - writeHtmlReport renders SVG histogram and percentiles', () => {
  const tempDir = path.join(root, 'reports', 'test-html-tmp');
  fs.mkdirSync(tempDir, { recursive: true });
  const htmlPath = path.join(tempDir, 'executive.html');

  const summary = {
    testName: 'executive-benchmark',
    durationSeconds: 10,
    concurrency: 4,
    rps: 20,
    totals: { requests: 200, successful: 198, failed: 2, errorRate: 0.01, achievedRps: 19.8 },
    latencyMs: { min: 4, max: 80, avg: 15.2, p50: 12.0, p90: 22.0, p95: 35.0, p99: 65.0 },
    bandwidth: { totalBytes: 50000, throughputKbps: 40, throughputMbps: 0.04 },
    thresholdsPassed: true,
    anomalies: { tailDivergence: false, bimodal: false, tailRatio: 2.1 },
    distribution: computeLatencyDistribution([5, 8, 12, 14, 25, 35, 65])
  };

  try {
    writeHtmlReport(htmlPath, summary, []);
    assert.ok(fs.existsSync(htmlPath));
    const content = fs.readFileSync(htmlPath, 'utf8');
    assert.match(content, /Safe Load Lab Report/);
    assert.match(content, /HDR.*Distribution/);
    assert.match(content, /<svg/);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test('QA Capacity Engine - handles positional URL and step-inc argument', async () => {
  const port = 4134;
  const server = startMockServer(port, '127.0.0.1');
  try {
    const result = await runCapacityTest({
      _: ['capacity', `http://127.0.0.1:${port}/fast`],
      sla: 200,
      'step-duration': 1,
      'start-rps': 5,
      'max-rps': 10,
      'step-inc': 5,
      'i-own-this-target': true
    });
    assert.equal(result.target, `http://127.0.0.1:${port}/fast`);
    assert.ok(result.sweetSpotRps >= 5);
  } finally {
    server.close();
  }
});

// ─── 24. SRE Bottleneck Diagnosis & OpenAPI Journey Generator QA Tests ──

test('QA SRE Diagnosis - detects endpoint latency mass, tail amplification, and gateway errors', () => {
  const summary = {
    totals: { requests: 200, failed: 20, errorRate: 0.1 },
    latencyMs: { p50: 20, p95: 120 },
    statusCodes: { 200: 180, 504: 15, 429: 5 },
    endpointSummary: {
      '/api/checkout': { requests: 50, avg: 400 },
      '/api/items': { requests: 150, avg: 20 }
    }
  };

  const diag = computeBottleneckDiagnosis(summary, []);
  assert.ok(diag.healthScore < 80);
  assert.ok(diag.findings.length >= 3);

  const categories = diag.findings.map(f => f.category);
  assert.ok(categories.includes('ENDPOINT_BOTTLENECK'));
  assert.ok(categories.includes('TAIL_AMPLIFICATION'));
  assert.ok(categories.includes('GATEWAY_TIMEOUT'));
  assert.ok(categories.includes('RATE_LIMIT_EXCEEDED'));

  const epFinding = diag.findings.find(f => f.category === 'ENDPOINT_BOTTLENECK');
  assert.match(epFinding.title, /\/api\/checkout/);
  assert.match(epFinding.recommendation, /checkout/i);
});

test('QA SRE Diagnosis - detects cold start lag and late-stage cascading leaks', () => {
  // Test cold start: first 10 requests slow, next 20 fast
  const coldStartResults = [
    ...Array.from({ length: 10 }, (_, i) => ({ timestamp: 1000 + i * 10, duration: 500 })),
    ...Array.from({ length: 20 }, (_, i) => ({ timestamp: 1200 + i * 10, duration: 25 }))
  ];
  const diagCold = computeBottleneckDiagnosis({ totals: { requests: 30, failed: 0, errorRate: 0 }, latencyMs: { p50: 30, p95: 500 } }, coldStartResults);
  const coldFinding = diagCold.findings.find(f => f.category === 'COLD_START_LAG');
  assert.ok(coldFinding);
  assert.match(coldFinding.recommendation, /JIT|warmup|provisioned/i);

  // Test cascading leak: first 20 fast, last 10 slow
  const leakResults = [
    ...Array.from({ length: 20 }, (_, i) => ({ timestamp: 1000 + i * 10, duration: 25 })),
    ...Array.from({ length: 10 }, (_, i) => ({ timestamp: 1500 + i * 10, duration: 600 }))
  ];
  const diagLeak = computeBottleneckDiagnosis({ totals: { requests: 30, failed: 0, errorRate: 0 }, latencyMs: { p50: 30, p95: 600 } }, leakResults);
  const leakFinding = diagLeak.findings.find(f => f.category === 'CASCADING_LEAK');
  assert.ok(leakFinding);
  assert.match(leakFinding.recommendation, /connection pool|memory leak|exhaustion/i);
});

test('QA OpenAPI Journey Generator - synthesizes complete CRUD journey with dynamic variable passing', () => {
  const openApiSpec = {
    openapi: '3.0.0',
    info: { title: 'Order Service', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/orders': {
        post: { summary: 'Create Order' },
        get: { summary: 'List Orders' }
      },
      '/orders/{orderId}': {
        get: { summary: 'Get Order' },
        put: { summary: 'Update Order' },
        delete: { summary: 'Delete Order' }
      }
    }
  };

  const journey = generateCrudScenarioFromOpenApi(openApiSpec, { duration: 45, concurrency: 8, rps: 25 });
  assert.equal(journey.durationSeconds, 45);
  assert.equal(journey.concurrency, 8);
  assert.equal(journey.rps, 25);
  assert.ok(journey.scenarios.length >= 1);

  const orderScenario = journey.scenarios.find(s => s.name.includes('order'));
  assert.ok(orderScenario);
  assert.equal(orderScenario.steps.length, 4);

  // Step 1: POST
  const createStep = orderScenario.steps[0];
  assert.equal(createStep.method, 'POST');
  assert.equal(createStep.url, 'https://api.example.com/v1/orders');
  assert.ok(createStep.extract.orderId);
  assert.deepEqual(createStep.assertions[0].in, [200, 201]);

  // Step 2: GET with {{orderId}}
  const getStep = orderScenario.steps[1];
  assert.equal(getStep.method, 'GET');
  assert.equal(getStep.url, 'https://api.example.com/v1/orders/{{orderId}}');
  assert.equal(getStep.assertions[0].equals, 200);

  // Step 3: PUT with {{orderId}}
  const updateStep = orderScenario.steps[2];
  assert.equal(updateStep.method, 'PUT');
  assert.equal(updateStep.url, 'https://api.example.com/v1/orders/{{orderId}}');

  // Step 4: DELETE with {{orderId}}
  const deleteStep = orderScenario.steps[3];
  assert.equal(deleteStep.method, 'DELETE');
  assert.equal(deleteStep.url, 'https://api.example.com/v1/orders/{{orderId}}');
});

test('QA CLI diagnose & autogen-flow commands', () => {
  const tempDir = path.join(root, 'reports', 'test-cli-diag-tmp');
  fs.mkdirSync(tempDir, { recursive: true });

  const reportPath = path.join(tempDir, 'sample-report.json');
  const specPath = path.join(tempDir, 'sample-spec.json');

  const sampleReport = {
    summary: {
      totals: { requests: 100, failed: 0, errorRate: 0.0 },
      latencyMs: { p50: 15, p95: 30, avg: 18 },
      statusCodes: { 200: 100 },
      endpointSummary: {
        '/fast': { requests: 50, avg: 15 },
        '/api': { requests: 50, avg: 20 }
      }
    },
    results: []
  };

  const sampleUnhealthyReport = {
    summary: {
      totals: { requests: 100, failed: 50, errorRate: 0.5 },
      latencyMs: { p50: 15, p95: 180, avg: 100 },
      statusCodes: { 200: 50, 504: 50 }
    },
    results: []
  };

  const sampleSpec = {
    openapi: '3.0.0',
    info: { title: 'Product API' },
    paths: {
      '/products': {
        post: { summary: 'Create' },
        get: { summary: 'List' }
      },
      '/products/{id}': {
        get: { summary: 'Get' },
        delete: { summary: 'Delete' }
      }
    }
  };

  try {
    fs.writeFileSync(reportPath, JSON.stringify(sampleReport));
    fs.writeFileSync(specPath, JSON.stringify(sampleSpec));

    // Test sll diagnose with healthy report (exit code 0)
    const diagRes = runCLI(['diagnose', reportPath]);
    assert.equal(diagRes.status, 0);
    assert.match(diagRes.stdout, /SRE Bottleneck Diagnosis/i);
    assert.match(diagRes.stdout, /Health Score/i);

    // Test sll diagnose with critical failing report (exit code 1)
    const unhealthyPath = path.join(tempDir, 'unhealthy-report.json');
    fs.writeFileSync(unhealthyPath, JSON.stringify(sampleUnhealthyReport));
    const diagUnhealthyRes = runCLI(['diagnose', unhealthyPath]);
    assert.equal(diagUnhealthyRes.status, 1);
    assert.match(diagUnhealthyRes.stdout, /GATEWAY_TIMEOUT/);

    // Test sll autogen-flow
    const outFlowPath = path.join(tempDir, 'journey.json');
    const flowRes = runCLI(['autogen-flow', specPath, '--out', outFlowPath]);
    assert.equal(flowRes.status, 0);
    assert.ok(fs.existsSync(outFlowPath));
    const flowData = JSON.parse(fs.readFileSync(outFlowPath, 'utf8'));
    assert.ok(flowData.scenarios.length >= 1);
    assert.equal(flowData.scenarios[0].steps[0].method, 'POST');
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});






