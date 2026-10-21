const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(express.json({ limit: '5mb' }));

// Security & Caching Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const CLI_PATH = path.join(__dirname, '..', 'bin', 'safe-load-lab.js');

const { pathToFileURL } = require('url');
let sll = null;
import(pathToFileURL(CLI_PATH).href).then(m => { sll = m; }).catch(err => {
  console.error('Failed to import CLI helpers:', err.message);
});

let mockServerInstance = null;
let mockProcess = null;
let mockPort = 8080;
let activeTestProcess = null;
let activeTestMeta = null;
let lastTestSummary = null;

// Ensure reports directory exists
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// Helper: generate unique temp file
function createTempConfig(config) {
  const tempFileName = `sll-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.json`;
  const tempFilePath = path.join(os.tmpdir(), tempFileName);
  fs.writeFileSync(tempFilePath, JSON.stringify(config, null, 2), 'utf8');
  return tempFilePath;
}

// Helper: safe report name
function sanitizeName(name) {
  return String(name || 'result').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// System status
app.get('/api/status', (req, res) => {
  res.json({
    activeTest: activeTestProcess !== null,
    testMeta: activeTestMeta,
    mockRunning: mockServerInstance !== null || mockProcess !== null,
    mockPort,
    uptime: Math.round(process.uptime()),
    nodeVersion: process.version
  });
});

// List saved example configs
app.get('/api/configs', (req, res) => {
  const examplesDir = path.join(__dirname, '..', 'examples');
  try {
    const files = fs.readdirSync(examplesDir)
      .filter(f => f.endsWith('.json'))
      .map(file => {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(examplesDir, file), 'utf8'));
          return {
            filename: file,
            name: content.name || file.replace('.json', ''),
            duration: content.durationSeconds || (content.stages ? content.stages.reduce((a, s) => a + (s.durationSeconds || 0), 0) : null),
            concurrency: content.concurrency || (content.stages ? Math.max(...content.stages.map(s => s.concurrency || 0)) : null),
            rps: content.rps || (content.stages ? Math.max(...content.stages.map(s => s.rps || 0)) : null),
            endpointsCount: (content.endpoints || []).length
          };
        } catch {
          return { filename: file, name: file };
        }
      });
    res.json(files);
  } catch (err) {
    res.json([]);
  }
});

// Get config details
app.get('/api/configs/:name', (req, res) => {
  const safeName = path.basename(req.params.name);
  if (!safeName.endsWith('.json')) {
    return res.status(400).json({ error: 'Config file must end with .json' });
  }
  const configPath = path.join(__dirname, '..', 'examples', safeName);
  try {
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: 'Config not found' });
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validate config
app.post('/api/validate', (req, res) => {
  const config = req.body;
  if (!config) return res.status(400).json({ valid: false, error: 'Empty configuration' });

  let tempPath = null;
  try {
    tempPath = createTempConfig(config);
    const proc = spawn(process.execPath, [CLI_PATH, 'validate', '--config', tempPath]);
    let output = '';
    let error = '';

    proc.stdout.on('data', data => { output += data.toString(); });
    proc.stderr.on('data', data => { error += data.toString(); });

    proc.on('close', code => {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      if (code === 0) {
        res.json({ valid: true, message: 'Configuration is valid', output });
      } else {
        res.status(400).json({ valid: false, error: (error || output || 'Validation failed').trim() });
      }
    });
  } catch (err) {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.status(500).json({ valid: false, error: err.message });
  }
});

// Get preview/plan
app.post('/api/plan', (req, res) => {
  const config = req.body;
  let tempPath = null;
  try {
    tempPath = createTempConfig(config);
    const proc = spawn(process.execPath, [CLI_PATH, 'plan', '--config', tempPath]);
    let output = '';
    let error = '';

    proc.stdout.on('data', data => { output += data.toString(); });
    proc.stderr.on('data', data => { error += data.toString(); });

    proc.on('close', code => {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      if (code === 0) {
        res.json({ success: true, plan: output });
      } else {
        res.status(400).json({ success: false, error: (error || output).trim() });
      }
    });
  } catch (err) {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.status(500).json({ error: err.message });
  }
});

// Run load test (streaming via SSE)
app.post('/api/run', (req, res) => {
  if (activeTestProcess) {
    return res.status(409).json({ error: 'A load test is already in progress. Stop it before starting a new test.' });
  }

  const { config, reportName, mode = 'run' } = req.body;
  if (!config) return res.status(400).json({ error: 'Configuration is required' });

  const safeMode = ['run', 'spike', 'soak', 'stress', 'capacity', 'break'].includes(mode) ? mode : 'run';
  const safeName = sanitizeName(reportName || `test-${new Date().toISOString().split('T')[0]}-${Date.now()}`);
  const reportPath = path.join(REPORTS_DIR, safeName);
  let tempPath = null;

  try {
    tempPath = createTempConfig(config);
    const args = [CLI_PATH, safeMode, '--config', tempPath, '--i-own-this-target'];
    args.push('--out', `${reportPath}.json`);
    args.push('--html', `${reportPath}.html`);
    args.push('--csv', `${reportPath}.csv`);
    args.push('--markdown', `${reportPath}.md`);

    const proc = spawn(process.execPath, args);
    activeTestProcess = proc;
    activeTestMeta = { name: safeName, mode: safeMode, startedAt: Date.now() };

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(`data: ${JSON.stringify({ type: 'start', mode: safeMode, reportName: safeName, timestamp: Date.now() })}\n\n`);

    proc.stdout.on('data', data => {
      const text = data.toString();
      res.write(`data: ${JSON.stringify({ type: 'progress', message: text })}\n\n`);
    });

    proc.stderr.on('data', data => {
      const text = data.toString();
      res.write(`data: ${JSON.stringify({ type: 'stderr', message: text })}\n\n`);
    });

    const cleanup = () => {
      if (tempPath && fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      activeTestProcess = null;
      activeTestMeta = null;
    };

    req.on('close', () => {
      if (activeTestProcess === proc) {
        try { proc.kill('SIGINT'); } catch {}
        cleanup();
      }
    });

    proc.on('close', code => {
      cleanup();
      let summary = null;
      let capacity = null;
      try {
        const report = JSON.parse(fs.readFileSync(`${reportPath}.json`, 'utf8'));
        if (safeMode === 'capacity' || safeMode === 'break') {
          capacity = report;
        } else {
          summary = report.summary;
          if (summary) lastTestSummary = summary;
        }
      } catch {}

      res.write(`data: ${JSON.stringify({
        type: 'complete',
        success: code === 0 || code === 2,
        exitCode: code,
        reportName: safeName,
        summary,
        capacity
      })}\n\n`);
      res.end();
    });

  } catch (err) {
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
    activeTestProcess = null;
    activeTestMeta = null;
    res.status(500).json({ error: err.message });
  }
});

// Run A/B Differential Test
app.post('/api/ab', (req, res) => {
  if (activeTestProcess) {
    return res.status(409).json({ error: 'A load test is already running. Please stop it first.' });
  }

  const { urlA, urlB, duration, concurrency, rps, reportName, maxLatencyDiff, maxErrorDiff } = req.body;
  if (!urlA || !urlB) {
    return res.status(400).json({ error: 'Both urlA and urlB are required for A/B testing' });
  }

  const safeName = sanitizeName(reportName || `ab-${new Date().toISOString().split('T')[0]}-${Date.now()}`);
  const reportPath = path.join(REPORTS_DIR, safeName);

  try {
    const args = [
      CLI_PATH,
      'ab',
      '--url-a', urlA,
      '--url-b', urlB,
      '--duration', String(duration || 10),
      '--concurrency', String(concurrency || 5),
      '--rps', String(rps || 10),
      '--i-own-this-target',
      '--out', `${reportPath}.json`,
      '--html', `${reportPath}.html`,
      '--markdown', `${reportPath}.md`
    ];

    if (maxLatencyDiff) args.push('--max-latency-diff', String(maxLatencyDiff));
    if (maxErrorDiff) args.push('--max-error-diff', String(maxErrorDiff));

    const proc = spawn(process.execPath, args);
    activeTestProcess = proc;
    activeTestMeta = { name: safeName, mode: 'ab', startedAt: Date.now() };

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(`data: ${JSON.stringify({ type: 'start', mode: 'ab', reportName: safeName, timestamp: Date.now() })}\n\n`);

    proc.stdout.on('data', data => {
      const text = data.toString();
      res.write(`data: ${JSON.stringify({ type: 'progress', message: text })}\n\n`);
    });

    proc.stderr.on('data', data => {
      const text = data.toString();
      res.write(`data: ${JSON.stringify({ type: 'stderr', message: text })}\n\n`);
    });

    req.on('close', () => {
      if (activeTestProcess === proc) {
        try { proc.kill('SIGINT'); } catch {}
        activeTestProcess = null;
        activeTestMeta = null;
      }
    });

    proc.on('close', code => {
      activeTestProcess = null;
      activeTestMeta = null;
      let diff = null;
      let summaryA = null;
      let summaryB = null;

      try {
        const report = JSON.parse(fs.readFileSync(`${reportPath}.json`, 'utf8'));
        diff = report.diff;
        summaryA = report.variantA?.summary;
        summaryB = report.variantB?.summary;
      } catch {}

      res.write(`data: ${JSON.stringify({
        type: 'complete',
        success: code === 0 || code === 2,
        exitCode: code,
        reportName: safeName,
        diff,
        summaryA,
        summaryB
      })}\n\n`);
      res.end();
    });

  } catch (err) {
    activeTestProcess = null;
    activeTestMeta = null;
    res.status(500).json({ error: err.message });
  }
});

// Stop running test
app.post('/api/stop', (req, res) => {
  if (!activeTestProcess) {
    return res.json({ stopped: false, message: 'No test currently running' });
  }

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(activeTestProcess.pid), '/T', '/F']);
    } else {
      activeTestProcess.kill('SIGINT');
    }
  } catch {}

  activeTestProcess = null;
  activeTestMeta = null;
  res.json({ stopped: true, message: 'Test execution aborted' });
});

// Mock server management
app.get('/api/mock/status', (req, res) => {
  res.json({
    running: mockServerInstance !== null || mockProcess !== null,
    port: mockPort,
    endpoints: [
      `http://localhost:${mockPort}/health`,
      `http://localhost:${mockPort}/fast`,
      `http://localhost:${mockPort}/slow?delay=100`,
      `http://localhost:${mockPort}/chaos?failRate=0.25&minDelay=20&maxDelay=150`,
      `http://localhost:${mockPort}/slow-stream?chunks=5&delay=30`,
      `http://localhost:${mockPort}/error?status=500`,
      `http://localhost:${mockPort}/rate-limit?limit=10&window=5`,
      `http://localhost:${mockPort}/json`,
      `http://localhost:${mockPort}/echo`
    ]
  });
});

// Dynamic mock routes
app.get('/api/mock/routes', (req, res) => {
  if (!mockServerInstance && !mockProcess) return res.json({ routes: [], mockRunning: false });
  fetch(`http://127.0.0.1:${mockPort}/mock/routes`)
    .then(r => r.json())
    .then(data => {
      const routes = data.routes || data;
      res.json(routes);
    })
    .catch(err => res.json({ routes: [], error: err.message }));
});

app.post('/api/mock/routes', (req, res) => {
  if (!mockServerInstance && !mockProcess) return res.status(400).json({ error: 'Mock server is not running' });
  fetch(`http://127.0.0.1:${mockPort}/mock/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body)
  })
    .then(r => r.json())
    .then(data => res.json(data))
    .catch(err => res.status(500).json({ error: err.message }));
});

app.delete('/api/mock/routes', (req, res) => {
  if (!mockServerInstance && !mockProcess) return res.status(400).json({ error: 'Mock server is not running' });
  fetch(`http://127.0.0.1:${mockPort}/mock/routes`, { method: 'DELETE' })
    .then(r => r.json())
    .then(data => res.json(data))
    .catch(err => res.status(500).json({ error: err.message }));
});

// Waveform stages preview
app.post('/api/waveform', (req, res) => {
  const opts = req.body.options || req.body || {};
  const waveform = req.body.waveform || opts.waveform || 'constant';
  try {
    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const stages = sll.generateTrafficProfile(waveform, opts);
    res.json({ waveform, stages });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mock/start', (req, res) => {
  if (mockServerInstance || mockProcess) {
    return res.json({ running: true, port: mockPort, message: 'Mock server already running' });
  }

  mockPort = req.body.port ? parseInt(req.body.port, 10) : 8080;
  if (sll && sll.startMockServer) {
    try {
      mockServerInstance = sll.startMockServer(mockPort, '127.0.0.1');
      mockServerInstance.on('error', () => {
        mockServerInstance = null;
      });
      return res.json({ running: true, port: mockPort, message: `Mock server started on port ${mockPort}` });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  mockProcess = spawn(process.execPath, [CLI_PATH, 'mock', '--port', String(mockPort)]);

  mockProcess.on('exit', () => {
    mockProcess = null;
  });

  setTimeout(() => {
    res.json({ running: true, port: mockPort, message: `Mock server started on port ${mockPort}` });
  }, 600);
});

app.post('/api/mock/stop', (req, res) => {
  if (mockServerInstance) {
    try { mockServerInstance.close(); } catch {}
    mockServerInstance = null;
  }
  if (mockProcess) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(mockProcess.pid), '/T', '/F']);
      } else {
        mockProcess.kill();
      }
    } catch {}
    mockProcess = null;
  }
  res.json({ running: false, message: 'Mock server stopped' });
});

// Reports management
app.get('/api/reports', (req, res) => {
  try {
    const files = fs.readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const fullPath = path.join(REPORTS_DIR, f);
        const stat = fs.statSync(fullPath);
        let preview = null;
        let isAb = false;
        try {
          const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          if (content.diff) {
            isAb = true;
            preview = {
              type: 'ab',
              winner: content.diff.winner,
              isRegression: content.diff.isRegression,
              p95A: content.diff.latencies?.p95?.a,
              p95B: content.diff.latencies?.p95?.b,
              pctDelta: content.diff.latencies?.p95?.pct
            };
          } else if (content.summary) {
            preview = {
              type: 'load',
              requests: content.summary.totals?.requests,
              failed: content.summary.totals?.failed,
              errorRate: content.summary.totals?.errorRate,
              rps: content.summary.totals?.achievedRps,
              p95: content.summary.latencyMs?.p95,
              avg: content.summary.latencyMs?.avg
            };
          }
        } catch {}

        return {
          name: f.replace('.json', ''),
          date: stat.mtime,
          sizeBytes: stat.size,
          isAb,
          preview
        };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(files);
  } catch (err) {
    res.json([]);
  }
});

// Get report JSON
app.get('/api/reports/:name', (req, res) => {
  const safeName = sanitizeName(req.params.name);
  const reportPath = path.join(REPORTS_DIR, `${safeName}.json`);
  try {
    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ error: 'Report not found' });
    }
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve report HTML
app.get('/api/reports/:name/html', (req, res) => {
  const safeName = sanitizeName(req.params.name);
  const htmlPath = path.join(REPORTS_DIR, `${safeName}.html`);
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send('HTML report not generated for this run');
  }
  res.sendFile(htmlPath);
});

// Download report CSV
app.get('/api/reports/:name/csv', (req, res) => {
  const safeName = sanitizeName(req.params.name);
  const csvPath = path.join(REPORTS_DIR, `${safeName}.csv`);
  if (!fs.existsSync(csvPath)) {
    return res.status(404).send('CSV report not generated for this run');
  }
  res.download(csvPath, `${safeName}.csv`);
});

// Download/View report Markdown
app.get('/api/reports/:name/markdown', (req, res) => {
  const safeName = sanitizeName(req.params.name);
  const mdPath = path.join(REPORTS_DIR, `${safeName}.md`);
  if (!fs.existsSync(mdPath)) {
    return res.status(404).send('Markdown report not generated for this run');
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.sendFile(mdPath);
});

// Serve report Prometheus metrics
app.get('/api/reports/:name/prometheus', (req, res) => {
  const safeName = sanitizeName(req.params.name);
  const reportPath = path.join(REPORTS_DIR, `${safeName}.json`);
  if (!fs.existsSync(reportPath)) {
    return res.status(404).send('# Report not found');
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (!report.summary) return res.status(400).send('# No summary in report');
    if (!sll) return res.status(503).send('# Engine helper initializing');
    const prom = sll.generatePrometheusMetrics(report.summary, report.results || []);
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(prom);
  } catch (err) {
    res.status(500).send(`# Error: ${err.message}`);
  }
});

// Serve report status badge SVG
app.get('/api/reports/:name/badge', (req, res) => {
  const safeName = sanitizeName(req.params.name);
  const reportPath = path.join(REPORTS_DIR, `${safeName}.json`);
  if (!fs.existsSync(reportPath)) {
    return res.status(404).send('<svg><text>not found</text></svg>');
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (!report.summary) return res.status(400).send('<svg><text>no summary</text></svg>');
    if (!sll) return res.status(503).send('<svg><text>loading</text></svg>');
    const svg = sll.generateSvgBadge(report.summary);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    res.status(500).send(`<svg><text>${err.message}</text></svg>`);
  }
});

// SRE Bottleneck Diagnosis for a report
app.get('/api/reports/:name/diagnosis', (req, res) => {
  const safeName = sanitizeName(req.params.name);
  const reportPath = path.join(REPORTS_DIR, `${safeName}.json`);
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const summary = report.summary || report;
    const results = report.results || [];
    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const diagnosis = summary.diagnosis || sll.computeBottleneckDiagnosis(summary, results);
    res.json(diagnosis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compare two test reports
app.post('/api/reports/compare', (req, res) => {
  const { reportA, reportB } = req.body;
  if (!reportA || !reportB) return res.status(400).json({ error: 'Both reportA and reportB required' });

  const safeA = sanitizeName(reportA);
  const safeB = sanitizeName(reportB);
  const pathA = path.join(REPORTS_DIR, `${safeA}.json`);
  const pathB = path.join(REPORTS_DIR, `${safeB}.json`);

  try {
    if (!fs.existsSync(pathA) || !fs.existsSync(pathB)) {
      return res.status(404).json({ error: 'One or both reports not found' });
    }
    const dataA = JSON.parse(fs.readFileSync(pathA, 'utf8'));
    const dataB = JSON.parse(fs.readFileSync(pathB, 'utf8'));
    const summaryA = dataA.summary;
    const summaryB = dataB.summary;

    if (!summaryA || !summaryB) {
      return res.status(400).json({ error: 'Reports must contain valid test summaries' });
    }

    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const diff = sll.computeAbDiff(summaryA, summaryB);
    res.json({ diff, summaryA, summaryB });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Convert Postman Collection
app.post('/api/import/postman', (req, res) => {
  const { content, duration, concurrency, rps } = req.body;
  if (!content) return res.status(400).json({ error: 'Postman collection JSON required' });
  try {
    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const config = sll.parsePostmanCollection(content, { duration, concurrency, rps });
    res.json(config);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Convert OpenAPI / Swagger Spec
app.post('/api/import/openapi', (req, res) => {
  const { content, duration, concurrency, rps, baseUrl } = req.body;
  if (!content) return res.status(400).json({ error: 'OpenAPI specification JSON required' });
  try {
    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const config = sll.parseOpenApiSpec(content, { duration, concurrency, rps, baseUrl });
    res.json(config);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Synthesize CRUD Journey Flow from OpenAPI / Swagger Spec
app.post('/api/import/openapi-flow', (req, res) => {
  const { content, duration, concurrency, rps, baseUrl } = req.body;
  if (!content) return res.status(400).json({ error: 'OpenAPI specification JSON required' });
  try {
    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const config = sll.generateCrudScenarioFromOpenApi(content, { duration, concurrency, rps, baseUrl });
    res.json(config);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Convert HAR recording
app.post('/api/import/har', (req, res) => {
  const { content, duration, concurrency, rps, includeAssets, host } = req.body;
  if (!content) return res.status(400).json({ error: 'HAR recording JSON required' });
  try {
    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const config = sll.parseHarRecording(content, { duration, concurrency, rps, includeAssets, host });
    res.json(config);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Preflight single request probe
app.post('/api/probe', async (req, res) => {
  const { url, method, headers, body, assertions, timeout, variables } = req.body;
  if (!url) return res.status(400).json({ error: 'Target URL is required for probe' });
  try {
    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const ep = {
      name: 'probe-request',
      url,
      method: method || 'GET',
      headers: headers || {},
      body: body || null,
      assertions: assertions || [],
      variables: variables || {}
    };
    const result = await sll.probeEndpoint(ep, timeout ? parseInt(timeout, 10) : 10000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate CI/CD pipeline workflow
app.post('/api/ci/generate', (req, res) => {
  const { type, config, cron } = req.body;
  try {
    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const yaml = sll.generateCiWorkflow(type || 'github', { config: config || 'load-test.json', cron });
    res.json({ type: type || 'github', yaml });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parse CSV text for dataset preview
app.post('/api/parse-csv', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'CSV content required' });
  try {
    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const rows = sll.parseCsvData(content);
    res.json({ count: rows.length, rows: rows.slice(0, 50), headers: rows.length ? Object.keys(rows[0]) : [] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Export configuration to k6 script
app.post('/api/export/k6', (req, res) => {
  const { config } = req.body;
  if (!config) return res.status(400).json({ error: 'Config object required' });
  try {
    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const script = sll.exportToK6(config);
    res.json({ script });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Export configuration to Postman Collection
app.post('/api/export/postman', (req, res) => {
  const { config } = req.body;
  if (!config) return res.status(400).json({ error: 'Config object required' });
  try {
    if (!sll) return res.status(503).json({ error: 'Engine helper initializing' });
    const collectionJson = sll.exportToPostman(config);
    res.json({ collection: JSON.parse(collectionJson) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete report
app.delete('/api/reports/:name', (req, res) => {
  const safeName = sanitizeName(req.params.name);
  const exts = ['.json', '.html', '.csv', '.md'];
  let deletedCount = 0;

  for (const ext of exts) {
    const file = path.join(REPORTS_DIR, `${safeName}${ext}`);
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
        deletedCount++;
      } catch {}
    }
  }

  res.json({ success: true, message: `Deleted ${deletedCount} report files for ${safeName}` });
});

// Prometheus / OpenMetrics scraping endpoint
app.get('/metrics', (req, res) => {
  const uptime = Math.round(process.uptime());
  const lines = [
    '# HELP safeloadlab_uptime_seconds Total runtime of Safe Load Lab studio server',
    '# TYPE safeloadlab_uptime_seconds gauge',
    `safeloadlab_uptime_seconds ${uptime}`,
    '# HELP safeloadlab_active_test Whether a load test is actively executing (1 or 0)',
    '# TYPE safeloadlab_active_test gauge',
    `safeloadlab_active_test ${activeTestProcess ? 1 : 0}`,
    '# HELP safeloadlab_mock_running Whether the hermetic mock server is running (1 or 0)',
    '# TYPE safeloadlab_mock_running gauge',
    `safeloadlab_mock_running ${(mockServerInstance || mockProcess) ? 1 : 0}`
  ];

  if (lastTestSummary) {
    lines.push(
      '# HELP safeloadlab_last_test_requests Total requests in latest test',
      '# TYPE safeloadlab_last_test_requests counter',
      `safeloadlab_last_test_requests ${lastTestSummary.totals?.requests || 0}`,
      '# HELP safeloadlab_last_test_failed Total failed requests in latest test',
      '# TYPE safeloadlab_last_test_failed counter',
      `safeloadlab_last_test_failed ${lastTestSummary.totals?.failed || 0}`,
      '# HELP safeloadlab_last_test_rps Achieved requests per second in latest test',
      '# TYPE safeloadlab_last_test_rps gauge',
      `safeloadlab_last_test_rps ${(lastTestSummary.totals?.achievedRps || 0).toFixed(2)}`,
      '# HELP safeloadlab_last_test_p95_ms 95th percentile latency in milliseconds',
      '# TYPE safeloadlab_last_test_p95_ms gauge',
      `safeloadlab_last_test_p95_ms ${(lastTestSummary.latencyMs?.p95 || 0).toFixed(2)}`,
      '# HELP safeloadlab_last_test_error_rate Error rate ratio in latest test',
      '# TYPE safeloadlab_last_test_error_rate gauge',
      `safeloadlab_last_test_error_rate ${(lastTestSummary.totals?.errorRate || 0).toFixed(4)}`
    );

    if (lastTestSummary.bandwidth) {
      lines.push(
        '# HELP safeloadlab_last_test_bytes_total Total network bytes transferred in latest test',
        '# TYPE safeloadlab_last_test_bytes_total counter',
        `safeloadlab_last_test_bytes_total ${lastTestSummary.bandwidth.totalBytes || 0}`,
        '# HELP safeloadlab_last_test_throughput_kbps Achieved network throughput in kilobytes per second',
        '# TYPE safeloadlab_last_test_throughput_kbps gauge',
        `safeloadlab_last_test_throughput_kbps ${(lastTestSummary.bandwidth.throughputKbps || 0).toFixed(2)}`
      );
    }
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n✓ Safe Load Lab Studio running at http://localhost:${PORT}`);
    console.log(`  Local Hermetic Mock Server available at http://localhost:${mockPort}`);
    console.log(`  Press Ctrl+C to stop.\n`);
  });
}

module.exports = app;
