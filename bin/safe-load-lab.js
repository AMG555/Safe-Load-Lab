#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import chalk from 'chalk';
import cliProgress from 'cli-progress';

const VERSION = '2.2.0';
const HARD_LIMITS = {
  maxDurationSeconds: 600,
  maxConcurrency: 100,
  maxRps: 200,
  maxBodyBytes: 1024 * 1024
};

/**
 * @typedef {Object} LoadTestConfig
 * @property {string} name - Test name
 * @property {string|null} activeEnv - Active environment name
 * @property {Object.<string, any>} variables - Template variables
 * @property {SetupStep[]} setup - Setup steps to run before test
 * @property {Stage[]} stages - Test stages
 * @property {number} durationSeconds - Total test duration
 * @property {number} concurrency - Max concurrent requests
 * @property {number} rps - Target requests per second
 * @property {number} timeoutMs - Request timeout
 * @property {Endpoint[]} endpoints - Test endpoints
 * @property {Endpoint[]} endpointTemplates - Endpoint templates before variable substitution
 * @property {Threshold} thresholds - Pass/fail criteria
 * @property {RetryConfig} [retry] - Retry configuration
 */

/**
 * @typedef {Object} Endpoint
 * @property {string} name - Endpoint name
 * @property {string} url - Target URL
 * @property {string} method - HTTP method
 * @property {Object.<string, string>} headers - Request headers
 * @property {string|null} body - Request body
 * @property {number} weight - Selection weight for load distribution
 * @property {number|number[]} [expectStatus] - Expected status code(s)
 * @property {Assertion[]} [assertions] - Response assertions
 */

/**
 * @typedef {Object} SetupStep
 * @property {string} name - Step name
 * @property {string} url - Target URL
 * @property {string} method - HTTP method
 * @property {Object.<string, string>} headers - Request headers
 * @property {string|null} body - Request body
 * @property {number|number[]} expectStatus - Expected status code(s)
 * @property {Object.<string, string>} extract - Variables to extract from response
 */

/**
 * @typedef {Object} Stage
 * @property {string} name - Stage name
 * @property {number} durationSeconds - Stage duration
 * @property {number} concurrency - Max concurrent requests
 * @property {number} rps - Target requests per second
 */

/**
 * @typedef {Object} Threshold
 * @property {number} [maxErrorRate] - Maximum acceptable error rate (0-1)
 * @property {number} [p95Ms] - Maximum acceptable p95 latency in ms
 * @property {number} [p99Ms] - Maximum acceptable p99 latency in ms
 */

/**
 * @typedef {Object} RetryConfig
 * @property {boolean} enabled - Whether retries are enabled
 * @property {number} maxAttempts - Maximum retry attempts
 * @property {number} backoffMultiplier - Exponential backoff multiplier
 * @property {number} maxBackoffMs - Maximum backoff duration
 * @property {Array<number|string>} retryOn - Status codes or error types to retry
 */

/**
 * @typedef {Object} Assertion
 * @property {string} type - Assertion type (status|jsonPath|header|responseTime)
 * @property {any} [value] - Expected value
 * @property {any} [equals] - Exact match value
 * @property {any} [contains] - Contains check value
 * @property {number} [lessThan] - Less than value
 * @property {string} [path] - JSON path for jsonPath assertions
 * @property {string} [name] - Header name for header assertions
 */

/**
 * @typedef {Object} RequestResult
 * @property {string} endpoint - Endpoint name
 * @property {string} method - HTTP method
 * @property {string} url - Request URL
 * @property {number} status - HTTP status code
 * @property {number} durationMs - Request duration in milliseconds
 * @property {string|null} error - Error message if failed
 * @property {string} timestamp - ISO timestamp
 * @property {string} body - Response body
 * @property {Object.<string, string>} [headers] - Response headers
 * @property {AssertionResult[]} [assertions] - Assertion results
 * @property {boolean} [retriesExhausted] - Whether all retries were exhausted
 * @property {number} [attemptsMade] - Number of attempts made
 */

/**
 * @typedef {Object} AssertionResult
 * @property {string} type - Assertion type
 * @property {boolean} passed - Whether assertion passed
 * @property {any} expected - Expected value
 * @property {any} actual - Actual value
 * @property {string} message - Result message
 */

/**
 * Debug logging helper
 * @param {...any} args - Arguments to log
 */
function debug(...args) {
  if (process.env.DEBUG === 'true' || process.env.VERBOSE === 'true') {
    console.log(chalk.gray('[DEBUG]'), ...args);
  }
}

/**
 * Validate URL format
 * @param {string} url - URL to validate
 * @returns {URL} Parsed URL object
 * @throws {Error} If URL is invalid
 */
function validateUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Protocol must be http or https');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Invalid URL: ${url} - ${err.message}`);
  }
}

/**
 * Validate endpoint configuration
 * @param {Object} ep - Endpoint to validate
 * @param {number} idx - Endpoint index
 * @throws {Error} If endpoint is invalid
 */
function validateEndpoint(ep, idx) {
  if (!ep.url) throw new Error(`Endpoint #${idx + 1}: missing url`);
  
  try {
    validateUrl(ep.url);
  } catch (err) {
    throw new Error(`Endpoint #${idx + 1}: ${err.message}`);
  }
  
  const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
  if (ep.method && !validMethods.includes(ep.method)) {
    throw new Error(`Endpoint #${idx + 1}: invalid method ${ep.method}. Must be one of: ${validMethods.join(', ')}`);
  }
  
  if (ep.weight !== undefined && (ep.weight < 0 || ep.weight > 100)) {
    throw new Error(`Endpoint #${idx + 1}: weight must be 0-100, got ${ep.weight}`);
  }
}

function printHelp() {
  console.log(`
Safe Load Lab v${VERSION}
Controlled load testing for systems you own or have permission to test.

Usage:
  safe-load-lab run --config <file> --i-own-this-target
  sll run --url <url> --duration 60 --concurrency 10 --rps 20 --i-own-this-target
  sll ab --url-a <urlA> --url-b <urlB> --i-own-this-target
  sll mock --port 8080

Commands:
  run         Run a controlled load test
  ab, diff    Run A/B differential load test comparing two endpoints or configs
  mock        Start hermetic local mock server for zero-flake load testing
  import-curl Convert cURL command string to Safe Load Lab test config
  validate    Validate and normalize a config without sending traffic
  plan        Show resolved test plan without sending traffic
  sample      Create a sample config file
  rate-limit  Safe rate-limit verification for owned endpoints
  compare     Compare two test reports
  spike       Run a spike test (sudden traffic increase)
  soak        Run a soak test (sustained load over time)
  stress      Run a stress test (gradually increasing load)
  version     Show version
  help        Show help

Required safety flag for run/ab/rate-limit/spike/soak/stress:
  --i-own-this-target       Confirms you own or have explicit permission to test the target

Common options:
  --config <file>           JSON config file
  --url <url>               Target URL for simple one-endpoint test
  --curl "<command>"        Directly run load test from a cURL command string
  --method <GET|POST|...>   HTTP method, default GET
  --body <json/string>      Request body for simple test
  --header "K: V"           Header, repeatable
  --duration <seconds>      Test duration, max ${HARD_LIMITS.maxDurationSeconds}, default 30
  --concurrency <number>    Max concurrent workers, max ${HARD_LIMITS.maxConcurrency}, default 5
  --rps <number>            Max requests per second, max ${HARD_LIMITS.maxRps}, default 10
  --timeout <ms>            Request timeout, default 10000
  --out <file>              Save JSON report, default reports/report-<timestamp>.json
  --csv <file>              Save per-request CSV
  --html <file>             Save standalone HTML report
  --markdown <file>         Save markdown format report
  --md <file>               Alias for --markdown
  --junit <file>            Save JUnit XML summary for CI
  --env <name>              Use config environment profile
  --webhook <url>           Send results to webhook URL
  --slack <url>             Send results to Slack webhook
  --compare <file>          Compare with previous report
  --realistic               Use realistic traffic patterns (random spacing)
  --verbose                 Enable verbose logging
  --debug                   Enable debug mode with detailed request/response logs

A/B Differential testing options:
  --url-a <url>             URL for Variant A
  --url-b <url>             URL for Variant B
  --config-a <file>         Config JSON for Variant A
  --config-b <file>         Config JSON for Variant B
  --env-a <name>            Environment profile for Variant A
  --env-b <name>            Environment profile for Variant B
  --max-latency-diff <pct>  Maximum allowed latency % degradation before regression (default 15)
  --max-error-diff <pct>    Maximum allowed error rate diff before regression (default 0)

Mock server options:
  --port <number>           Mock server listening port, default 8080
  --host <string>           Mock server host, default 127.0.0.1

Examples:
  sll mock --port 8080
  sll ab --url-a http://localhost:8080/fast --url-b http://localhost:8080/slow --duration 10 --i-own-this-target
  sll run --curl "curl -X POST http://localhost:8080/echo -d '{\\"foo\\":\\"bar\\"}'" --duration 10 --i-own-this-target
  sll run --url http://localhost:8080/fast --duration 30 --concurrency 5 --rps 10 --i-own-this-target
  sll sample --out load-test.json
  sll validate --config load-test.json --env staging
  sll plan --config load-test.json --env staging

Notes:
  - This is not a DDoS tool.
  - Start small, monitor your app, and increase gradually.
  - Do not test third-party systems without written permission.
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) { args._.push(item); continue; }
    const key = item.slice(2);
    if (key === 'i-own-this-target') { args[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) { args[key] = true; continue; }
    i++;
    if (key === 'header') { args.header = args.header || []; args.header.push(value); }
    else args[key] = value;
  }
  return args;
}

function clampNumber(value, fallback, min, max, name) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a valid number`);
  if (n < min) throw new Error(`${name} must be >= ${min}`);
  if (n > max) {
    console.warn(`Warning: ${name} capped from ${n} to safe hard limit ${max}`);
    return max;
  }
  return n;
}

function parseHeaders(headerList = []) {
  const headers = {};
  for (const h of headerList) {
    const idx = h.indexOf(':');
    if (idx === -1) throw new Error(`Invalid header format: ${h}. Use "Key: Value"`);
    headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return headers;
}


function getByPath(obj, dottedPath) {
  if (!dottedPath) return undefined;
  return String(dottedPath).split('.').reduce((acc, key) => acc == null ? undefined : acc[key], obj);
}

function setByPath(obj, dottedPath, value) {
  const parts = String(dottedPath).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] ||= {};
    cur = cur[parts[i]];
  }
  cur[parts.at(-1)] = value;
}

function renderTemplate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (_, key) => {
      const v = getByPath(vars, key);
      return v == null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.map(v => renderTemplate(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderTemplate(v, vars)]));
  }
  return value;
}

function mergeDeep(base, override) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = mergeDeep(out[k], v);
    else out[k] = v;
  }
  return out;
}

function normalizeEndpoint(ep, idx, vars) {
  ep = renderTemplate(ep, vars);
  validateEndpoint(ep, idx);  // Add validation
  
  if (ep.graphql) {
    ep.method ||= 'POST';
    ep.headers = { 'Content-Type': 'application/json', ...(ep.headers || {}) };
    ep.body = JSON.stringify({ query: ep.graphql.query, variables: ep.graphql.variables || {} });
  }
  if (!ep.url) throw new Error(`Endpoint #${idx + 1} missing url`);
  const u = new URL(ep.url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Endpoint #${idx + 1} must use http or https`);
  const method = String(ep.method || 'GET').toUpperCase();
  let body = ep.body;
  if (body && typeof body !== 'string') body = JSON.stringify(body);
  if (body && Buffer.byteLength(body) > HARD_LIMITS.maxBodyBytes) throw new Error(`Endpoint #${idx + 1} body exceeds ${HARD_LIMITS.maxBodyBytes} bytes`);
  return { name: ep.name || `${method} ${u.pathname}`, url: ep.url, method, headers: ep.headers || {}, body, weight: Number(ep.weight || 1), expectStatus: ep.expectStatus, assertions: ep.assertions || [] };
}

function normalizeStage(stage, idx) {
  return {
    name: stage.name || `stage-${idx + 1}`,
    durationSeconds: clampNumber(stage.durationSeconds ?? stage.duration, 30, 1, HARD_LIMITS.maxDurationSeconds, `stages[${idx}].durationSeconds`),
    concurrency: clampNumber(stage.concurrency, 5, 1, HARD_LIMITS.maxConcurrency, `stages[${idx}].concurrency`),
    rps: clampNumber(stage.rps, 10, 1, HARD_LIMITS.maxRps, `stages[${idx}].rps`)
  };
}

function normalizeStages(config) {
  const stages = Array.isArray(config.stages) && config.stages.length
    ? config.stages.map(normalizeStage)
    : [normalizeStage({ name: 'steady', durationSeconds: config.durationSeconds, concurrency: config.concurrency, rps: config.rps }, 0)];
  const totalDuration = stages.reduce((sum, stage) => sum + stage.durationSeconds, 0);
  if (totalDuration > HARD_LIMITS.maxDurationSeconds) throw new Error(`Total staged duration ${totalDuration}s exceeds safe hard limit ${HARD_LIMITS.maxDurationSeconds}s`);
  return stages;
}

function applyCliOverrides(config, args) {
  const loadShapeOverridden = args.duration !== undefined || args.concurrency !== undefined || args.rps !== undefined;
  if (loadShapeOverridden) config.stages = undefined;
  if (args.duration !== undefined) config.durationSeconds = args.duration;
  if (args.concurrency !== undefined) config.concurrency = args.concurrency;
  if (args.rps !== undefined) config.rps = args.rps;
  if (args.timeout !== undefined) config.timeoutMs = args.timeout;
  return config;
}

function parseCurlCommand(curlStr) {
  if (!curlStr || typeof curlStr !== 'string') throw new Error('Invalid curl command');
  
  const clean = curlStr.trim().replace(/^curl\s+/i, '');
  
  // Extract URL (quoted or unquoted)
  const urlMatch = clean.match(/(?:^|\s)(?:'([^']+)'|"([^"]+)"|(https?:\/\/[^\s]+))/);
  const rawUrl = urlMatch ? (urlMatch[1] || urlMatch[2] || urlMatch[3]) : null;
  if (!rawUrl || !rawUrl.startsWith('http')) {
    const fallbackMatch = clean.match(/https?:\/\/[^\s"']+/);
    if (!fallbackMatch) throw new Error('No HTTP/HTTPS URL found in curl command');
  }
  const url = rawUrl && rawUrl.startsWith('http') ? rawUrl : clean.match(/https?:\/\/[^\s"']+/)[0];

  // Extract Method
  let method = 'GET';
  const methodMatch = clean.match(/(?:-X|--request)\s+([A-Za-z]+)/i);
  if (methodMatch) {
    method = methodMatch[1].toUpperCase();
  }

  // Extract Headers
  const headers = {};
  const headerRegex = /(?:-H|--header)\s+(?:'([^']+)'|"([^"]+)")/g;
  let hMatch;
  while ((hMatch = headerRegex.exec(clean)) !== null) {
    const raw = hMatch[1] || hMatch[2];
    const colonIdx = raw.indexOf(':');
    if (colonIdx !== -1) {
      const k = raw.slice(0, colonIdx).trim();
      const v = raw.slice(colonIdx + 1).trim();
      headers[k] = v;
    }
  }

  // Extract Body
  let body = null;
  const dataMatch = clean.match(/(?:-d|--data|--data-raw|--data-binary)\s+(?:'([^']*)'|"([^"]*)")/s) ||
                    clean.match(/(?:-d|--data|--data-raw|--data-binary)\s+([^\s]+)/);
  if (dataMatch) {
    body = dataMatch[1] !== undefined ? dataMatch[1] : (dataMatch[2] !== undefined ? dataMatch[2] : dataMatch[3]);
    if (!methodMatch) method = 'POST';
    const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
    if (!hasContentType && body) {
      try {
        JSON.parse(body);
        headers['Content-Type'] = 'application/json';
      } catch {
        // Not JSON
      }
    }
  }

  const pathname = new URL(url).pathname;
  return {
    name: `curl-${method.toLowerCase()}${pathname === '/' ? '' : pathname.replace(/\//g, '-')}`,
    url,
    method,
    headers,
    body,
    weight: 1
  };
}

function startMockServer(port = 8080, host = '127.0.0.1') {
  const requestHistory = new Map(); // ip -> [timestamps]

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const clientIp = req.socket.remoteAddress || '127.0.0.1';

    // CORS & Common Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/' || pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: VERSION, uptime: process.uptime(), time: new Date().toISOString() }));
      return;
    }

    if (pathname === '/fast') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', route: 'fast', timestamp: Date.now() }));
      return;
    }

    if (pathname === '/slow') {
      const delayMs = parseInt(parsedUrl.searchParams.get('delay') || '100', 10);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', route: 'slow', delayedMs: delayMs, timestamp: Date.now() }));
      }, delayMs);
      return;
    }

    if (pathname === '/error') {
      const code = parseInt(parsedUrl.searchParams.get('status') || '500', 10);
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Simulated error ${code}`, status: code }));
      return;
    }

    if (pathname === '/rate-limit') {
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '10', 10);
      const windowSec = parseInt(parsedUrl.searchParams.get('window') || '5', 10);
      const now = Date.now();
      const windowMs = windowSec * 1000;

      let history = requestHistory.get(clientIp) || [];
      history = history.filter(ts => now - ts < windowMs);
      history.push(now);
      requestHistory.set(clientIp, history);

      if (history.length > limit) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(windowSec)
        });
        res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: windowSec, limit }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', requestsInWindow: history.length, limit }));
      return;
    }

    if (pathname === '/echo') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: parsed
        }));
      });
      return;
    }

    if (pathname === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        users: [
          { id: 1, name: 'Ada Lovelace', role: 'admin' },
          { id: 2, name: 'Alan Turing', role: 'member' }
        ],
        meta: { total: 2, version: '1.0' }
      }));
      return;
    }

    // Default 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', path: pathname }));
  });

  server.listen(port, host);
  return server;
}

function normalizeConfig(args) {
  let config = {};
  if (args.curl) {
    const ep = parseCurlCommand(args.curl);
    config = {
      name: ep.name || 'curl-imported-test',
      durationSeconds: args.duration,
      concurrency: args.concurrency,
      rps: args.rps,
      timeoutMs: args.timeout,
      endpoints: [ep]
    };
  } else if (args.config) config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  else if (args.endpoints && Array.isArray(args.endpoints)) {
    config = {
      name: args.name || 'custom-test',
      durationSeconds: args.duration,
      concurrency: args.concurrency,
      rps: args.rps,
      timeoutMs: args.timeout,
      endpoints: args.endpoints
    };
  } else {
    if (!args.url) throw new Error('Provide --config <file>, --url <url>, or --curl "<command>"');
    config = {
      name: 'simple-test',
      durationSeconds: args.duration,
      concurrency: args.concurrency,
      rps: args.rps,
      timeoutMs: args.timeout,
      endpoints: [{ name: 'default', url: args.url, method: args.method || 'GET', headers: parseHeaders(args.header), body: args.body, weight: 1 }]
    };
  }

  const envName = args.env || config.defaultEnv;
  if (envName) {
    if (!config.environments?.[envName]) throw new Error(`Environment profile not found: ${envName}`);
    config = mergeDeep(config, config.environments[envName]);
    config.activeEnv = envName;
  }

  // CLI values override both base config and selected environment profile.
  config = applyCliOverrides(config, args);

  const stages = normalizeStages(config);
  const durationSeconds = stages.reduce((sum, stage) => sum + stage.durationSeconds, 0);
  const maxConcurrency = Math.max(...stages.map(s => s.concurrency));
  const maxRps = Math.max(...stages.map(s => s.rps));
  const vars = { ...(config.variables || {}), env: envName || '', ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) };

  const normalized = {
    name: config.name || 'safe-load-test',
    activeEnv: config.activeEnv || envName || null,
    variables: vars,
    setup: config.setup || [],
    stages,
    durationSeconds,
    concurrency: maxConcurrency,
    rps: maxRps,
    timeoutMs: clampNumber(config.timeoutMs, 10000, 100, 120000, 'timeoutMs'),
    endpoints: config.endpoints || [],
    endpointTemplates: config.endpoints || [],
    thresholds: config.thresholds || {}
  };

  if (!Array.isArray(normalized.endpoints) || normalized.endpoints.length === 0) throw new Error('Config must contain at least one endpoint');
  normalized.endpoints = normalized.endpoints.map((ep, idx) => normalizeEndpoint(ep, idx, normalized.variables));
  normalized.setup = normalized.setup.map((ep, idx) => ({ ...normalizeEndpoint(ep, idx, normalized.variables), extract: ep.extract || {} }));
  return normalized;
}

function pickEndpoint(endpoints) {
  const total = endpoints.reduce((sum, ep) => sum + Math.max(0, ep.weight), 0);
  let r = Math.random() * total;
  for (const ep of endpoints) { r -= Math.max(0, ep.weight); if (r <= 0) return ep; }
  return endpoints[0];
}

// Optimized percentile calculation - caches sorted array
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

// Calculate multiple percentiles in a single pass
function calculatePercentiles(values, percentiles) {
  if (!values.length) return percentiles.reduce((acc, p) => ({ ...acc, [p]: 0 }), {});
  const sorted = [...values].sort((a, b) => a - b);
  return percentiles.reduce((acc, p) => {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    acc[p] = sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
    return acc;
  }, {});
}

function evaluateThresholds(thresholds, metrics) {
  const checks = {};
  if (thresholds.maxErrorRate !== undefined) checks.maxErrorRate = { pass: metrics.errorRate <= Number(thresholds.maxErrorRate), actual: metrics.errorRate, expected: `<= ${thresholds.maxErrorRate}` };
  if (thresholds.p95Ms !== undefined) checks.p95Ms = { pass: metrics.p95 <= Number(thresholds.p95Ms), actual: metrics.p95, expected: `<= ${thresholds.p95Ms}ms` };
  if (thresholds.p99Ms !== undefined) checks.p99Ms = { pass: metrics.p99 <= Number(thresholds.p99Ms), actual: metrics.p99, expected: `<= ${thresholds.p99Ms}ms` };
  return checks;
}

function summarize(results, startedAt, finishedAt, config) {
  const durations = results.map(r => r.durationMs).filter(Number.isFinite);
  const total = results.length;
  const failed = results.filter(r => r.error || r.status >= 400 || r.status === 0).length;
  const byStatus = {};
  const byEndpoint = {};
  for (const r of results) {
    byStatus[r.status || 'error'] = (byStatus[r.status || 'error'] || 0) + 1;
    byEndpoint[r.endpoint] ||= { total: 0, failed: 0, durations: [] };
    byEndpoint[r.endpoint].total++;
    if (r.error || r.status >= 400 || r.status === 0) byEndpoint[r.endpoint].failed++;
    if (Number.isFinite(r.durationMs)) byEndpoint[r.endpoint].durations.push(r.durationMs);
  }
  
  // Calculate global percentiles in single pass
  const globalPercentiles = calculatePercentiles(durations, [50, 90, 95, 99]);
  
  const endpointSummary = {};
  for (const [name, data] of Object.entries(byEndpoint)) {
    const epPercentiles = calculatePercentiles(data.durations, [95, 99]);
    endpointSummary[name] = {
      total: data.total,
      failed: data.failed,
      errorRate: data.total ? data.failed / data.total : 0,
      avgMs: data.durations.length ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length : 0,
      p95Ms: epPercentiles[95],
      p99Ms: epPercentiles[99]
    };
  }
  
  // Count assertion failures
  const assertionFailures = {};
  for (const result of results) {
    if (!result.assertions) continue;
    
    for (const assertion of result.assertions) {
      if (!assertion.passed) {
        const key = `${result.endpoint}.${assertion.type}`;
        assertionFailures[key] = (assertionFailures[key] || 0) + 1;
      }
    }
  }
  
  const elapsedSeconds = (finishedAt - startedAt) / 1000;
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const metrics = { errorRate: total ? failed / total : 0, p95: globalPercentiles[95], p99: globalPercentiles[99], avg };
  return {
    testName: config.name,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    elapsedSeconds,
    requested: { durationSeconds: config.durationSeconds, concurrency: config.concurrency, rps: config.rps, stages: config.stages },
    totals: { requests: total, failed, errorRate: metrics.errorRate, achievedRps: elapsedSeconds > 0 ? total / elapsedSeconds : 0 },
    latencyMs: { avg, min: durations.length ? Math.min(...durations) : 0, max: durations.length ? Math.max(...durations) : 0, p50: globalPercentiles[50], p90: globalPercentiles[90], p95: metrics.p95, p99: metrics.p99 },
    byStatus,
    byEndpoint: endpointSummary,
    thresholds: evaluateThresholds(config.thresholds || {}, metrics),
    assertionFailures: Object.keys(assertionFailures).length > 0 ? assertionFailures : undefined
  };
}

async function doRequest(ep, timeoutMs, captureBody = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    debug(`Request: ${ep.method} ${ep.url}`);
    if (ep.headers && Object.keys(ep.headers).length) debug(`Headers:`, ep.headers);
    if (ep.body) debug(`Body:`, typeof ep.body === 'string' ? ep.body.slice(0, 100) : ep.body);
    
    const res = await fetch(ep.url, { 
      method: ep.method, 
      headers: ep.headers, 
      body: ['GET', 'HEAD'].includes(ep.method) ? undefined : ep.body, 
      redirect: 'manual', 
      signal: controller.signal,
      keepalive: true  // Enable connection reuse
    });
    
    // Capture response headers
    const headers = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    
    // Only consume body when needed - for non-success responses, skip body reading if not capturing
    const text = captureBody ? await res.text().catch(() => '') : 
                 (res.status >= 200 && res.status < 300) ? await res.arrayBuffer().then(() => '').catch(() => '') :
                 '';
    
    const durationMs = performance.now() - start;
    debug(`Response: ${res.status} in ${durationMs.toFixed(2)}ms`);
    
    const result = { 
      endpoint: ep.name, 
      method: ep.method, 
      url: ep.url, 
      status: res.status, 
      durationMs, 
      error: null, 
      timestamp: new Date().toISOString(), 
      body: text,
      headers
    };
    
    // Evaluate assertions if present
    if (ep.assertions && ep.assertions.length > 0) {
      result.assertions = evaluateAssertions(result, ep.assertions);
    }
    
    return result;
  } catch (err) {
    const durationMs = performance.now() - start;
    debug(`Request failed: ${err?.message}`);
    
    return { 
      endpoint: ep.name, 
      method: ep.method, 
      url: ep.url, 
      status: 0, 
      durationMs, 
      error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err), 
      timestamp: new Date().toISOString(), 
      body: '',
      headers: {}
    };
  } finally { clearTimeout(timeout); }
}

/**
 * Execute request with exponential backoff retry
 * @param {Endpoint} ep - Endpoint configuration
 * @param {number} timeoutMs - Request timeout
 * @param {RetryConfig} retryConfig - Retry configuration
 * @param {boolean} captureBody - Whether to capture response body
 * @returns {Promise<RequestResult>}
 */
async function doRequestWithRetry(ep, timeoutMs, retryConfig = {}, captureBody = false) {
  const {
    enabled = true,
    maxAttempts = 3,
    backoffMultiplier = 2,
    maxBackoffMs = 10000,
    retryOn = [500, 502, 503, 504, 'ECONNRESET', 'ETIMEDOUT', 'timeout']
  } = retryConfig;
  
  if (!enabled || maxAttempts <= 1) {
    return doRequest(ep, timeoutMs, captureBody);
  }
  
  let lastResult;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await doRequest(ep, timeoutMs, captureBody);
    
    // Success or non-retryable error
    const shouldRetry = lastResult.error 
      ? retryOn.includes(lastResult.error) || retryOn.some(code => lastResult.error.includes(String(code)))
      : retryOn.includes(lastResult.status);
    
    if (!shouldRetry) {
      if (attempt > 1) {
        debug(`Request succeeded on attempt ${attempt}`);
      }
      return lastResult;
    }
    
    const errorMsg = lastResult.error || `HTTP ${lastResult.status}`;
    
    // Don't backoff after last attempt
    if (attempt < maxAttempts) {
      const backoffMs = Math.min(
        1000 * Math.pow(backoffMultiplier, attempt - 1),
        maxBackoffMs
      );
      
      debug(`Retry ${attempt}/${maxAttempts} for ${ep.name} after ${backoffMs}ms (${errorMsg})`);
      
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
  
  // All retries exhausted
  debug(`All ${maxAttempts} retries exhausted for ${ep.name}`);
  
  return {
    ...lastResult,
    retriesExhausted: true,
    attemptsMade: maxAttempts
  };
}

/**
 * Evaluate assertions against response
 * @param {RequestResult} result - Request result
 * @param {Assertion[]} assertions - Assertions to evaluate
 * @returns {AssertionResult[]}
 */
function evaluateAssertions(result, assertions = []) {
  if (!assertions.length) return [];
  
  const results = [];
  let responseBody;
  
  try {
    responseBody = result.body ? JSON.parse(result.body) : null;
  } catch {
    responseBody = null;
  }
  
  for (const assertion of assertions) {
    const assertionResult = {
      type: assertion.type,
      passed: false,
      expected: null,
      actual: null,
      message: ''
    };
    
    try {
      switch (assertion.type) {
        case 'status':
          assertionResult.expected = assertion.value;
          assertionResult.actual = result.status;
          assertionResult.passed = result.status === assertion.value;
          assertionResult.message = assertionResult.passed 
            ? 'Status matches' 
            : `Expected ${assertion.value}, got ${result.status}`;
          break;
          
        case 'jsonPath':
          const value = getByPath(responseBody, assertion.path);
          assertionResult.actual = value;
          
          if (assertion.equals !== undefined) {
            assertionResult.expected = assertion.equals;
            assertionResult.passed = value === assertion.equals;
            assertionResult.message = assertionResult.passed
              ? 'Value matches'
              : `Expected ${assertion.equals}, got ${value}`;
          } else if (assertion.contains !== undefined) {
            assertionResult.expected = `contains "${assertion.contains}"`;
            assertionResult.passed = String(value).includes(assertion.contains);
            assertionResult.message = assertionResult.passed
              ? 'Contains expected value'
              : `Expected to contain "${assertion.contains}", got ${value}`;
          }
          break;
          
        case 'header':
          const headerValue = result.headers?.[assertion.name.toLowerCase()];
          assertionResult.actual = headerValue;
          
          if (assertion.equals !== undefined) {
            assertionResult.expected = assertion.equals;
            assertionResult.passed = headerValue === assertion.equals;
            assertionResult.message = assertionResult.passed
              ? 'Header matches'
              : `Expected ${assertion.equals}, got ${headerValue}`;
          } else if (assertion.contains !== undefined) {
            assertionResult.expected = `contains "${assertion.contains}"`;
            assertionResult.passed = headerValue?.includes(assertion.contains);
            assertionResult.message = assertionResult.passed
              ? 'Header contains expected value'
              : `Expected to contain "${assertion.contains}", got ${headerValue}`;
          }
          break;
          
        case 'responseTime':
          assertionResult.actual = result.durationMs;
          
          if (assertion.lessThan !== undefined) {
            assertionResult.expected = `< ${assertion.lessThan}ms`;
            assertionResult.passed = result.durationMs < assertion.lessThan;
            assertionResult.message = assertionResult.passed
              ? 'Response time acceptable'
              : `Expected < ${assertion.lessThan}ms, got ${result.durationMs.toFixed(2)}ms`;
          }
          break;
          
        default:
          assertionResult.message = `Unknown assertion type: ${assertion.type}`;
      }
        
    } catch (err) {
      assertionResult.passed = false;
      assertionResult.message = `Error evaluating assertion: ${err.message}`;
    }
    
    results.push(assertionResult);
  }
  
  return results;
}

async function runSetup(config) {
  if (!config.setup?.length) return;
  console.log(`Running ${config.setup.length} setup step(s)...`);
  for (const [i, step] of config.setup.entries()) {
    const rendered = normalizeEndpoint(step, i, config.variables);
    const res = await doRequest(rendered, config.timeoutMs, true);
    const okStatuses = Array.isArray(step.expectStatus) ? step.expectStatus : [step.expectStatus || 200];
    if (res.error || !okStatuses.includes(res.status)) throw new Error(`Setup step failed: ${step.name} status=${res.status} error=${res.error || 'none'}`);
    let json = undefined;
    try { json = res.body ? JSON.parse(res.body) : undefined; } catch {}
    for (const [varName, sourcePath] of Object.entries(step.extract || {})) {
      const value = sourcePath.startsWith('body.') ? getByPath(json, sourcePath.slice(5)) : getByPath(json, sourcePath);
      if (value == null) throw new Error(`Setup extraction failed for ${varName} from ${sourcePath}`);
      setByPath(config.variables, varName, value);
    }
  }
  config.endpoints = config.endpointTemplates.map((ep, idx) => normalizeEndpoint(ep, idx, config.variables));
}

function stageAtElapsed(config, elapsedSeconds) {
  let cursor = 0;
  for (const stage of config.stages) {
    cursor += stage.durationSeconds;
    if (elapsedSeconds < cursor) return stage;
  }
  return config.stages.at(-1);
}

async function runTest(config) {
  const results = [];
  let active = 0, launched = 0, stopped = false;
  await runSetup(config);
  const startedAt = Date.now();
  const stopAt = startedAt + config.durationSeconds * 1000;
  
  console.log(chalk.bold.cyan(`\n🚀 Starting: ${config.name}${config.activeEnv ? chalk.gray(' [' + config.activeEnv + ']') : ''}`));
  console.log(`Duration: ${chalk.yellow(config.durationSeconds + 's')} | Max concurrency: ${chalk.yellow(config.concurrency)} | Max RPS cap: ${chalk.yellow(config.rps)}`);
  if (config.stages.length > 1) console.log('Stages:', config.stages.map(s => `${chalk.cyan(s.name)}:${s.durationSeconds}s/${s.concurrency}c/${s.rps}rps`).join(' → '));
  console.log(chalk.gray('Press Ctrl+C to stop early.\n'));
  
  // Create progress bar if in TTY environment
  const isTTY = Boolean(process.stdout.isTTY);
  let progressBar = null;
  if (isTTY) {
    progressBar = new cliProgress.SingleBar({
      format: `${chalk.cyan('{bar}')} | {percentage}% | ETA: {eta}s | Stage: {stage} | Requests: {requests} | RPS: {rps} | Failed: {failed}`,
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    }, cliProgress.Presets.shades_classic);
    
    progressBar.start(config.durationSeconds, 0, {
      stage: 'starting',
      requests: 0,
      rps: '0.0',
      failed: 0
    });
  }
  
  process.on('SIGINT', () => { stopped = true; if (progressBar) progressBar.stop(); console.log(chalk.yellow('\n⚠️  Stopping gracefully...')); });
  let lastProgress = Date.now();
  let lastLaunch = Date.now();
  let requestCounter = 0;
  
  while (!stopped && Date.now() < stopAt) {
    const now = Date.now();
    const elapsedSeconds = (now - startedAt) / 1000;
    const stage = stageAtElapsed(config, elapsedSeconds);
    
    // Adaptive RPS control - compensate for drift
    const timeSinceLastLaunch = now - lastLaunch;
    const targetInterval = 1000 / stage.rps;
    const shouldLaunch = timeSinceLastLaunch >= targetInterval;
    
    if (shouldLaunch && active < stage.concurrency) {
      const ep = pickEndpoint(config.endpoints);
      active++; launched++; requestCounter++;
      lastLaunch = now;
      
      // Use retry logic if configured
      const retryConfig = config.retry || { enabled: true, maxAttempts: 3 };
      doRequestWithRetry(ep, config.timeoutMs, retryConfig, false)
        .then(r => results.push(r))
        .finally(() => active--);
      
      // Prevent memory overflow - stream results for very long tests
      if (results.length > 50000 && results.length % 10000 === 0) {
        console.log(chalk.yellow(`\n⚠️  Large result set: ${results.length} results. Consider shorter duration.`));
      }
    }
    
    if (now - lastProgress >= 500) {
      const failed = results.filter(r => r.error || r.status >= 400 || r.status === 0).length;
      const actualRps = elapsedSeconds > 0 ? results.length / elapsedSeconds : 0;
      
      if (progressBar) {
        progressBar.update(elapsedSeconds, {
          stage: stage.name,
          requests: results.length,
          rps: actualRps.toFixed(1),
          failed
        });
      } else if (now - lastProgress >= 2000) {
        console.log(`[${Math.round(elapsedSeconds)}s/${config.durationSeconds}s] Requests: ${results.length} | RPS: ${actualRps.toFixed(1)} | Failed: ${failed}`);
      }
      
      lastProgress = now;
    }
    
    // Dynamic sleep based on remaining time until next request
    const timeUntilNext = Math.max(1, targetInterval - (Date.now() - lastLaunch));
    await new Promise(resolve => setTimeout(resolve, Math.min(timeUntilNext, 10)));
  }
  
  if (progressBar) progressBar.stop();
  
  // Wait for in-flight requests
  while (active > 0) await new Promise(resolve => setTimeout(resolve, 50));
  const finishedAt = Date.now();
  console.log(chalk.bold.green('\n✓ Test finished.'));
  return { summary: summarize(results, startedAt, finishedAt, config), results };
}

function ensureDirFor(filePath) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
function writeCsv(filePath, results) {
  ensureDirFor(filePath);
  const esc = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const rows = [['timestamp', 'endpoint', 'method', 'url', 'status', 'durationMs', 'error'].map(esc).join(','), ...results.map(r => [r.timestamp, r.endpoint, r.method, r.url, r.status, r.durationMs.toFixed(2), r.error || ''].map(esc).join(','))];
  fs.writeFileSync(filePath, rows.join('\n'));
}


function htmlEscape(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function writeHtmlReport(filePath, summary, results) {
  ensureDirFor(filePath);
  const statusRows = Object.entries(summary.byStatus).map(([k, v]) => `<tr><td>${htmlEscape(k)}</td><td>${v}</td></tr>`).join('');
  const endpointRows = Object.entries(summary.byEndpoint).map(([name, e]) => `<tr><td>${htmlEscape(name)}</td><td>${e.total}</td><td>${e.failed}</td><td>${(e.errorRate*100).toFixed(2)}%</td><td>${e.avgMs.toFixed(2)}</td><td>${e.p95Ms.toFixed(2)}</td><td>${e.p99Ms.toFixed(2)}</td></tr>`).join('');
  const thresholdRows = Object.entries(summary.thresholds || {}).map(([name, t]) => `<tr><td>${htmlEscape(name)}</td><td class="${t.pass ? 'pass' : 'fail'}">${t.pass ? 'PASS' : 'FAIL'}</td><td>${htmlEscape(t.actual)}</td><td>${htmlEscape(t.expected)}</td></tr>`).join('') || '<tr><td colspan="4">No thresholds configured</td></tr>';
  const recentRows = results.slice(-100).reverse().map(r => `<tr><td>${htmlEscape(r.timestamp)}</td><td>${htmlEscape(r.endpoint)}</td><td>${r.status}</td><td>${r.durationMs.toFixed(2)}</td><td>${htmlEscape(r.error || '')}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Safe Load Lab Report</title><style>
    body{font-family:Inter,system-ui,Segoe UI,Arial,sans-serif;margin:0;background:#0f172a;color:#e5e7eb}main{max-width:1100px;margin:0 auto;padding:32px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.card{background:#111827;border:1px solid #334155;border-radius:14px;padding:18px;box-shadow:0 8px 24px #0004}.metric{font-size:28px;font-weight:800;color:#93c5fd}.label{color:#94a3b8;font-size:13px}table{width:100%;border-collapse:collapse;margin:16px 0;background:#111827;border-radius:12px;overflow:hidden}th,td{padding:10px 12px;border-bottom:1px solid #334155;text-align:left}th{background:#1e293b;color:#bfdbfe}.pass{color:#86efac;font-weight:800}.fail{color:#fca5a5;font-weight:800}h1,h2{color:white}.muted{color:#94a3b8}</style></head><body><main>
    <h1>Safe Load Lab Report</h1><p class="muted">${htmlEscape(summary.testName)} | ${htmlEscape(summary.startedAt)} → ${htmlEscape(summary.finishedAt)}</p>
    <section class="grid"><div class="card"><div class="metric">${summary.totals.requests}</div><div class="label">Requests</div></div><div class="card"><div class="metric">${summary.totals.failed}</div><div class="label">Failed</div></div><div class="card"><div class="metric">${(summary.totals.errorRate*100).toFixed(2)}%</div><div class="label">Error Rate</div></div><div class="card"><div class="metric">${summary.totals.achievedRps.toFixed(2)}</div><div class="label">Achieved RPS</div></div><div class="card"><div class="metric">${summary.latencyMs.p95.toFixed(1)}ms</div><div class="label">p95 Latency</div></div><div class="card"><div class="metric">${summary.latencyMs.p99.toFixed(1)}ms</div><div class="label">p99 Latency</div></div></section>
    <h2>Thresholds</h2><table><thead><tr><th>Name</th><th>Result</th><th>Actual</th><th>Expected</th></tr></thead><tbody>${thresholdRows}</tbody></table>
    <h2>Endpoints</h2><table><thead><tr><th>Endpoint</th><th>Total</th><th>Failed</th><th>Error Rate</th><th>Avg ms</th><th>p95 ms</th><th>p99 ms</th></tr></thead><tbody>${endpointRows}</tbody></table>
    <h2>Status Codes</h2><table><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>${statusRows}</tbody></table>
    <h2>Recent Requests</h2><table><thead><tr><th>Time</th><th>Endpoint</th><th>Status</th><th>Duration ms</th><th>Error</th></tr></thead><tbody>${recentRows}</tbody></table>
    </main></body></html>`;
  fs.writeFileSync(filePath, html);
}

async function runRateLimitCheck(args) {
  if (!args.url) throw new Error('rate-limit requires --url');
  const config = normalizeConfig({ ...args, _: ['run'], duration: args.duration || 20, concurrency: args.concurrency || 5, rps: Math.min(Number(args.rps || 10), 50) });
  config.name = 'safe-rate-limit-verification';
  config.thresholds = {};
  const { summary, results } = await runTest(config);
  const limited = results.filter(r => [429, 403].includes(r.status)).length;
  printSummary(summary);
  console.log(`\nRate-limit signals: ${limited} response(s) with HTTP 429/403`);
  console.log(limited > 0 ? 'Result: likely rate limiting is active.' : 'Result: no rate-limit response detected at this safe test level.');
  const defaultOut = `reports/rate-limit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const out = args.out || defaultOut;
  ensureDirFor(out); fs.writeFileSync(out, JSON.stringify({ summary, results, rateLimitSignals: limited }, null, 2));
  if (args.html) { writeHtmlReport(args.html, summary, results); console.log(`HTML report saved: ${args.html}`); }
  if (args.junit) { writeJunitReport(args.junit, summary); console.log(`JUnit report saved: ${args.junit}`); }
  console.log(`JSON report saved: ${out}`);
}


function writeJunitReport(filePath, summary) {
  ensureDirFor(filePath);
  const checks = Object.entries(summary.thresholds || {});
  const failures = checks.filter(([, check]) => !check.pass);
  const cases = checks.length ? checks.map(([name, check]) => {
    const failure = check.pass ? '' : `<failure message="Threshold failed">actual=${htmlEscape(check.actual)} expected=${htmlEscape(check.expected)}</failure>`;
    return `<testcase classname="SafeLoadLab" name="${htmlEscape(name)}">${failure}</testcase>`;
  }).join('') : `<testcase classname="SafeLoadLab" name="completed" />`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Safe Load Lab" tests="${checks.length || 1}" failures="${failures.length}" time="${summary.elapsedSeconds.toFixed(3)}">${cases}</testsuite>\n`;
  fs.writeFileSync(filePath, xml);
}

/**
 * Generate markdown format report content
 * @param {Object} summary - Test summary
 * @returns {string} Markdown report content
 */
function generateMarkdownReport(summary) {
  return `# Load Test Report

**Test**: ${summary.testName}  
**Started**: ${summary.startedAt}  
**Finished**: ${summary.finishedAt}  
**Duration**: ${summary.elapsedSeconds.toFixed(2)}s

## Summary

| Metric | Value |
|--------|-------|
| Total Requests | ${summary.totals.requests} |
| Failed | ${summary.totals.failed} |
| Error Rate | ${(summary.totals.errorRate * 100).toFixed(2)}% |
| Achieved RPS | ${summary.totals.achievedRps.toFixed(2)} |

## Latency

| Percentile | Value |
|------------|-------|
| Average | ${summary.latencyMs.avg.toFixed(2)}ms |
| Median (p50) | ${summary.latencyMs.p50.toFixed(2)}ms |
| p90 | ${summary.latencyMs.p90.toFixed(2)}ms |
| p95 | ${summary.latencyMs.p95.toFixed(2)}ms |
| p99 | ${summary.latencyMs.p99.toFixed(2)}ms |
| Min | ${summary.latencyMs.min.toFixed(2)}ms |
| Max | ${summary.latencyMs.max.toFixed(2)}ms |

## Status Distribution

| Status Code | Count |
|-------------|-------|
${Object.entries(summary.byStatus).map(([status, count]) => `| ${status} | ${count} |`).join('\n')}

## Endpoints

${Object.entries(summary.byEndpoint).map(([name, stats]) => `
### ${name}

- **Total Requests**: ${stats.total}
- **Failed**: ${stats.failed}
- **Error Rate**: ${(stats.errorRate * 100).toFixed(2)}%
- **Average Latency**: ${stats.avgMs.toFixed(2)}ms
- **p95 Latency**: ${stats.p95Ms.toFixed(2)}ms
- **p99 Latency**: ${stats.p99Ms.toFixed(2)}ms
`).join('\n')}

## Thresholds

${Object.entries(summary.thresholds || {}).map(([name, check]) => `
- **${name}**: ${check.pass ? '✅ PASS' : '❌ FAIL'}
  - Actual: ${typeof check.actual === 'number' ? check.actual.toFixed(4) : check.actual}
  - Expected: ${check.expected}
`).join('\n') || 'No thresholds configured'}

${summary.assertionFailures && Object.keys(summary.assertionFailures).length > 0 ? `
## Assertion Failures

${Object.entries(summary.assertionFailures).map(([key, count]) => `- **${key}**: ${count} failures`).join('\n')}
` : ''}

---

*Generated by Safe Load Lab v${VERSION}*
`;
}

/**
 * Write markdown format report
 * @param {string} filePath - Output file path
 * @param {Object} summary - Test summary
 */
function writeMarkdownReport(filePath, summary) {
  ensureDirFor(filePath);
  const md = generateMarkdownReport(summary);
  fs.writeFileSync(filePath, md);
}

/**
 * Save detailed failure logs for debugging
 * @param {RequestResult[]} results - All test results
 * @param {string} outputDir - Output directory for logs
 */
function saveFailureLogs(results, outputDir = 'reports/failures') {
  const failures = results.filter(r => 
    r.error || 
    r.status >= 400 || 
    r.status === 0 ||
    (r.assertions && r.assertions.some(a => !a.passed))
  );
  
  if (!failures.length) return;
  
  ensureDirFor(path.join(outputDir, 'dummy'));
  
  for (const [idx, failure] of failures.entries()) {
    const timestamp = failure.timestamp.replace(/[:.]/g, '-');
    const logFile = path.join(outputDir, `failure-${timestamp}-${idx + 1}.json`);
    
    const logData = {
      timestamp: failure.timestamp,
      endpoint: failure.endpoint,
      method: failure.method,
      url: failure.url,
      status: failure.status,
      durationMs: failure.durationMs,
      error: failure.error,
      headers: failure.headers,
      body: failure.body ? failure.body.slice(0, 1000) : '', // Truncate long bodies
      assertions: failure.assertions,
      retriesExhausted: failure.retriesExhausted,
      attemptsMade: failure.attemptsMade
    };
    
    fs.writeFileSync(logFile, JSON.stringify(logData, null, 2));
  }
  
  console.log(chalk.yellow(`\n⚠️  ${failures.length} failure(s) logged to ${outputDir}/`));
  console.log(chalk.gray(`   Use these logs to debug failed requests and assertions`));
}

function printPlan(config) {
  console.log(`Safe Load Lab plan: ${config.name}${config.activeEnv ? ' [' + config.activeEnv + ']' : ''}`);
  console.log(`Duration: ${config.durationSeconds}s | Max concurrency: ${config.concurrency} | Max RPS: ${config.rps} | Timeout: ${config.timeoutMs}ms`);
  console.log('\nStages:');
  for (const s of config.stages) console.log(`- ${s.name}: ${s.durationSeconds}s, concurrency=${s.concurrency}, rps=${s.rps}`);
  console.log('\nSetup steps:');
  if (!config.setup.length) console.log('- none');
  for (const s of config.setup) console.log(`- ${s.name}: ${s.method} ${s.url}`);
  console.log('\nEndpoints:');
  for (const ep of config.endpoints) console.log(`- ${ep.name}: weight=${ep.weight}, ${ep.method} ${ep.url}`);
  console.log('\nThresholds:', Object.keys(config.thresholds).length ? JSON.stringify(config.thresholds, null, 2) : 'none');
}

function validateConfigCommand(args) {
  const config = normalizeConfig(args);
  console.log('Config is valid.');
  console.log(`Resolved test: ${config.name}`);
  console.log(`Environment: ${config.activeEnv || 'none'}`);
  console.log(`Duration: ${config.durationSeconds}s`);
  console.log(`Stages: ${config.stages.length}`);
  console.log(`Setup steps: ${config.setup.length}`);
  console.log(`Endpoints: ${config.endpoints.length}`);
}

function printSummary(summary) {
  console.log(chalk.bold('\n📊 Summary'));
  console.log(chalk.gray('─'.repeat(60)));
  
  const errorRate = summary.totals.errorRate;
  const errorColor = errorRate > 0.05 ? chalk.red : errorRate > 0.01 ? chalk.yellow : chalk.green;
  
  console.log(`Requests:     ${chalk.bold.white(summary.totals.requests)}`);
  console.log(`Failed:       ${errorColor.bold(summary.totals.failed)}`);
  console.log(`Error rate:   ${errorColor.bold((errorRate * 100).toFixed(2) + '%')}`);
  console.log(`Achieved RPS: ${chalk.cyan.bold(summary.totals.achievedRps.toFixed(2))}`);
  console.log(`Avg latency:  ${chalk.magenta(summary.latencyMs.avg.toFixed(2) + 'ms')}`);
  console.log(`p95 latency:  ${chalk.magenta(summary.latencyMs.p95.toFixed(2) + 'ms')}`);
  console.log(`p99 latency:  ${chalk.magenta(summary.latencyMs.p99.toFixed(2) + 'ms')}`);
  
  console.log(chalk.gray('\nStatus Distribution:'));
  for (const [status, count] of Object.entries(summary.byStatus)) {
    const statusNum = parseInt(status);
    const statusColor = isNaN(statusNum) ? chalk.red : 
                       statusNum >= 200 && statusNum < 300 ? chalk.green :
                       statusNum >= 400 ? chalk.red : chalk.yellow;
    console.log(`  ${statusColor(status)}: ${count}`);
  }
  
  const thresholdEntries = Object.entries(summary.thresholds || {});
  if (thresholdEntries.length) {
    console.log(chalk.bold('\n🎯 Thresholds'));
    for (const [name, check] of thresholdEntries) {
      const icon = check.pass ? chalk.green('✓') : chalk.red('✗');
      const color = check.pass ? chalk.green : chalk.red;
      console.log(`  ${icon} ${name}: ${color(check.pass ? 'PASS' : 'FAIL')} (actual: ${check.actual}, expected: ${check.expected})`);
    }
  }
  
  // Show assertion failures if any
  if (summary.assertionFailures && Object.keys(summary.assertionFailures).length > 0) {
    console.log(chalk.bold.yellow('\n⚠️  Assertion Failures'));
    for (const [key, count] of Object.entries(summary.assertionFailures)) {
      console.log(chalk.yellow(`  ${key}: ${count} failures`));
    }
  }
}

function createSample(out = 'load-test.json') {
  const sample = {
    name: 'my-app-safe-load-test',
    durationSeconds: 30,
    concurrency: 5,
    rps: 10,
    timeoutMs: 10000,
    thresholds: { maxErrorRate: 0.01, p95Ms: 500, p99Ms: 1000 },
    endpoints: [
      { name: 'health-check', method: 'GET', url: 'http://localhost:3000/api/health', headers: {}, weight: 3 },
      { name: 'list-items', method: 'GET', url: 'http://localhost:3000/api/items', headers: { "Accept": "application/json" }, weight: 1 }
    ]
  };
  fs.writeFileSync(out, JSON.stringify(sample, null, 2));
  console.log(`Created sample config: ${out}`);
}

// New Feature: Compare two test reports
function compareReports(file1Path, file2Path) {
  const report1 = JSON.parse(fs.readFileSync(file1Path, 'utf8'));
  const report2 = JSON.parse(fs.readFileSync(file2Path, 'utf8'));
  const s1 = report1.summary;
  const s2 = report2.summary;
  
  console.log('\n🔍 Report Comparison\n');
  console.log(`Report 1: ${s1.testName} (${s1.startedAt})`);
  console.log(`Report 2: ${s2.testName} (${s2.startedAt})\n`);
  
  const compare = (label, val1, val2, unit = '', lower = true) => {
    const diff = val2 - val1;
    const pct = val1 ? ((diff / val1) * 100).toFixed(2) : 'N/A';
    const better = lower ? (diff < 0) : (diff > 0);
    const icon = diff === 0 ? '=' : better ? '✅' : '⚠️ ';
    const sign = diff > 0 ? '+' : '';
    console.log(`${icon} ${label.padEnd(20)} ${val1.toFixed(2)}${unit} → ${val2.toFixed(2)}${unit} (${sign}${pct}%)`);
  };
  
  compare('Requests', s1.totals.requests, s2.totals.requests, '', false);
  compare('Failed', s1.totals.failed, s2.totals.failed, '', true);
  compare('Error Rate', s1.totals.errorRate * 100, s2.totals.errorRate * 100, '%', true);
  compare('Achieved RPS', s1.totals.achievedRps, s2.totals.achievedRps, '', false);
  compare('Avg Latency', s1.latencyMs.avg, s2.latencyMs.avg, 'ms', true);
  compare('p95 Latency', s1.latencyMs.p95, s2.latencyMs.p95, 'ms', true);
  compare('p99 Latency', s1.latencyMs.p99, s2.latencyMs.p99, 'ms', true);
  console.log();
}

// New Feature: Send webhook notification
async function sendWebhook(url, summary) {
  try {
    const payload = {
      testName: summary.testName,
      timestamp: summary.finishedAt,
      requests: summary.totals.requests,
      failed: summary.totals.failed,
      errorRate: summary.totals.errorRate,
      rps: summary.totals.achievedRps,
      latency: {
        avg: summary.latencyMs.avg,
        p95: summary.latencyMs.p95,
        p99: summary.latencyMs.p99
      },
      thresholds: summary.thresholds
    };
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log(`✅ Webhook sent to ${url}`);
  } catch (err) {
    console.error(`⚠️  Webhook failed: ${err.message}`);
  }
}

// New Feature: Send Slack notification
async function sendSlackNotification(webhookUrl, summary) {
  try {
    const thresholdsPassed = Object.values(summary.thresholds || {}).every(t => t.pass);
    const color = thresholdsPassed ? '#36a64f' : '#ff0000';
    const emoji = thresholdsPassed ? '✅' : '❌';
    
    const message = {
      attachments: [{
        color,
        title: `${emoji} Load Test: ${summary.testName}`,
        fields: [
          { title: 'Requests', value: summary.totals.requests.toString(), short: true },
          { title: 'Failed', value: summary.totals.failed.toString(), short: true },
          { title: 'Error Rate', value: `${(summary.totals.errorRate * 100).toFixed(2)}%`, short: true },
          { title: 'RPS', value: summary.totals.achievedRps.toFixed(2), short: true },
          { title: 'Avg Latency', value: `${summary.latencyMs.avg.toFixed(2)}ms`, short: true },
          { title: 'p95 Latency', value: `${summary.latencyMs.p95.toFixed(2)}ms`, short: true }
        ],
        footer: 'Safe Load Lab',
        ts: Math.floor(new Date(summary.finishedAt).getTime() / 1000)
      }]
    };
    
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });
    console.log('✅ Slack notification sent');
  } catch (err) {
    console.error(`⚠️  Slack notification failed: ${err.message}`);
  }
}

// New Feature: Spike test (sudden traffic increase)
async function runSpikeTest(args) {
  if (!args.url && !args.config) throw new Error('spike requires --url or --config');
  
  const baseConfig = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : {
    endpoints: [{ url: args.url, method: args.method || 'GET' }]
  };
  
  baseConfig.stages = [
    { name: 'baseline', durationSeconds: 30, concurrency: 2, rps: 5 },
    { name: 'spike', durationSeconds: 60, concurrency: 20, rps: 50 },
    { name: 'recovery', durationSeconds: 30, concurrency: 2, rps: 5 }
  ];
  baseConfig.name = 'spike-test';
  
  const normalized = normalizeConfig({ ...args, _: ['run'], config: null });
  normalized.stages = baseConfig.stages.map(normalizeStage);
  normalized.durationSeconds = normalized.stages.reduce((sum, s) => sum + s.durationSeconds, 0);
  
  console.log('🚀 Starting Spike Test (baseline → spike → recovery)\n');
  const { summary, results } = await runTest(normalized);
  return { summary, results };
}

// New Feature: Soak test (sustained load)
async function runSoakTest(args) {
  if (!args.url && !args.config) throw new Error('soak requires --url or --config');
  
  const duration = Number(args.duration || 300); // 5 minutes default
  if (duration > HARD_LIMITS.maxDurationSeconds) {
    throw new Error(`Soak duration exceeds safe limit of ${HARD_LIMITS.maxDurationSeconds}s`);
  }
  
  const baseConfig = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : {
    endpoints: [{ url: args.url, method: args.method || 'GET' }]
  };
  
  baseConfig.stages = [
    { name: 'soak', durationSeconds: duration, concurrency: Number(args.concurrency || 10), rps: Number(args.rps || 20) }
  ];
  baseConfig.name = 'soak-test';
  
  console.log(`🕐 Starting Soak Test (sustained ${duration}s load)\n`);
  const normalized = normalizeConfig({ ...args, _: ['run'], config: null });
  normalized.stages = baseConfig.stages.map(normalizeStage);
  normalized.durationSeconds = duration;
  
  const { summary, results } = await runTest(normalized);
  return { summary, results };
}

// New Feature: Stress test (gradually increasing load)
async function runStressTest(args) {
  if (!args.url && !args.config) throw new Error('stress requires --url or --config');
  
  const baseConfig = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : {
    endpoints: [{ url: args.url, method: args.method || 'GET' }]
  };
  
  baseConfig.stages = [
    { name: 'stage-1', durationSeconds: 60, concurrency: 5, rps: 10 },
    { name: 'stage-2', durationSeconds: 60, concurrency: 10, rps: 20 },
    { name: 'stage-3', durationSeconds: 60, concurrency: 20, rps: 40 },
    { name: 'stage-4', durationSeconds: 60, concurrency: 40, rps: 80 },
    { name: 'stage-5', durationSeconds: 60, concurrency: 60, rps: 120 }
  ];
  baseConfig.name = 'stress-test';
  
  console.log('📈 Starting Stress Test (gradually increasing load)\n');
  const normalized = normalizeConfig({ ...args, _: ['run'], config: null });
  normalized.stages = baseConfig.stages.map(normalizeStage);
  normalized.durationSeconds = normalized.stages.reduce((sum, s) => sum + s.durationSeconds, 0);
  
  const { summary, results } = await runTest(normalized);
  return { summary, results };
}

// A/B Differential Load Testing
function computeAbDiff(summaryA, summaryB, options = {}) {
  const diffLatency = (valA, valB) => {
    const a = Number(valA || 0);
    const b = Number(valB || 0);
    const diff = b - a;
    const pct = a > 0 ? (diff / a) * 100 : 0;
    return { a, b, diff, pct };
  };

  const reqDelta = summaryB.totals.requests - summaryA.totals.requests;
  const rpsDelta = summaryB.totals.achievedRps - summaryA.totals.achievedRps;
  const errorRateA = summaryA.totals.errorRate * 100;
  const errorRateB = summaryB.totals.errorRate * 100;
  const errorRateDiff = errorRateB - errorRateA;

  const latencies = {
    avg: diffLatency(summaryA.latencyMs?.avg, summaryB.latencyMs?.avg),
    p50: diffLatency(summaryA.latencyMs?.p50, summaryB.latencyMs?.p50),
    p90: diffLatency(summaryA.latencyMs?.p90, summaryB.latencyMs?.p90),
    p95: diffLatency(summaryA.latencyMs?.p95, summaryB.latencyMs?.p95),
    p99: diffLatency(summaryA.latencyMs?.p99, summaryB.latencyMs?.p99),
  };

  const maxLatencyDiffPct = Number(options.maxLatencyDiff ?? 15);
  const maxErrorDiffPct = Number(options.maxErrorDiff ?? 0);

  const latencyRegressed = latencies.p95.pct > maxLatencyDiffPct || latencies.avg.pct > maxLatencyDiffPct;
  const errorRegressed = errorRateDiff > maxErrorDiffPct;
  const isRegression = latencyRegressed || errorRegressed;

  const avgDelta = latencies.avg.pct;
  const p95Delta = latencies.p95.pct;
  const p50Delta = latencies.p50.pct;

  let winner = 'similar';
  if ((p95Delta <= -5 || (avgDelta <= -10 && p50Delta <= -5)) && errorRateDiff <= 0) {
    winner = 'B';
  } else if (p95Delta >= 5 || (avgDelta >= 10 && p50Delta >= 5) || errorRateDiff > 0) {
    winner = 'A';
  }

  return {
    variantA: summaryA.testName || 'Variant A',
    variantB: summaryB.testName || 'Variant B',
    requests: { a: summaryA.totals.requests, b: summaryB.totals.requests, diff: reqDelta },
    rps: { a: summaryA.totals.achievedRps, b: summaryB.totals.achievedRps, diff: rpsDelta },
    errorRate: { a: errorRateA, b: errorRateB, diff: errorRateDiff },
    latencies,
    winner,
    isRegression,
    regressionReason: latencyRegressed 
      ? `Latency degraded in Variant B (avg: ${latencies.avg.pct.toFixed(1)}%, p95: ${latencies.p95.pct.toFixed(1)}% vs limit ${maxLatencyDiffPct}%)`
      : errorRegressed 
      ? `Error rate increased by ${errorRateDiff.toFixed(2)}% (limit ${maxErrorDiffPct}%)` 
      : null
  };
}

function printAbSummary(diff) {
  console.log(chalk.bold('\n============================================================'));
  console.log(chalk.bold('             📊 A/B DIFFERENTIAL COMPARISON RESULT          '));
  console.log(chalk.bold('============================================================'));
  
  const pad = (s, n) => String(s).padEnd(n);
  const padNum = (n, unit = '') => (typeof n === 'number' ? n.toFixed(2) : String(n)) + unit;

  console.log(`${chalk.bold(pad('Metric', 18))} ${chalk.cyan(pad('Variant A', 16))} ${chalk.cyan(pad('Variant B', 16))} ${chalk.bold('Delta / Winner')}`);
  console.log(chalk.gray('─'.repeat(65)));

  const printRow = (label, valA, valB, delta, pct, isLowerBetter = true, unit = '') => {
    const diffSign = delta > 0 ? `+${padNum(delta, unit)}` : `${padNum(delta, unit)}`;
    const pctSign = pct > 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
    let color = chalk.gray;
    let winnerIndicator = '(=)';

    if (Math.abs(pct) >= 2) {
      const bIsBetter = isLowerBetter ? delta < 0 : delta > 0;
      if (bIsBetter) {
        color = chalk.green;
        winnerIndicator = '🏆 (B is better)';
      } else {
        color = chalk.red;
        winnerIndicator = '⚠️ (A was better)';
      }
    }

    console.log(
      `${pad(label, 18)} ` +
      `${pad(padNum(valA, unit), 16)} ` +
      `${pad(padNum(valB, unit), 16)} ` +
      `${color(`${diffSign} (${pctSign}) ${winnerIndicator}`)}`
    );
  };

  printRow('Requests', diff.requests.a, diff.requests.b, diff.requests.diff, diff.requests.a ? (diff.requests.diff / diff.requests.a) * 100 : 0, false);
  printRow('Achieved RPS', diff.rps.a, diff.rps.b, diff.rps.diff, diff.rps.a ? (diff.rps.diff / diff.rps.a) * 100 : 0, false);
  printRow('Error Rate', diff.errorRate.a, diff.errorRate.b, diff.errorRate.diff, diff.errorRate.diff, true, '%');
  printRow('Avg Latency', diff.latencies.avg.a, diff.latencies.avg.b, diff.latencies.avg.diff, diff.latencies.avg.pct, true, 'ms');
  printRow('p50 Latency', diff.latencies.p50.a, diff.latencies.p50.b, diff.latencies.p50.diff, diff.latencies.p50.pct, true, 'ms');
  printRow('p90 Latency', diff.latencies.p90.a, diff.latencies.p90.b, diff.latencies.p90.diff, diff.latencies.p90.pct, true, 'ms');
  printRow('p95 Latency', diff.latencies.p95.a, diff.latencies.p95.b, diff.latencies.p95.diff, diff.latencies.p95.pct, true, 'ms');
  printRow('p99 Latency', diff.latencies.p99.a, diff.latencies.p99.b, diff.latencies.p99.diff, diff.latencies.p99.pct, true, 'ms');
  
  console.log(chalk.gray('─'.repeat(65)));
  if (diff.winner === 'B') {
    console.log(chalk.bold.green(`🏆 OVERALL WINNER: Variant B (faster with equal or better reliability)`));
  } else if (diff.winner === 'A') {
    console.log(chalk.bold.yellow(`🏆 OVERALL WINNER: Variant A (Variant B performed worse)`));
  } else {
    console.log(chalk.bold.cyan(`⚖️  OVERALL VERDICT: Performance is comparable within normal margins.`));
  }
}

function writeAbHtmlReport(filePath, diff, summaryA, summaryB) {
  ensureDirFor(filePath);
  const padNum = (n, u = '') => (typeof n === 'number' ? n.toFixed(2) : String(n)) + u;
  const pctSign = pct => (pct > 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`);

  const metrics = [
    { label: 'Achieved RPS', a: summaryA.totals.achievedRps, b: summaryB.totals.achievedRps, diff: diff.rps.diff, pct: summaryA.totals.achievedRps ? (diff.rps.diff / summaryA.totals.achievedRps) * 100 : 0, lower: false },
    { label: 'Error Rate', a: diff.errorRate.a, b: diff.errorRate.b, diff: diff.errorRate.diff, pct: diff.errorRate.diff, lower: true, unit: '%' },
    { label: 'Avg Latency', a: diff.latencies.avg.a, b: diff.latencies.avg.b, diff: diff.latencies.avg.diff, pct: diff.latencies.avg.pct, lower: true, unit: 'ms' },
    { label: 'p50 Latency', a: diff.latencies.p50.a, b: diff.latencies.p50.b, diff: diff.latencies.p50.diff, pct: diff.latencies.p50.pct, lower: true, unit: 'ms' },
    { label: 'p90 Latency', a: diff.latencies.p90.a, b: diff.latencies.p90.b, diff: diff.latencies.p90.diff, pct: diff.latencies.p90.pct, lower: true, unit: 'ms' },
    { label: 'p95 Latency', a: diff.latencies.p95.a, b: diff.latencies.p95.b, diff: diff.latencies.p95.diff, pct: diff.latencies.p95.pct, lower: true, unit: 'ms' },
    { label: 'p99 Latency', a: diff.latencies.p99.a, b: diff.latencies.p99.b, diff: diff.latencies.p99.diff, pct: diff.latencies.p99.pct, lower: true, unit: 'ms' },
  ];

  const rows = metrics.map(m => {
    const isBetter = m.lower ? m.diff < 0 : m.diff > 0;
    const isNeutral = Math.abs(m.pct) < 1;
    const cls = isNeutral ? 'neutral' : isBetter ? 'pass' : 'fail';
    const sign = m.diff > 0 ? '+' : '';
    return `<tr>
      <td>${htmlEscape(m.label)}</td>
      <td>${padNum(m.a, m.unit)}</td>
      <td>${padNum(m.b, m.unit)}</td>
      <td class="${cls}">${sign}${padNum(m.diff, m.unit)} (${pctSign(m.pct)})</td>
    </tr>`;
  }).join('');

  const verdictBadge = diff.winner === 'B' 
    ? '<span class="badge pass">🏆 Variant B is Faster</span>' 
    : diff.winner === 'A' 
    ? '<span class="badge fail">⚠️ Variant A was Faster</span>' 
    : '<span class="badge neutral">⚖️ Comparable Performance</span>';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Safe Load Lab - A/B Test Report</title><style>
    body{font-family:Inter,system-ui,Segoe UI,Arial,sans-serif;margin:0;background:#0f172a;color:#e5e7eb}main{max-width:1100px;margin:0 auto;padding:32px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:20px 0}.card{background:#111827;border:1px solid #334155;border-radius:14px;padding:20px;box-shadow:0 8px 24px #0004}.metric{font-size:26px;font-weight:800;color:#93c5fd}.label{color:#94a3b8;font-size:13px;margin-top:4px}table{width:100%;border-collapse:collapse;margin:20px 0;background:#111827;border-radius:12px;overflow:hidden}th,td{padding:12px 16px;border-bottom:1px solid #334155;text-align:left}th{background:#1e293b;color:#bfdbfe}.pass{color:#86efac;font-weight:700}.fail{color:#fca5a5;font-weight:700}.neutral{color:#94a3b8}.badge{display:inline-block;padding:6px 14px;border-radius:999px;font-size:15px;font-weight:700;margin-top:10px}h1,h2{color:white}.muted{color:#94a3b8}</style></head><body><main>
    <h1>⚖️ Safe Load Lab - A/B Differential Report</h1>
    <p class="muted">Variant A: <b>${htmlEscape(diff.variantA)}</b> vs Variant B: <b>${htmlEscape(diff.variantB)}</b></p>
    <div>${verdictBadge}</div>
    <section class="grid">
      <div class="card"><div class="metric">${summaryA.totals.requests} vs ${summaryB.totals.requests}</div><div class="label">Total Requests (A vs B)</div></div>
      <div class="card"><div class="metric">${summaryA.totals.achievedRps.toFixed(1)} → ${summaryB.totals.achievedRps.toFixed(1)}</div><div class="label">Achieved RPS</div></div>
      <div class="card"><div class="metric">${summaryA.latencyMs.p95.toFixed(1)}ms → ${summaryB.latencyMs.p95.toFixed(1)}ms</div><div class="label">p95 Latency</div></div>
      <div class="card"><div class="metric">${(summaryA.totals.errorRate*100).toFixed(1)}% vs ${(summaryB.totals.errorRate*100).toFixed(1)}%</div><div class="label">Error Rate</div></div>
    </section>
    <h2>Differential Metrics</h2>
    <table><thead><tr><th>Metric</th><th>Variant A</th><th>Variant B</th><th>Delta</th></tr></thead><tbody>${rows}</tbody></table>
    </main></body></html>`;
  fs.writeFileSync(filePath, html);
}

function generateAbMarkdownReport(diff, summaryA, summaryB) {
  const padNum = (n, u = '') => (typeof n === 'number' ? n.toFixed(2) : String(n)) + u;
  const pctSign = pct => (pct > 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`);

  const verdict = diff.winner === 'B' 
    ? '🏆 **Variant B is the WINNER** (faster with equal or better reliability)' 
    : diff.winner === 'A' 
    ? '⚠️ **Variant A was FASTER** (Variant B showed performance regression)' 
    : '⚖️ **Comparable Performance** (no significant performance delta)';

  return `# ⚖️ A/B Differential Load Test Report

**Variant A**: ${summaryA.testName}  
**Variant B**: ${summaryB.testName}  
**Date**: ${new Date().toISOString()}  

### Overall Verdict
${verdict}

${diff.isRegression ? `> ❌ **Regression Warning**: ${diff.regressionReason}\n` : ''}

## Metric Comparison

| Metric | Variant A | Variant B | Difference | % Delta |
|--------|-----------|-----------|------------|---------|
| Total Requests | ${summaryA.totals.requests} | ${summaryB.totals.requests} | ${diff.requests.diff > 0 ? '+' : ''}${diff.requests.diff} | ${pctSign(summaryA.totals.requests ? (diff.requests.diff / summaryA.totals.requests) * 100 : 0)} |
| Achieved RPS | ${summaryA.totals.achievedRps.toFixed(2)} | ${summaryB.totals.achievedRps.toFixed(2)} | ${diff.rps.diff > 0 ? '+' : ''}${diff.rps.diff.toFixed(2)} | ${pctSign(summaryA.totals.achievedRps ? (diff.rps.diff / summaryA.totals.achievedRps) * 100 : 0)} |
| Error Rate | ${(summaryA.totals.errorRate * 100).toFixed(2)}% | ${(summaryB.totals.errorRate * 100).toFixed(2)}% | ${diff.errorRate.diff > 0 ? '+' : ''}${diff.errorRate.diff.toFixed(2)}% | — |
| Avg Latency | ${summaryA.latencyMs.avg.toFixed(2)}ms | ${summaryB.latencyMs.avg.toFixed(2)}ms | ${diff.latencies.avg.diff > 0 ? '+' : ''}${diff.latencies.avg.diff.toFixed(2)}ms | ${pctSign(diff.latencies.avg.pct)} |
| Median (p50) | ${summaryA.latencyMs.p50.toFixed(2)}ms | ${summaryB.latencyMs.p50.toFixed(2)}ms | ${diff.latencies.p50.diff > 0 ? '+' : ''}${diff.latencies.p50.diff.toFixed(2)}ms | ${pctSign(diff.latencies.p50.pct)} |
| p90 Latency | ${summaryA.latencyMs.p90.toFixed(2)}ms | ${summaryB.latencyMs.p90.toFixed(2)}ms | ${diff.latencies.p90.diff > 0 ? '+' : ''}${diff.latencies.p90.diff.toFixed(2)}ms | ${pctSign(diff.latencies.p90.pct)} |
| p95 Latency | ${summaryA.latencyMs.p95.toFixed(2)}ms | ${summaryB.latencyMs.p95.toFixed(2)}ms | ${diff.latencies.p95.diff > 0 ? '+' : ''}${diff.latencies.p95.diff.toFixed(2)}ms | ${pctSign(diff.latencies.p95.pct)} |
| p99 Latency | ${summaryA.latencyMs.p99.toFixed(2)}ms | ${summaryB.latencyMs.p99.toFixed(2)}ms | ${diff.latencies.p99.diff > 0 ? '+' : ''}${diff.latencies.p99.diff.toFixed(2)}ms | ${pctSign(diff.latencies.p99.pct)} |

---
*Generated by Safe Load Lab v${VERSION}*
`;
}

function writeAbMarkdownReport(filePath, diff, summaryA, summaryB) {
  ensureDirFor(filePath);
  const md = generateAbMarkdownReport(diff, summaryA, summaryB);
  fs.writeFileSync(filePath, md);
}

async function runAbTest(args) {
  let configA, configB;

  if (args['config-a'] && args['config-b']) {
    configA = JSON.parse(fs.readFileSync(args['config-a'], 'utf8'));
    configB = JSON.parse(fs.readFileSync(args['config-b'], 'utf8'));
  } else if (args.config && (args['env-a'] || args['env-b'])) {
    const base = JSON.parse(fs.readFileSync(args.config, 'utf8'));
    if (!args['env-a'] || !args['env-b']) throw new Error('A/B test with --config requires both --env-a and --env-b');
    configA = mergeDeep(base, base.environments?.[args['env-a']] || {});
    configA.name = `${base.name || 'test'} [${args['env-a']}]`;
    configB = mergeDeep(base, base.environments?.[args['env-b']] || {});
    configB.name = `${base.name || 'test'} [${args['env-b']}]`;
  } else if (args['url-a'] && args['url-b']) {
    configA = {
      name: 'Variant-A',
      endpoints: [{ name: 'Endpoint-A', url: args['url-a'], method: args.method || 'GET', headers: parseHeaders(args.header), body: args.body, weight: 1 }]
    };
    configB = {
      name: 'Variant-B',
      endpoints: [{ name: 'Endpoint-B', url: args['url-b'], method: args.method || 'GET', headers: parseHeaders(args.header), body: args.body, weight: 1 }]
    };
  } else {
    throw new Error('A/B test requires --url-a and --url-b, OR --config-a and --config-b, OR --config with --env-a and --env-b');
  }

  configA = applyCliOverrides(configA, args);
  configB = applyCliOverrides(configB, args);
  
  const normA = normalizeConfig({ ...args, config: null, url: null, curl: null, ...configA });
  normA.name = configA.name || 'Variant-A';
  
  const normB = normalizeConfig({ ...args, config: null, url: null, curl: null, ...configB });
  normB.name = configB.name || 'Variant-B';

  console.log(chalk.bold.magenta('\n============================================================'));
  console.log(chalk.bold.magenta('           ⚖️  SAFE LOAD LAB — A/B DIFFERENTIAL TEST         '));
  console.log(chalk.bold.magenta('============================================================\n'));
  console.log(`Variant A: ${chalk.cyan(normA.name)} (${normA.endpoints.map(e => e.url).join(', ')})`);
  console.log(`Variant B: ${chalk.cyan(normB.name)} (${normB.endpoints.map(e => e.url).join(', ')})`);
  console.log(`Duration:  ${normA.durationSeconds}s each | Concurrency: ${normA.concurrency} | Target RPS: ${normA.rps}\n`);

  console.log(chalk.bold.blue('─── Phase 1/2: Testing Variant A ───────────────────────────'));
  const runA = await runTest(normA);
  printSummary(runA.summary);

  console.log(chalk.bold.blue('\n─── Phase 2/2: Testing Variant B ───────────────────────────'));
  const runB = await runTest(normB);
  printSummary(runB.summary);

  const diff = computeAbDiff(runA.summary, runB.summary, {
    maxLatencyDiff: args['max-latency-diff'],
    maxErrorDiff: args['max-error-diff']
  });

  printAbSummary(diff);

  const defaultOut = `reports/ab-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const out = args.out || defaultOut;
  ensureDirFor(out);
  fs.writeFileSync(out, JSON.stringify({ diff, variantA: runA, variantB: runB }, null, 2));
  console.log(chalk.green(`\n✓ A/B JSON report saved: ${out}`));

  if (args.html) {
    writeAbHtmlReport(args.html, diff, runA.summary, runB.summary);
    console.log(chalk.green(`✓ A/B HTML report saved: ${args.html}`));
  }
  if (args.markdown || args.md) {
    const mdPath = args.markdown || args.md;
    writeAbMarkdownReport(mdPath, diff, runA.summary, runB.summary);
    console.log(chalk.green(`✓ A/B Markdown report saved: ${mdPath}`));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const summaryMd = generateAbMarkdownReport(diff, runA.summary, runB.summary);
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n' + summaryMd + '\n');
    } catch (_) {}
  }

  if (diff.isRegression) {
    console.log(chalk.bold.red(`\n❌ PERFORMANCE REGRESSION DETECTED: ${diff.regressionReason}`));
  } else {
    console.log(chalk.bold.green(`\n✅ A/B Test Passed: No performance regressions detected.`));
  }

  return { diff, runA, runB };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  
  // Enable debug mode
  if (args.debug || args.verbose) {
    process.env.DEBUG = 'true';
    process.env.VERBOSE = 'true';
  }
  
  const command = args._[0] || 'help';
  if (command === 'help' || args.help) { printHelp(); return; }
  if (command === 'version' || args.version) { console.log(VERSION); return; }
  if (command === 'sample') { createSample(args.out || 'load-test.json'); return; }
  if (command === 'validate') { validateConfigCommand(args); return; }
  if (command === 'plan') { printPlan(normalizeConfig(args)); return; }
  if (command === 'compare') {
    if (!args._[1] || !args._[2]) throw new Error('compare requires two report files: compare <file1> <file2>');
    compareReports(args._[1], args._[2]);
    return;
  }
  if (command === 'mock') {
    const port = Number(args.port || 8080);
    const host = args.host || '127.0.0.1';
    const server = startMockServer(port, host);
    console.log(chalk.bold.green(`✓ Safe Load Lab Mock Server running on http://${host}:${port}`));
    console.log(chalk.gray('  Hermetic test routes ready for zero-flake load testing:'));
    console.log(`  - ${chalk.cyan('GET')}  http://${host}:${port}/health`);
    console.log(`  - ${chalk.cyan('GET')}  http://${host}:${port}/fast`);
    console.log(`  - ${chalk.cyan('GET')}  http://${host}:${port}/slow?delay=100`);
    console.log(`  - ${chalk.cyan('GET')}  http://${host}:${port}/error?status=500`);
    console.log(`  - ${chalk.cyan('GET')}  http://${host}:${port}/rate-limit?limit=10&window=5`);
    console.log(`  - ${chalk.cyan('GET')}  http://${host}:${port}/json`);
    console.log(`  - ${chalk.cyan('POST')} http://${host}:${port}/echo`);
    console.log(chalk.gray('\nPress Ctrl+C to stop.\n'));
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nStopping mock server...'));
      server.close(() => process.exit(0));
    });
    return;
  }
  if (command === 'import-curl') {
    const curlStr = args._.slice(1).join(' ') || args.curl;
    if (!curlStr) throw new Error('import-curl requires a curl command string');
    const ep = parseCurlCommand(curlStr);
    const configOut = {
      name: ep.name,
      durationSeconds: Number(args.duration || 30),
      concurrency: Number(args.concurrency || 5),
      rps: Number(args.rps || 10),
      timeoutMs: Number(args.timeout || 10000),
      endpoints: [ep]
    };
    if (args.out) {
      ensureDirFor(args.out);
      fs.writeFileSync(args.out, JSON.stringify(configOut, null, 2));
      console.log(chalk.green(`✓ Saved generated config to ${args.out}`));
    } else {
      console.log(JSON.stringify(configOut, null, 2));
    }
    return;
  }
  if (!args['i-own-this-target']) throw new Error('Missing required safety flag: --i-own-this-target');
  if (command === 'ab' || command === 'diff') {
    const { diff } = await runAbTest(args);
    if (diff.isRegression) process.exitCode = 2;
    return;
  }
  if (command === 'rate-limit') { await runRateLimitCheck(args); return; }
  if (command === 'spike') {
    const { summary, results } = await runSpikeTest(args);
    printSummary(summary);
    await saveReports(args, summary, results);
    return;
  }
  if (command === 'soak') {
    const { summary, results } = await runSoakTest(args);
    printSummary(summary);
    await saveReports(args, summary, results);
    return;
  }
  if (command === 'stress') {
    const { summary, results } = await runStressTest(args);
    printSummary(summary);
    await saveReports(args, summary, results);
    return;
  }
  if (command !== 'run') throw new Error(`Unknown command: ${command}`);
  const config = normalizeConfig(args);
  const { summary, results } = await runTest(config);
  printSummary(summary);
  await saveReports(args, summary, results);
  if (Object.values(summary.thresholds || {}).some(v => !v.pass)) process.exitCode = 2;
}

async function saveReports(args, summary, results) {
  const defaultOut = `reports/report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const out = args.out || defaultOut;
  ensureDirFor(out);
  fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
  console.log(chalk.green(`\n✓ JSON report saved: ${out}`));
  if (args.csv) { writeCsv(args.csv, results); console.log(chalk.green(`✓ CSV report saved: ${args.csv}`)); }
  if (args.html) { writeHtmlReport(args.html, summary, results); console.log(chalk.green(`✓ HTML report saved: ${args.html}`)); }
  if (args.junit) { writeJunitReport(args.junit, summary); console.log(chalk.green(`✓ JUnit report saved: ${args.junit}`)); }
  if (args.markdown || args.md) { 
    const mdPath = args.markdown || args.md;
    writeMarkdownReport(mdPath, summary); 
    console.log(chalk.green(`✓ Markdown report saved: ${mdPath}`)); 
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const summaryMd = generateMarkdownReport(summary);
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n' + summaryMd + '\n');
    } catch (_) {}
  }
  
  // Save failure logs if there are failures
  if (summary.totals.failed > 0 || (summary.assertionFailures && Object.keys(summary.assertionFailures).length > 0)) {
    const failureDir = args.failureDir || 'reports/failures';
    saveFailureLogs(results, failureDir);
  }
  
  if (args.webhook) await sendWebhook(args.webhook, summary);
  if (args.slack) await sendSlackNotification(args.slack, summary);
  if (args.compare) {
    console.log('\n');
    compareReports(args.compare, out);
  }
}

const isMain = Boolean(process.argv[1] && (
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
  process.argv[1].endsWith('sll') ||
  process.argv[1].endsWith('sll.js') ||
  process.argv[1].endsWith('safe-load-lab') ||
  process.argv[1].endsWith('safe-load-lab.js')
));

if (isMain) {
  main().catch(err => { console.error(`Error: ${err.message}`); process.exit(1); });
}

export {
  VERSION,
  HARD_LIMITS,
  startMockServer,
  parseCurlCommand,
  computeAbDiff,
  printAbSummary,
  writeAbHtmlReport,
  generateMarkdownReport,
  writeMarkdownReport,
  generateAbMarkdownReport,
  writeAbMarkdownReport,
  runAbTest,
  normalizeConfig,
  runTest,
  calculatePercentiles,
  percentile,
  getByPath,
  setByPath,
  renderTemplate,
  pickEndpoint,
  evaluateAssertions,
  evaluateThresholds,
  parseHeaders,
  parseArgs
};

