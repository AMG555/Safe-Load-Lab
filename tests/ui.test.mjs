import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../ui/server.js';

let server;
let port;

function startServer() {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (server) {
      server.close(resolve);
    } else {
      resolve();
    }
  });
}

async function requestJson(path, options = {}) {
  const url = `http://127.0.0.1:${port}${path}`;
  const res = await fetch(url, options);
  const data = await res.json();
  return { status: res.status, data };
}

test('UI Server API Suite', async (t) => {
  await startServer();

  t.after(async () => {
    await stopServer();
  });

  await t.test('GET /api/status returns operational status', async () => {
    const { status, data } = await requestJson('/api/status');
    assert.equal(status, 200);
    assert.equal(typeof data.uptime, 'number');
    assert.equal(typeof data.nodeVersion, 'string');
    assert.equal(data.activeTest, false);
  });

  await t.test('GET /api/configs lists example configurations', async () => {
    const { status, data } = await requestJson('/api/configs');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
    assert.ok(data.length > 0);
    const basic = data.find(c => c.filename === 'basic.json');
    assert.ok(basic, 'Should list basic.json');
  });

  await t.test('GET /api/configs/basic.json returns configuration content', async () => {
    const { status, data } = await requestJson('/api/configs/basic.json');
    assert.equal(status, 200);
    assert.ok(data.endpoints, 'Should have endpoints');
  });

  await t.test('GET /api/configs/invalid..name rejects path traversal', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/configs/invalid-file.txt`);
    assert.equal(res.status, 400);
  });

  await t.test('POST /api/validate passes for valid config', async () => {
    const validConfig = {
      name: 'test-validation',
      durationSeconds: 5,
      concurrency: 2,
      rps: 5,
      endpoints: [{ name: 'ep', url: 'http://localhost:8080/health', method: 'GET' }]
    };
    const { status, data } = await requestJson('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validConfig)
    });
    assert.equal(status, 200);
    assert.equal(data.valid, true);
  });

  await t.test('POST /api/validate fails for invalid config with excessive duration', async () => {
    const invalidConfig = {
      name: 'bad-duration',
      durationSeconds: 999999,
      concurrency: 2,
      rps: 5,
      endpoints: [{ name: 'ep', url: 'http://localhost:8080/health', method: 'GET' }]
    };
    const { status, data } = await requestJson('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidConfig)
    });
    assert.equal(status, 200); // capped with warning
    assert.equal(data.valid, true);
  });

  await t.test('POST /api/stop returns false when no test is active', async () => {
    const { status, data } = await requestJson('/api/stop', { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(data.stopped, false);
  });

  await t.test('GET /api/mock/status reports mock status', async () => {
    const { status, data } = await requestJson('/api/mock/status');
    assert.equal(status, 200);
    assert.ok(data.endpoints.length > 0);
  });

  await t.test('GET /api/reports returns list of reports', async () => {
    const { status, data } = await requestJson('/api/reports');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
  });

  await t.test('POST /api/parse-csv parses CSV into preview rows', async () => {
    const csvContent = 'id,name,role\n1,Alice,admin\n2,Bob,user';
    const { status, data } = await requestJson('/api/parse-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: csvContent })
    });
    assert.equal(status, 200);
    assert.equal(data.count, 2);
    assert.deepEqual(data.headers, ['id', 'name', 'role']);
    assert.equal(data.rows[0].name, 'Alice');
  });

  await t.test('POST /api/ci/generate produces pipeline YAML', async () => {
    const { status, data } = await requestJson('/api/ci/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'github', config: 'test.json' })
    });
    assert.equal(status, 200);
    assert.equal(data.type, 'github');
    assert.match(data.yaml, /name: Safe Load Lab/);
    assert.match(data.yaml, /--config test\.json/);
  });

  await t.test('POST /api/import/har converts HAR recording into load test config', async () => {
    const sampleHar = {
      log: {
        version: '1.2',
        entries: [
          { request: { method: 'GET', url: 'http://127.0.0.1:8080/api/items' } },
          { request: { method: 'GET', url: 'http://127.0.0.1:8080/styles.css' } }
        ]
      }
    };
    const { status, data } = await requestJson('/api/import/har', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: JSON.stringify(sampleHar), duration: 20, concurrency: 4, rps: 8 })
    });
    assert.equal(status, 200);
    assert.equal(data.durationSeconds, 20);
    assert.equal(data.concurrency, 4);
    assert.equal(data.rps, 8);
    assert.equal(data.endpoints.length, 1); // css filtered out
    assert.equal(data.endpoints[0].url, 'http://127.0.0.1:8080/api/items');
  });

  await t.test('GET /metrics returns OpenMetrics Prometheus exposition text', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /# HELP safeloadlab_uptime_seconds/);
    assert.match(text, /safeloadlab_uptime_seconds \d+/);
    assert.match(text, /# HELP safeloadlab_active_test/);
    assert.match(text, /safeloadlab_mock_running/);
  });
});
