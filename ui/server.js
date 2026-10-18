const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3001;
const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const CLI_PATH = path.join(__dirname, '..', 'bin', 'safe-load-lab.js');

let mockProcess = null;
let mockPort = 8080;

// Ensure reports directory exists
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// List saved configs
app.get('/api/configs', (req, res) => {
  const examplesDir = path.join(__dirname, '..', 'examples');
  try {
    const files = fs.readdirSync(examplesDir).filter(f => f.endsWith('.json'));
    res.json(files);
  } catch (err) {
    res.json([]);
  }
});

// Get config details
app.get('/api/configs/:name', (req, res) => {
  const configPath = path.join(__dirname, '..', 'examples', req.params.name);
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validate config
app.post('/api/validate', (req, res) => {
  const config = req.body;
  const configPath = path.join(__dirname, 'temp-config.json');
  
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    const proc = spawn(process.execPath, [CLI_PATH, 'validate', '--config', configPath]);
    let output = '';
    let error = '';
    
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      error += data.toString();
    });
    
    proc.on('close', (code) => {
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      if (code === 0) {
        res.json({ valid: true, message: 'Config is valid' });
      } else {
        res.status(400).json({ valid: false, error: error || output });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get preview/plan
app.post('/api/plan', (req, res) => {
  const config = req.body;
  const configPath = path.join(__dirname, 'temp-config.json');
  
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    const proc = spawn(process.execPath, [CLI_PATH, 'plan', '--config', configPath]);
    let output = '';
    
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('close', () => {
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      res.json({ plan: output });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run load test
app.post('/api/run', (req, res) => {
  const { config, reportName } = req.body;
  const configPath = path.join(__dirname, 'temp-config.json');
  const safeName = (reportName || 'result').replace(/[^a-zA-Z0-9_-]/g, '_');
  const reportPath = path.join(REPORTS_DIR, safeName);
  
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    const args = [CLI_PATH, 'run', '--config', configPath, '--i-own-this-target'];
    args.push('--out', `${reportPath}.json`);
    args.push('--html', `${reportPath}.html`);
    args.push('--csv', `${reportPath}.csv`);
    args.push('--markdown', `${reportPath}.md`);
    
    const proc = spawn(process.execPath, args);
    let output = '';
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      res.write(`data: ${JSON.stringify({ type: 'progress', message: text })}\n\n`);
    });
    
    proc.stderr.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('close', (code) => {
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      
      if (code === 0 || code === 2) {
        try {
          const report = JSON.parse(fs.readFileSync(`${reportPath}.json`, 'utf8'));
          res.write(`data: ${JSON.stringify({ 
            type: 'complete', 
            success: code === 0, 
            reportName: safeName,
            summary: {
              totalRequests: report.summary?.totals?.requests || 0,
              successCount: (report.summary?.totals?.requests || 0) - (report.summary?.totals?.failed || 0),
              failCount: report.summary?.totals?.failed || 0,
              achievedRps: report.summary?.totals?.achievedRps || 0,
              errorRate: report.summary?.totals?.errorRate || 0,
              avgLatency: report.summary?.latencyMs?.avg || 0,
              p95Latency: report.summary?.latencyMs?.p95 || 0,
              p99Latency: report.summary?.latencyMs?.p99 || 0
            }
          })}\n\n`);
        } catch (e) {
          res.write(`data: ${JSON.stringify({ 
            type: 'complete', 
            success: true, 
            reportName: safeName 
          })}\n\n`);
        }
      } else {
        res.write(`data: ${JSON.stringify({ 
          type: 'error', 
          error: output 
        })}\n\n`);
      }
      
      res.end();
    });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run A/B Differential Test
app.post('/api/ab', (req, res) => {
  const { urlA, urlB, duration, concurrency, rps, reportName, maxLatencyDiff } = req.body;
  const safeName = (reportName || 'ab-result').replace(/[^a-zA-Z0-9_-]/g, '_');
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

    if (maxLatencyDiff) {
      args.push('--max-latency-diff', String(maxLatencyDiff));
    }

    const proc = spawn(process.execPath, args);
    let output = '';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      res.write(`data: ${JSON.stringify({ type: 'progress', message: text })}\n\n`);
    });

    proc.stderr.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      try {
        const report = JSON.parse(fs.readFileSync(`${reportPath}.json`, 'utf8'));
        res.write(`data: ${JSON.stringify({
          type: 'complete',
          success: code === 0,
          reportName: safeName,
          diff: report.diff
        })}\n\n`);
      } catch (e) {
        res.write(`data: ${JSON.stringify({
          type: 'complete',
          success: code === 0,
          reportName: safeName
        })}\n\n`);
      }
      res.end();
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mock server management
app.get('/api/mock/status', (req, res) => {
  res.json({
    running: mockProcess !== null,
    port: mockPort,
    endpoints: [
      `http://localhost:${mockPort}/health`,
      `http://localhost:${mockPort}/fast`,
      `http://localhost:${mockPort}/slow?delay=100`,
      `http://localhost:${mockPort}/error?status=500`,
      `http://localhost:${mockPort}/rate-limit?limit=10&window=5`,
      `http://localhost:${mockPort}/json`,
      `http://localhost:${mockPort}/echo`
    ]
  });
});

app.post('/api/mock/start', (req, res) => {
  if (mockProcess) {
    return res.json({ running: true, port: mockPort, message: 'Mock server already running' });
  }

  mockPort = req.body.port || 8080;
  mockProcess = spawn(process.execPath, [CLI_PATH, 'mock', '--port', String(mockPort)]);

  mockProcess.on('exit', () => {
    mockProcess = null;
  });

  setTimeout(() => {
    res.json({ running: true, port: mockPort, message: `Mock server started on port ${mockPort}` });
  }, 500);
});

app.post('/api/mock/stop', (req, res) => {
  if (mockProcess) {
    mockProcess.kill();
    mockProcess = null;
  }
  res.json({ running: false, message: 'Mock server stopped' });
});

// Get report list
app.get('/api/reports', (req, res) => {
  try {
    const files = fs.readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f.replace('.json', ''),
        date: fs.statSync(path.join(REPORTS_DIR, f)).mtime
      }))
      .sort((a, b) => b.date - a.date);
    res.json(files);
  } catch (err) {
    res.json([]);
  }
});

// Get report details
app.get('/api/reports/:name', (req, res) => {
  const reportPath = path.join(REPORTS_DIR, `${req.params.name}.json`);
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✓ Safe Load Lab UI running at http://localhost:${PORT}`);
  console.log(`  Open your browser to get started\n`);
});
