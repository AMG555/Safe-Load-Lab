#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import chalk from 'chalk';
import cliProgress from 'cli-progress';

const VERSION = '2.3.0';

const BASE_LIMITS = {
  maxDurationSeconds: 600,
  maxConcurrency: 100,
  maxRps: 200,
  maxBodyBytes: 1024 * 1024
};

const UNLOCKED_LIMITS = {
  maxDurationSeconds: 86400,
  maxConcurrency: 2000,
  maxRps: 10000,
  maxBodyBytes: 10 * 1024 * 1024
};

let HARD_LIMITS = { ...BASE_LIMITS };

function setHighCapacityMode(enabled = true) {
  if (enabled) {
    HARD_LIMITS = { ...UNLOCKED_LIMITS };
  } else {
    HARD_LIMITS = { ...BASE_LIMITS };
  }
}

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
  bench, quick    Run quick zero-config benchmark on single endpoint
  run             Run a controlled load test
  capacity, break Autonomous capacity discovery: step load until latency knee or breaking point
  probe, ping     Send single preflight probe to verify target status, latency, & assertions
  ci              Generate CI/CD pipeline workflow (GitHub Actions or GitLab CI)
  ui, studio      Start Safe Load Lab Web UI Studio locally
  ab, diff        Run A/B differential load test comparing two endpoints or configs
  mock            Start hermetic local mock server for zero-flake load testing
  import-curl     Convert cURL command string to Safe Load Lab test config
  import-postman  Convert Postman Collection JSON to Safe Load Lab test config
  import-openapi  Convert OpenAPI/Swagger JSON to Safe Load Lab test config
  import-har      Convert browser HAR (HTTP Archive) recording to Safe Load Lab test config
  export-k6       Export Safe Load Lab config to modern k6 JS script
  export-postman  Export Safe Load Lab config to Postman Collection v2.1
  validate        Validate and normalize a config without sending traffic
  plan            Show resolved test plan without sending traffic
  sample          Create a sample config file
  rate-limit      Safe rate-limit verification for owned endpoints
  compare         Compare two test reports
  spike           Run a spike test (sudden traffic increase)
  soak            Run a soak test (sustained load over time)
  stress          Run a stress test (gradually increasing load)
  version         Show version
  help            Show help

Required safety flag for run/bench/quick/ab/capacity/rate-limit/spike/soak/stress:
  --i-own-this-target       Confirms you own or have explicit permission to test the target

Common options:
  --config <file>           JSON config file
  --url <url>               Target URL for simple one-endpoint test
  --curl "<command>"        Directly run load test from a cURL command string
  --method <GET|POST|...>   HTTP method, default GET
  --body <json/string>      Request body for simple test
  --header "K: V"           Header, repeatable
  --waveform <type>         Traffic shaping waveform: sine (diurnal), ladder (step ramp), burst (Poisson)
  --sla <ms>                Target p95 latency SLA limit in ms for capacity discovery (default 200)
  --data <file>             CSV data feed file for parameterization ({{data.column}})
  --data-mode <mode>        Data selection: round-robin (default) or random
  --include-assets          Include static assets (css, images, fonts) when importing HAR
  --unlock-limits           Unlock safety caps for high-capacity stress testing (up to 24h, 2000c, 10k RPS)
  --high-capacity           Alias for --unlock-limits
  --duration <seconds>      Test duration, max ${HARD_LIMITS.maxDurationSeconds}, default 30
  --concurrency <number>    Max concurrent workers, max ${HARD_LIMITS.maxConcurrency}, default 5
  --rps <number>            Max requests per second, max ${HARD_LIMITS.maxRps}, default 10
  --timeout <ms>            Request timeout, default 10000
  --jitter <ms>             Add random delay jitter (0-ms) for realistic distribution
  --env-file <file>         Load environment variables from .env file (default .env if exists)
  --out <file>              Save JSON report, default reports/report-<timestamp>.json
  --csv <file>              Save per-request CSV
  --html <file>             Save standalone HTML report
  --markdown <file>         Save markdown format report
  --md <file>               Alias for --markdown
  --junit <file>            Save JUnit XML summary for CI
  --prometheus <file>       Save OpenMetrics / Prometheus exposition text report
  --badge <file>            Save SVG status & latency badge for README
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
  sll bench http://localhost:8080/fast --i-own-this-target
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
    if (['i-own-this-target', 'include-assets', 'realistic', 'verbose', 'debug', 'unlock-limits', 'high-capacity'].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) { args[key] = true; continue; }
    i++;
    if (key === 'header') { args.header = args.header || []; args.header.push(value); }
    else args[key] = value;
  }
  if (args['unlock-limits'] || args['high-capacity']) {
    setHighCapacityMode(true);
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

function loadEnvFile(filePath = '.env') {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
  return env;
}

function parseCsvData(content) {
  if (!content || typeof content !== 'string') return [];
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length < 2) return [];

  const firstLine = lines[0];
  let delimiter = ',';
  if (firstLine.includes('\t')) delimiter = '\t';
  else if (firstLine.includes(';') && !firstLine.includes(',')) delimiter = ';';

  function parseLine(line) {
    const row = [];
    let inQuotes = false;
    let cur = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === delimiter && !inQuotes) {
        row.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    row.push(cur.trim());
    return row;
  }

  const rawHeaders = parseLine(lines[0]);
  const headers = rawHeaders.map(h => h.replace(/^["']|["']$/g, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      let val = values[j] ?? '';
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      obj[headers[j]] = val;
    }
    rows.push(obj);
  }
  return rows;
}

function resolveDynamicGenerator(key) {
  if (key === '$uuid' || key === '$guid') {
    return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
  }
  if (key === '$timestamp') {
    return String(Date.now());
  }
  if (key === '$isoDate') {
    return new Date().toISOString();
  }
  if (key === '$randomEmail') {
    return `user_${Math.random().toString(36).slice(2, 8)}@example.com`;
  }
  if (key.startsWith('$randomInt')) {
    const parts = key.split(':');
    const min = parts[1] !== undefined ? parseInt(parts[1], 10) : 1;
    const max = parts[2] !== undefined ? parseInt(parts[2], 10) : 1000;
    return String(Math.floor(Math.random() * (max - min + 1)) + min);
  }
  if (key.startsWith('$randomAlpha') || key.startsWith('$randomString')) {
    const parts = key.split(':');
    const len = parts[1] !== undefined ? parseInt(parts[1], 10) : 8;
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let str = '';
    for (let i = 0; i < len; i++) str += chars[Math.floor(Math.random() * chars.length)];
    return str;
  }
  if (key === '$randomIp') {
    return `${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;
  }
  return null;
}

function computeLatencyDistribution(durations) {
  const bucketDefs = [
    { label: '<10ms', min: 0, max: 10 },
    { label: '10-25ms', min: 10, max: 25 },
    { label: '25-50ms', min: 25, max: 50 },
    { label: '50-100ms', min: 50, max: 100 },
    { label: '100-250ms', min: 100, max: 250 },
    { label: '250-500ms', min: 250, max: 500 },
    { label: '500ms-1s', min: 500, max: 1000 },
    { label: '>1s', min: 1000, max: Infinity }
  ];

  if (!Array.isArray(durations) || durations.length === 0) {
    const emptyAnomalies = [];
    emptyAnomalies.tailDivergence = false;
    emptyAnomalies.bimodal = false;
    emptyAnomalies.tailRatio = 1;
    return {
      buckets: bucketDefs.map(b => ({ label: b.label, count: 0, percentage: 0, pct: 0 })),
      anomalies: emptyAnomalies
    };
  }

  const buckets = bucketDefs.map(b => ({ label: b.label, count: 0, percentage: 0, pct: 0 }));
  for (const d of durations) {
    if (!Number.isFinite(d)) continue;
    for (let i = 0; i < bucketDefs.length; i++) {
      if (d >= bucketDefs[i].min && d < bucketDefs[i].max) {
        buckets[i].count++;
        break;
      }
    }
  }

  const total = durations.length || 1;
  for (const b of buckets) {
    b.percentage = Number(((b.count / total) * 100).toFixed(1));
    b.pct = b.percentage;
  }

  const anomalies = [];
  const percentiles = calculatePercentiles(durations, [50, 90, 99]);
  const tailRatio = percentiles[50] > 0 ? Number((percentiles[99] / percentiles[50]).toFixed(2)) : 1;
  const isTailDivergent = percentiles[50] > 0 && tailRatio >= 3.5;

  if (isTailDivergent) {
    anomalies.push({
      type: 'TAIL_DIVERGENCE',
      severity: 'warning',
      message: `High tail latency divergence (p99 ${percentiles[99].toFixed(1)}ms is ${tailRatio.toFixed(1)}x median ${percentiles[50].toFixed(1)}ms). Possible lock contention or GC pauses.`
    });
  }

  const populated = buckets.map(b => b.count);
  let peaks = 0;
  for (let i = 1; i < populated.length - 1; i++) {
    if (populated[i] > populated[i - 1] && populated[i] > populated[i + 1] && populated[i] >= total * 0.05) {
      peaks++;
    }
  }
  if (peaks < 2 && populated[0] >= total * 0.15 && (populated[4] + populated[5] + populated[6] >= total * 0.15) && (populated[2] + populated[3] <= total * 0.1)) {
    peaks = 2;
  }
  const isBimodal = peaks >= 2;
  if (isBimodal) {
    anomalies.push({
      type: 'BIMODAL_DISTRIBUTION',
      severity: 'warning',
      message: 'Bimodal/multimodal latency pattern detected. Indicates two distinct service paths, cold cache hits, or connection pool wait.'
    });
  }

  anomalies.tailDivergence = isTailDivergent;
  anomalies.bimodal = isBimodal;
  anomalies.tailRatio = tailRatio;

  return { buckets, anomalies };
}

function generateTrafficProfile(waveform, options = {}) {
  const baseRps = Math.max(1, Number(options.baseRps || options.rps || 10));
  const peakRps = Math.max(baseRps, Number(options.peakRps || baseRps * 4));
  const duration = Math.max(2, Number(options.durationSeconds || options.duration || 60));
  const concurrency = Math.max(1, Number(options.concurrency || 5));

  const stages = [];
  const wave = String(waveform || '').toLowerCase();

  if (wave === 'sine' || wave === 'wave') {
    const numStages = 6;
    const stageDuration = Math.max(1, Math.floor(duration / numStages));
    for (let i = 0; i < numStages; i++) {
      const angle = (i / (numStages - 1)) * Math.PI;
      const factor = Math.sin(angle);
      const rps = Math.round(baseRps + factor * (peakRps - baseRps));
      const c = Math.max(1, Math.round(concurrency * (rps / baseRps)));
      const capRps = Math.min(rps, HARD_LIMITS.maxRps);
      stages.push({
        name: `sine-stage-${i + 1}`,
        durationSeconds: stageDuration,
        concurrency: Math.min(c, HARD_LIMITS.maxConcurrency),
        rps: capRps,
        targetRps: capRps
      });
    }
  } else if (wave === 'ladder' || wave === 'step') {
    const steps = [
      { pct: 0.25, name: 'step-warmup' },
      { pct: 0.50, name: 'step-low' },
      { pct: 0.75, name: 'step-medium' },
      { pct: 1.00, name: 'step-peak' },
      { pct: 0.50, name: 'step-cooldown' }
    ];
    const stageDuration = Math.max(1, Math.floor(duration / steps.length));
    for (const s of steps) {
      const rps = Math.round(baseRps + s.pct * (peakRps - baseRps));
      const c = Math.max(1, Math.round(concurrency * (rps / baseRps)));
      const capRps = Math.min(rps, HARD_LIMITS.maxRps);
      stages.push({
        name: s.name,
        durationSeconds: stageDuration,
        concurrency: Math.min(c, HARD_LIMITS.maxConcurrency),
        rps: capRps,
        targetRps: capRps
      });
    }
  } else if (wave === 'burst') {
    const numCycles = 3;
    const cycleDuration = Math.max(2, Math.floor(duration / numCycles));
    const burstDuration = Math.max(1, Math.floor(cycleDuration * 0.25));
    const baseDuration = Math.max(1, cycleDuration - burstDuration);

    for (let i = 0; i < numCycles; i++) {
      stages.push({
        name: `steady-${i + 1}`,
        durationSeconds: baseDuration,
        concurrency: concurrency,
        rps: baseRps,
        targetRps: baseRps
      });
      const capPeak = Math.min(peakRps, HARD_LIMITS.maxRps);
      stages.push({
        name: `burst-${i + 1}`,
        durationSeconds: burstDuration,
        concurrency: Math.min(concurrency * 3, HARD_LIMITS.maxConcurrency),
        rps: capPeak,
        targetRps: capPeak
      });
    }
  } else if (wave === 'constant' || !wave) {
    stages.push({
      name: 'constant-load',
      durationSeconds: duration,
      concurrency,
      rps: baseRps,
      targetRps: baseRps
    });
  } else {
    throw new Error(`Unknown waveform '${waveform}'. Supported: constant, sine, ladder, burst`);
  }

  stages.waveform = wave || 'constant';
  stages.stages = stages;
  return stages;
}

function renderTemplate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([$\w.:-]+)\s*\}\}/g, (_, key) => {
      if (key.startsWith('$')) {
        const dynamicVal = resolveDynamicGenerator(key);
        if (dynamicVal !== null) return dynamicVal;
      }
      const v = getByPath(vars, key) ?? process.env[key];
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
  const hasCliDuration = args.duration !== undefined;
  const hasCliConcurrency = args.concurrency !== undefined && args.concurrency !== config.concurrency;
  const hasCliRps = args.rps !== undefined && args.rps !== config.rps;
  const hasCliTimeout = args.timeout !== undefined;

  const loadShapeOverridden = hasCliDuration || hasCliConcurrency || hasCliRps;
  if (loadShapeOverridden) config.stages = undefined;
  if (hasCliDuration) config.durationSeconds = args.duration;
  if (args.concurrency !== undefined) config.concurrency = args.concurrency;
  if (args.rps !== undefined) config.rps = args.rps;
  if (hasCliTimeout) config.timeoutMs = args.timeout;
  if (args.thresholds && !config.thresholds) config.thresholds = args.thresholds;

  const waveform = args.waveform || config.waveform;
  if (waveform) {
    config.stages = generateTrafficProfile(waveform, {
      ...config,
      durationSeconds: args.duration || config.durationSeconds || 60,
      concurrency: args.concurrency || config.concurrency || 5,
      rps: args.rps || config.rps || 10,
      baseRps: args['base-rps'] || config.baseRps,
      peakRps: args['peak-rps'] || config.peakRps
    });
  }

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

function parsePostmanCollection(content, options = {}) {
  const collection = typeof content === 'string' ? JSON.parse(content) : content;
  if (!collection.item && !collection.items) throw new Error('Invalid Postman Collection: missing item array');

  function extractItems(items, out = []) {
    for (const it of items || []) {
      if (it.item) extractItems(it.item, out);
      else if (it.request) out.push(it);
    }
    return out;
  }

  const rawItems = extractItems(collection.item || collection.items);
  if (!rawItems.length) throw new Error('No valid requests found in Postman Collection');

  const endpoints = rawItems.map((it, idx) => {
    let url = '';
    if (typeof it.request.url === 'string') {
      url = it.request.url;
    } else if (it.request.url?.raw) {
      url = it.request.url.raw;
    } else if (Array.isArray(it.request.url?.path)) {
      const host = Array.isArray(it.request.url?.host) ? it.request.url.host.join('.') : (it.request.url?.host || 'localhost');
      const proto = it.request.url?.protocol || 'http';
      url = `${proto}://${host}/${it.request.url.path.join('/')}`;
    }

    const method = (it.request.method || 'GET').toUpperCase();
    const headers = {};
    for (const h of it.request.header || []) {
      if (h.key && !h.disabled) headers[h.key] = h.value || '';
    }

    let body = null;
    if (it.request.body?.raw) {
      body = it.request.body.raw;
    } else if (it.request.body?.urlencoded) {
      body = it.request.body.urlencoded.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
      headers['Content-Type'] ||= 'application/x-www-form-urlencoded';
    }

    return {
      name: it.name || `request-${idx + 1}`,
      url: url || 'http://localhost:8080',
      method,
      headers,
      body,
      weight: 1
    };
  });

  return {
    name: collection.info?.name ? collection.info.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-') : 'postman-load-test',
    durationSeconds: Number(options.duration || 30),
    concurrency: Number(options.concurrency || 5),
    rps: Number(options.rps || 10),
    timeoutMs: Number(options.timeout || 10000),
    endpoints
  };
}

function parseOpenApiSpec(content, options = {}) {
  const spec = typeof content === 'string' ? JSON.parse(content) : content;
  if (!spec.paths) throw new Error('Invalid OpenAPI/Swagger spec: missing paths');

  let baseUrl = options.baseUrl || '';
  if (!baseUrl) {
    if (Array.isArray(spec.servers) && spec.servers[0]?.url) {
      baseUrl = spec.servers[0].url;
    } else if (spec.host) {
      const proto = (spec.schemes && spec.schemes[0]) || 'http';
      baseUrl = `${proto}://${spec.host}${spec.basePath || ''}`;
    } else {
      baseUrl = 'http://localhost:8080';
    }
  }
  baseUrl = baseUrl.replace(/\/$/, '');

  const endpoints = [];
  const validMethods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

  for (const [routePath, pathItem] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(pathItem)) {
      if (!validMethods.includes(method.toLowerCase()) || !op || typeof op !== 'object') continue;

      const normalizedPath = routePath.replace(/\{([^}]+)\}/g, '1');
      const url = `${baseUrl}${normalizedPath.startsWith('/') ? '' : '/'}${normalizedPath}`;
      const headers = {};

      let body = null;
      if (op.requestBody?.content?.['application/json']) {
        headers['Content-Type'] = 'application/json';
        body = '{}';
      }

      endpoints.push({
        name: op.summary || op.operationId || `${method.toUpperCase()} ${routePath}`,
        url,
        method: method.toUpperCase(),
        headers,
        body,
        weight: 1
      });
    }
  }

  if (!endpoints.length) throw new Error('No HTTP endpoints found in OpenAPI specification');

  return {
    name: spec.info?.title ? `${spec.info.title.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-load-test` : 'openapi-load-test',
    durationSeconds: Number(options.duration || 30),
    concurrency: Number(options.concurrency || 5),
    rps: Number(options.rps || 10),
    timeoutMs: Number(options.timeout || 10000),
    endpoints
  };
}

function parseHarRecording(content, options = {}) {
  const har = typeof content === 'string' ? JSON.parse(content) : content;
  const entries = har.log?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Invalid HAR recording: missing log.entries array');
  }

  const excludeAssets = options.includeAssets !== true && options['include-assets'] !== true;
  const assetRegex = /\.(css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|webp|avif|mp4|webm)(\?.*)?$/i;
  const skipHeaders = new Set(['host', 'content-length', 'connection', 'cookie', ':method', ':scheme', ':authority', ':path']);

  const endpoints = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const req = entry.request;
    if (!req || !req.url) continue;

    const url = req.url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue;

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }

    if (excludeAssets && assetRegex.test(parsedUrl.pathname)) continue;
    if (options.host && parsedUrl.host !== options.host) continue;

    const method = String(req.method || 'GET').toUpperCase();
    const headers = {};
    for (const h of req.headers || []) {
      const nameLower = (h.name || '').toLowerCase();
      if (!nameLower || skipHeaders.has(nameLower) || nameLower.startsWith('sec-ch-ua')) continue;
      headers[h.name] = h.value || '';
    }

    let body = null;
    if (req.postData?.text) {
      body = req.postData.text;
      if (req.postData.mimeType && !headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = req.postData.mimeType;
      }
    }

    const pathClean = parsedUrl.pathname === '/' ? '' : parsedUrl.pathname.replace(/\//g, '-');
    const name = `${method.toLowerCase()}${pathClean || '-root'}`;

    endpoints.push({
      name: `${name}-${endpoints.length + 1}`,
      url,
      method,
      headers,
      body,
      weight: 1
    });
  }

  if (!endpoints.length) {
    throw new Error('No HTTP endpoints found in HAR file (try --include-assets if all were filtered)');
  }

  return {
    name: options.name || 'har-imported-test',
    durationSeconds: Number(options.duration || 30),
    concurrency: Number(options.concurrency || 5),
    rps: Number(options.rps || 10),
    timeoutMs: Number(options.timeout || 10000),
    endpoints
  };
}

function exportToK6(config) {
  const norm = normalizeConfig({ ...config, _: ['run'] });
  const stages = norm.stages.map(s => `    { duration: '${s.durationSeconds}s', target: ${s.concurrency} }`).join(',\n');
  const eps = norm.endpoints && norm.endpoints.length > 0
    ? norm.endpoints
    : (norm.scenarios ? norm.scenarios.flatMap(s => s.steps || []) : []);

  const thresholds = [];
  if (norm.thresholds?.p95Ms) thresholds.push(`    http_req_duration: ['p(95)<${norm.thresholds.p95Ms}']`);
  if (norm.thresholds?.maxErrorRate !== undefined) thresholds.push(`    http_req_failed: ['rate<=${norm.thresholds.maxErrorRate}']`);

  const requestsCode = eps.map((ep, idx) => {
    const method = ep.method.toLowerCase();
    const headersStr = Object.keys(ep.headers || {}).length ? JSON.stringify(ep.headers) : '{}';
    const bodyStr = ep.body ? JSON.stringify(ep.body) : 'null';
    let code = '';
    if (['post', 'put', 'patch'].includes(method)) {
      code = `  const res${idx + 1} = http.${method}('${ep.url}', ${bodyStr}, { headers: ${headersStr} });`;
    } else {
      code = `  const res${idx + 1} = http.${method}('${ep.url}', { headers: ${headersStr} });`;
    }
    const checkStatus = ep.expectStatus ? (Array.isArray(ep.expectStatus) ? `[${ep.expectStatus.join(', ')}].includes(r.status)` : `r.status === ${ep.expectStatus}`) : 'r.status === 200';
    return `${code}\n  check(res${idx + 1}, {\n    '${ep.name} status check': (r) => ${checkStatus},\n  });`;
  }).join('\n\n');

  return `// Safe Load Lab — Exported k6 Load Test Script
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
${stages}
  ],
  thresholds: {
${thresholds.join(',\n')}
  }
};

export default function () {
${requestsCode}
  sleep(1);
}
`;
}

function exportToPostman(config) {
  const norm = normalizeConfig({ ...config, _: ['run'] });
  const eps = norm.endpoints && norm.endpoints.length > 0
    ? norm.endpoints
    : (norm.scenarios ? norm.scenarios.flatMap(s => s.steps || []) : []);
  const items = eps.map(ep => {
    const headers = Object.entries(ep.headers || {}).map(([key, value]) => ({ key, value }));
    const u = new URL(ep.url);
    const pathParts = u.pathname.split('/').filter(Boolean);

    const reqItem = {
      name: ep.name,
      request: {
        method: ep.method,
        header: headers,
        url: {
          raw: ep.url,
          protocol: u.protocol.replace(':', ''),
          host: u.host.split('.'),
          path: pathParts
        }
      }
    };

    if (ep.body && ['POST', 'PUT', 'PATCH'].includes(ep.method)) {
      reqItem.request.body = {
        mode: 'raw',
        raw: typeof ep.body === 'string' ? ep.body : JSON.stringify(ep.body, null, 2),
        options: {
          raw: {
            language: 'json'
          }
        }
      };
    }

    return reqItem;
  });

  return JSON.stringify({
    info: {
      name: norm.name || 'safe-load-lab-collection',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    item: items
  }, null, 2);
}

function startMockServer(port = 8080, host = '127.0.0.1') {
  const requestHistory = new Map(); // ip -> [timestamps]
  const mockItems = [{ id: 1, name: 'Item 1' }, { id: 2, name: 'Item 2' }];
  const customRoutes = new Map();

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

    if (pathname === '/auth') {
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: true, token: authHeader.slice(7), user: 'mock-user' }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: false, error: 'Unauthorized: Bearer token required' }));
      }
      return;
    }

    if (pathname === '/flaky') {
      const failRate = parseFloat(parsedUrl.searchParams.get('failRate') || '0.3');
      if (Math.random() < failRate) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Unavailable (Simulated Flakiness)', status: 503 }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', route: 'flaky' }));
      }
      return;
    }

    if (pathname === '/items') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: mockItems, total: mockItems.length }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(body); } catch {}
          const newItem = { id: mockItems.length + 1, ...parsed, createdAt: new Date().toISOString() };
          mockItems.push(newItem);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(newItem));
        });
        return;
      }
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

    if (pathname === '/chaos') {
      const failRate = parseFloat(parsedUrl.searchParams.get('failRate') || '0.25');
      const minDelay = parseInt(parsedUrl.searchParams.get('minDelay') || '20', 10);
      const maxDelay = parseInt(parsedUrl.searchParams.get('maxDelay') || '150', 10);
      const status = parseInt(parsedUrl.searchParams.get('status') || '500', 10);
      const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

      setTimeout(() => {
        if (Math.random() < failRate) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Chaos Injected Failure', status, delayMs: delay }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', route: 'chaos', delayMs: delay }));
        }
      }, delay);
      return;
    }

    if (pathname === '/slow-stream') {
      const chunks = parseInt(parsedUrl.searchParams.get('chunks') || '5', 10);
      const delay = parseInt(parsedUrl.searchParams.get('delay') || '30', 10);
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Transfer-Encoding': 'chunked'
      });
      let chunkCount = 0;
      const timer = setInterval(() => {
        chunkCount++;
        res.write(JSON.stringify({ chunk: chunkCount, total: chunks, time: Date.now() }) + '\n');
        if (chunkCount >= chunks) {
          clearInterval(timer);
          res.end();
        }
      }, delay);
      return;
    }

    if (pathname === '/mock/routes') {
      if (req.method === 'GET') {
        const routes = Array.from(customRoutes.entries()).map(([p, r]) => ({ path: p, ...r }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ routes, total: routes.length }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (!data.path) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'path is required' }));
              return;
            }
            customRoutes.set(data.path, {
              method: (data.method || 'GET').toUpperCase(),
              status: data.status || 200,
              headers: data.headers || { 'Content-Type': 'application/json' },
              body: data.body !== undefined ? data.body : { ok: true }
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, status: 'created', path: data.path }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
      if (req.method === 'DELETE') {
        const delPath = parsedUrl.searchParams.get('path');
        if (delPath) {
          customRoutes.delete(delPath);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, status: 'deleted', path: delPath }));
          return;
        }
        customRoutes.clear();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, status: 'cleared' }));
        return;
      }
    }

    if (customRoutes.has(pathname)) {
      const cr = customRoutes.get(pathname);
      if (!cr.method || cr.method === req.method) {
        res.writeHead(cr.status, cr.headers || { 'Content-Type': 'application/json' });
        const payload = typeof cr.body === 'string' ? cr.body : JSON.stringify(cr.body);
        res.end(payload);
        return;
      }
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
      durationSeconds: args.durationSeconds ?? args.duration,
      concurrency: args.concurrency,
      rps: args.rps,
      timeoutMs: args.timeoutMs ?? args.timeout,
      endpoints: [ep]
    };
  } else if (args.config) {
    config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  } else if ((args.endpoints && Array.isArray(args.endpoints)) || (args.scenarios && Array.isArray(args.scenarios))) {
    config = {
      ...args,
      name: args.name || 'custom-test',
      durationSeconds: args.durationSeconds ?? args.duration,
      concurrency: args.concurrency,
      rps: args.rps,
      timeoutMs: args.timeoutMs ?? args.timeout,
      endpoints: args.endpoints || [],
      scenarios: args.scenarios,
      stages: args.stages,
      thresholds: args.thresholds || {}
    };
  } else {
    if (!args.url) throw new Error('Provide --config <file>, --url <url>, or --curl "<command>"');
    config = {
      name: 'simple-test',
      durationSeconds: args.durationSeconds ?? args.duration,
      concurrency: args.concurrency,
      rps: args.rps,
      timeoutMs: args.timeoutMs ?? args.timeout,
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
    thresholds: config.thresholds || {},
    data: null,
    dataMode: args['data-mode'] || config.dataMode || 'round-robin'
  };

  const dataPath = args.data || config.dataFile;
  if (dataPath) {
    if (fs.existsSync(dataPath)) {
      normalized.data = parseCsvData(fs.readFileSync(dataPath, 'utf8'));
    } else {
      throw new Error(`Data feed file not found: ${dataPath}`);
    }
  } else if (Array.isArray(config.data)) {
    normalized.data = config.data;
  }

  if (Array.isArray(config.scenarios) && config.scenarios.length > 0) {
    normalized.scenarios = config.scenarios.map((sc, scIdx) => ({
      name: sc.name || `scenario-${scIdx + 1}`,
      weight: Number(sc.weight || 1),
      steps: (sc.steps || []).map((step, sIdx) => ({
        ...normalizeEndpoint(step, sIdx, normalized.variables),
        extract: step.extract || null,
        continueOnFailure: Boolean(step.continueOnFailure)
      }))
    }));
  }

  const hasEndpoints = Array.isArray(normalized.endpoints) && normalized.endpoints.length > 0;
  const hasScenarios = Array.isArray(normalized.scenarios) && normalized.scenarios.length > 0;
  if (!hasEndpoints && !hasScenarios) throw new Error('Config must contain at least one endpoint or scenario');

  if (hasEndpoints) {
    normalized.endpoints = normalized.endpoints.map((ep, idx) => normalizeEndpoint(ep, idx, normalized.variables));
  }
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

function generateSparkline(values, buckets = 10) {
  if (!values || !values.length) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return '▄'.repeat(buckets);
  const step = (max - min) / buckets;
  const counts = new Array(buckets).fill(0);
  for (const v of values) {
    const b = Math.min(buckets - 1, Math.floor((v - min) / (step || 1)));
    counts[b]++;
  }
  const maxCount = Math.max(...counts) || 1;
  const chars = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  return counts.map(c => chars[Math.min(chars.length - 1, Math.floor((c / maxCount) * (chars.length - 1)))]).join('');
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
  const errorBreakdown = {
    timeouts: 0,
    connectionReset: 0,
    http4xx: 0,
    http5xx: 0,
    other: 0,
    samples: []
  };

  let totalBytesSent = 0;
  let totalBytesReceived = 0;

  for (const r of results) {
    totalBytesSent += (r.bytesSent || 0);
    totalBytesReceived += (r.bytesReceived || 0);
    byStatus[r.status || 'error'] = (byStatus[r.status || 'error'] || 0) + 1;
    byEndpoint[r.endpoint] ||= { total: 0, failed: 0, durations: [] };
    byEndpoint[r.endpoint].total++;
    const isFail = Boolean(r.error || r.status >= 400 || r.status === 0);
    if (isFail) {
      byEndpoint[r.endpoint].failed++;
      const errStr = String(r.error || '');
      if (r.error === 'timeout' || errStr.includes('ETIMEDOUT') || errStr.includes('timeout')) {
        errorBreakdown.timeouts++;
      } else if (errStr.includes('ECONNRESET') || errStr.includes('ECONNREFUSED')) {
        errorBreakdown.connectionReset++;
      } else if (r.status >= 400 && r.status < 500) {
        errorBreakdown.http4xx++;
      } else if (r.status >= 500) {
        errorBreakdown.http5xx++;
      } else {
        errorBreakdown.other++;
      }

      if (errorBreakdown.samples.length < 5) {
        errorBreakdown.samples.push({
          endpoint: r.endpoint,
          method: r.method,
          url: r.url,
          status: r.status,
          durationMs: Number((r.durationMs || 0).toFixed(1)),
          error: r.error || `HTTP ${r.status}`,
          timestamp: r.timestamp
        });
      }
    }
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
  const totalBytes = totalBytesSent + totalBytesReceived;
  const throughputKbps = elapsedSeconds > 0 ? (totalBytes / 1024) / elapsedSeconds : 0;
  const throughputMbps = elapsedSeconds > 0 ? (totalBytes / (1024 * 1024)) / elapsedSeconds : 0;

  return {
    testName: config.name,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    elapsedSeconds,
    requested: { durationSeconds: config.durationSeconds, concurrency: config.concurrency, rps: config.rps, stages: config.stages },
    totals: { requests: total, failed, errorRate: metrics.errorRate, achievedRps: elapsedSeconds > 0 ? total / elapsedSeconds : 0 },
    bandwidth: { totalBytes, bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, throughputKbps, throughputMbps },
    latencySparkline: generateSparkline(durations, 10),
    latencyDistribution: computeLatencyDistribution(durations),
    latencyMs: { avg, min: durations.length ? Math.min(...durations) : 0, max: durations.length ? Math.max(...durations) : 0, p50: globalPercentiles[50], p90: globalPercentiles[90], p95: metrics.p95, p99: metrics.p99 },
    byStatus,
    byEndpoint: endpointSummary,
    errorBreakdown,
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

    let bytesSent = ep.method.length + ep.url.length + 16;
    if (ep.body) bytesSent += Buffer.byteLength(typeof ep.body === 'string' ? ep.body : JSON.stringify(ep.body));
    if (ep.headers) {
      for (const [k, v] of Object.entries(ep.headers)) {
        bytesSent += Buffer.byteLength(k) + Buffer.byteLength(String(v)) + 4;
      }
    }
    
    const res = await fetch(ep.url, { 
      method: ep.method, 
      headers: ep.headers, 
      body: ['GET', 'HEAD'].includes(ep.method) ? undefined : ep.body, 
      redirect: 'manual', 
      signal: controller.signal,
      keepalive: true  // Enable connection reuse
    });
    
    // Capture response headers & size
    const headers = {};
    let bytesReceived = 0;
    const cl = res.headers.get('content-length');
    if (cl && !isNaN(parseInt(cl, 10))) {
      bytesReceived = parseInt(cl, 10);
    }
    res.headers.forEach((value, key) => {
      headers[key] = value;
      bytesReceived += key.length + value.length + 4;
    });
    
    // Only consume body when needed - for non-success responses, skip body reading if not capturing
    const text = captureBody ? await res.text().catch(() => '') : 
                 (res.status >= 200 && res.status < 300) ? await res.arrayBuffer().then(buf => { if (!cl) bytesReceived += buf.byteLength; return ''; }).catch(() => '') :
                 '';
    if (!cl && text) bytesReceived += Buffer.byteLength(text);
    
    const durationMs = performance.now() - start;
    debug(`Response: ${res.status} in ${durationMs.toFixed(2)}ms`);
    
    const result = { 
      endpoint: ep.name, 
      method: ep.method, 
      url: ep.url, 
      status: res.status, 
      durationMs, 
      bytesSent,
      bytesReceived,
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
      bytesSent: 0,
      bytesReceived: 0,
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
          if (Array.isArray(assertion.in)) {
            assertionResult.expected = `one of [${assertion.in.join(', ')}]`;
            assertionResult.actual = result.status;
            assertionResult.passed = assertion.in.includes(result.status);
            assertionResult.message = assertionResult.passed
              ? `Status ${result.status} in expected set`
              : `Expected one of [${assertion.in.join(', ')}], got ${result.status}`;
          } else {
            assertionResult.expected = assertion.value;
            assertionResult.actual = result.status;
            assertionResult.passed = result.status === assertion.value;
            assertionResult.message = assertionResult.passed 
              ? 'Status matches' 
              : `Expected ${assertion.value}, got ${result.status}`;
          }
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
            assertionResult.passed = String(value ?? '').includes(assertion.contains);
            assertionResult.message = assertionResult.passed
              ? 'Contains expected value'
              : `Expected to contain "${assertion.contains}", got ${value}`;
          } else if (assertion.greaterThan !== undefined) {
            assertionResult.expected = `> ${assertion.greaterThan}`;
            assertionResult.passed = Number(value) > assertion.greaterThan;
            assertionResult.message = assertionResult.passed
              ? 'Value exceeds threshold'
              : `Expected > ${assertion.greaterThan}, got ${value}`;
          } else if (assertion.lessThan !== undefined) {
            assertionResult.expected = `< ${assertion.lessThan}`;
            assertionResult.passed = Number(value) < assertion.lessThan;
            assertionResult.message = assertionResult.passed
              ? 'Value is below threshold'
              : `Expected < ${assertion.lessThan}, got ${value}`;
          } else if (assertion.exists !== undefined) {
            assertionResult.expected = assertion.exists ? 'exists' : 'does not exist';
            assertionResult.passed = (value !== undefined) === Boolean(assertion.exists);
            assertionResult.message = assertionResult.passed
              ? 'Path existence matches'
              : `Expected ${assertion.exists ? 'existence' : 'non-existence'}, got ${value !== undefined ? 'exists' : 'undefined'}`;
          }
          break;
          
        case 'regex':
        case 'bodyRegex': {
          const pattern = new RegExp(assertion.pattern, assertion.flags || '');
          assertionResult.expected = `matches /${assertion.pattern}/${assertion.flags || ''}`;
          assertionResult.passed = pattern.test(result.body || '');
          assertionResult.actual = (result.body || '').slice(0, 100);
          assertionResult.message = assertionResult.passed
            ? 'Body matches regex pattern'
            : `Body does not match /${assertion.pattern}/`;
          break;
        }

        case 'jsonSchema':
        case 'schema': {
          if (!responseBody || typeof responseBody !== 'object') {
            assertionResult.passed = false;
            assertionResult.expected = 'valid JSON object';
            assertionResult.actual = typeof responseBody;
            assertionResult.message = 'Response body is not a JSON object';
          } else {
            const required = Array.isArray(assertion.required) ? assertion.required : [];
            const missing = required.filter(field => getByPath(responseBody, field) === undefined);
            assertionResult.passed = missing.length === 0;
            assertionResult.expected = `required: [${required.join(', ')}]`;
            assertionResult.actual = missing.length ? `missing: [${missing.join(', ')}]` : 'all required present';
            assertionResult.message = assertionResult.passed
              ? 'Schema validation passed'
              : `Missing required schema fields: ${missing.join(', ')}`;
          }
          break;
        }

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

async function probeEndpoint(epInput, timeoutMs = 10000) {
  const vars = epInput.variables || {};
  const ep = normalizeEndpoint(epInput, 0, vars);
  const start = performance.now();
  const res = await doRequest(ep, timeoutMs, true);
  const durationMs = performance.now() - start;

  let assertions = [];
  if (ep.assertions && ep.assertions.length > 0) {
    assertions = evaluateAssertions(res, ep.assertions);
  }

  const passed = (res.status >= 200 && res.status < 400) && (!assertions.length || assertions.every(a => a.passed));

  return {
    endpoint: ep.name,
    url: ep.url,
    method: ep.method,
    status: res.status,
    durationMs: Number(durationMs.toFixed(2)),
    headers: res.headers || {},
    body: res.body || '',
    error: res.error,
    assertions,
    passed
  };
}

function printProbeResult(result) {
  console.log(chalk.bold('\n🔍 Safe Load Lab — Preflight Request Probe'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(`Endpoint: ${chalk.cyan(result.method)} ${result.url}`);
  const statusColor = result.status >= 200 && result.status < 300 ? chalk.green : result.status >= 400 ? chalk.red : chalk.yellow;
  console.log(`Status:   ${statusColor.bold(result.status || 'ERROR')} (${result.error || (result.status >= 200 && result.status < 400 ? 'OK' : 'FAIL')})`);
  console.log(`Latency:  ${chalk.magenta(result.durationMs + 'ms')}`);
  console.log(chalk.gray('\nResponse Headers:'));
  for (const [k, v] of Object.entries(result.headers)) {
    console.log(`  ${chalk.gray(k)}: ${v}`);
  }
  if (result.assertions && result.assertions.length) {
    console.log(chalk.gray('\nAssertions:'));
    for (const a of result.assertions) {
      const icon = a.passed ? chalk.green('✓') : chalk.red('✗');
      console.log(`  ${icon} ${a.type}: ${a.message}`);
    }
  }
  console.log(chalk.gray('\nResponse Body Preview:'));
  try {
    const parsed = JSON.parse(result.body);
    console.log(JSON.stringify(parsed, null, 2).slice(0, 1500));
  } catch {
    console.log((result.body || '').slice(0, 1000));
  }
  console.log(chalk.gray('─'.repeat(60)));
  if (result.passed) {
    console.log(chalk.bold.green('✓ Probe Passed: Target responded within acceptable criteria.\n'));
  } else {
    console.log(chalk.bold.red('✗ Probe Failed: Target returned error status or assertion failed.\n'));
  }
}

function generateCiWorkflow(type = 'github', options = {}) {
  const configFile = options.config || 'load-test.json';
  const cron = options.cron || '0 2 * * *';

  if (type === 'gitlab') {
    return `# GitLab CI - Safe Load Lab Performance Pipeline
stages:
  - test
  - performance

load-test:
  stage: performance
  image: node:20-alpine
  script:
    - npx --yes safe-load-lab run --config ${configFile} --i-own-this-target --junit reports/junit.xml --markdown reports/summary.md
  artifacts:
    when: always
    paths:
      - reports/
    reports:
      junit: reports/junit.xml
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
`;
  }

  return `name: Safe Load Lab SLA & Performance CI

on:
  pull_request:
    branches: [main, master]
  schedule:
    - cron: '${cron}'
  workflow_dispatch:

permissions:
  contents: read
  checks: write
  pull-requests: write

jobs:
  load-test:
    name: Safe Load Lab Automated SLA Test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: npm ci || npm install

      - name: Execute Controlled Load Test
        id: load_test
        run: |
          npx --yes safe-load-lab run \\
            --config ${configFile} \\
            --i-own-this-target \\
            --junit reports/junit.xml \\
            --markdown reports/summary.md \\
            --badge reports/badge.svg
        env:
          GITHUB_STEP_SUMMARY: \${{ github.step_summary }}

      - name: Upload Test Reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: safe-load-lab-reports
          path: reports/
          retention-days: 14

      - name: Publish JUnit SLA Results
        if: always()
        uses: mikepenz/action-junit-report@v4
        with:
          report_paths: 'reports/junit.xml'
          check_name: 'Safe Load Lab SLA Test Results'
          fail_on_failure: true
`;
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
  const dataRows = Array.isArray(config.data) && config.data.length ? config.data : null;
  let dataRowIndex = 0;
  
  console.log(chalk.bold.cyan(`\n🚀 Starting: ${config.name}${config.activeEnv ? chalk.gray(' [' + config.activeEnv + ']') : ''}`));
  console.log(`Duration: ${chalk.yellow(config.durationSeconds + 's')} | Max concurrency: ${chalk.yellow(config.concurrency)} | Max RPS cap: ${chalk.yellow(config.rps)}`);
  if (dataRows) console.log(chalk.gray(`Data feed: ${chalk.cyan(dataRows.length)} rows (${config.dataMode || 'round-robin'})`));
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
      active++; launched++; requestCounter++;
      lastLaunch = now;
      const retryConfig = config.retry || { enabled: true, maxAttempts: 3 };
      const jitterMs = Number(config.jitterMs || config.jitter || 0);

      if (config.scenarios && config.scenarios.length > 0) {
        const scenario = pickEndpoint(config.scenarios);
        const sessionVars = { ...(config.variables || {}), sessionId: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 9) };
        
        const runScenario = async () => {
          for (let sIdx = 0; sIdx < scenario.steps.length; sIdx++) {
            const step = scenario.steps[sIdx];
            const renderedStep = normalizeEndpoint(step, sIdx, sessionVars);
            if (jitterMs > 0) {
              await new Promise(r => setTimeout(r, Math.random() * jitterMs));
            }
            const res = await doRequestWithRetry(renderedStep, config.timeoutMs, retryConfig, Boolean(step.extract));
            res.scenario = scenario.name;
            results.push(res);

            if (step.extract && res.body) {
              let json;
              try { json = JSON.parse(res.body); } catch {}
              for (const [varName, pathStr] of Object.entries(step.extract)) {
                const val = pathStr.startsWith('body.') ? getByPath(json, pathStr.slice(5)) : getByPath(json, pathStr);
                if (val !== undefined) sessionVars[varName] = val;
              }
            }

            if (res.error || (step.expectStatus && res.status !== step.expectStatus)) {
              if (step.continueOnFailure !== true) break;
            }
          }
        };

        runScenario()
          .catch(() => {})
          .finally(() => active--);
      } else {
        let ep;
        if (dataRows && dataRows.length > 0) {
          const epTemplate = pickEndpoint(config.endpointTemplates || config.endpoints);
          const row = config.dataMode === 'random'
            ? dataRows[Math.floor(Math.random() * dataRows.length)]
            : dataRows[dataRowIndex % dataRows.length];
          dataRowIndex++;
          const iterVars = { ...(config.variables || {}), data: row };
          ep = normalizeEndpoint(epTemplate, 0, iterVars);
        } else {
          ep = pickEndpoint(config.endpoints);
        }

        const sendReq = async () => {
          if (jitterMs > 0) {
            await new Promise(r => setTimeout(r, Math.random() * jitterMs));
          }
          return doRequestWithRetry(ep, config.timeoutMs, retryConfig, false);
        };

        sendReq()
          .then(r => results.push(r))
          .finally(() => active--);
      }
      
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

  const statusRows = Object.entries(summary.byStatus || {}).map(([k, v]) => {
    const code = parseInt(k, 10);
    const cls = isNaN(code) ? 'badge-danger' : code >= 200 && code < 300 ? 'badge-success' : code >= 400 ? 'badge-danger' : 'badge-warning';
    return `<tr><td><span class="badge ${cls}">${htmlEscape(k)}</span></td><td style="font-weight:700;">${v.toLocaleString()}</td></tr>`;
  }).join('');

  const endpointRows = Object.entries(summary.byEndpoint || {}).map(([name, e]) => `<tr>
    <td style="font-weight:600;color:#38bdf8;">${htmlEscape(name)}</td>
    <td>${e.total.toLocaleString()}</td>
    <td>${e.failed}</td>
    <td style="color:${e.errorRate > 0 ? '#ef4444' : '#10b981'};font-weight:700;">${(e.errorRate * 100).toFixed(2)}%</td>
    <td>${e.avgMs.toFixed(1)}ms</td>
    <td>${e.p95Ms.toFixed(1)}ms</td>
    <td>${e.p99Ms.toFixed(1)}ms</td>
  </tr>`).join('');

  const thresholdRows = Object.entries(summary.thresholds || {}).map(([name, t]) => `<tr>
    <td style="font-weight:600;">${htmlEscape(name)}</td>
    <td><span class="badge ${t.pass ? 'badge-success' : 'badge-danger'}">${t.pass ? '✓ PASS' : '✗ FAIL'}</span></td>
    <td style="font-family:monospace;">${htmlEscape(t.actual)}</td>
    <td style="font-family:monospace;color:#94a3b8;">${htmlEscape(t.expected)}</td>
  </tr>`).join('') || '<tr><td colspan="4" style="color:#64748b;">No SLA thresholds configured</td></tr>';

  const recentRows = (results || []).slice(-100).reverse().map(r => {
    const isErr = r.status >= 400 || r.status === 0 || r.error;
    return `<tr>
      <td style="font-family:monospace;font-size:12px;color:#94a3b8;">${htmlEscape((r.timestamp || '').slice(11, 23))}</td>
      <td style="font-weight:600;color:#e2e8f0;">${htmlEscape(r.endpoint)}</td>
      <td><span class="badge ${isErr ? 'badge-danger' : 'badge-success'}">${r.status || 'ERR'}</span></td>
      <td style="font-family:monospace;">${r.durationMs ? r.durationMs.toFixed(1) + 'ms' : '0ms'}</td>
      <td style="color:${isErr ? '#ef4444' : '#64748b'};font-size:12px;">${htmlEscape(r.error || 'None')}</td>
    </tr>`;
  }).join('');

  // 1. Percentiles SVG Chart
  const pMin = summary.latencyMs?.min || 0;
  const p50 = summary.latencyMs?.p50 || 0;
  const p90 = summary.latencyMs?.p90 || 0;
  const p95 = summary.latencyMs?.p95 || 0;
  const p99 = summary.latencyMs?.p99 || 0;
  const pMax = summary.latencyMs?.max || Math.max(p99 * 1.2, 10);
  const maxAxis = Math.max(pMax, 1);

  const points = [
    { label: 'Min', val: pMin, x: 40 },
    { label: 'p50', val: p50, x: 110 },
    { label: 'p90', val: p90, x: 190 },
    { label: 'p95', val: p95, x: 270 },
    { label: 'p99', val: p99, x: 350 },
    { label: 'Max', val: pMax, x: 420 }
  ];

  const svgH = 150;
  const svgTop = 25;
  const svgBottom = 115;
  const svgRange = svgBottom - svgTop;

  const polyCoords = points.map(p => {
    const y = svgBottom - Math.round((Math.min(p.val, maxAxis) / maxAxis) * svgRange);
    return `${p.x},${y}`;
  }).join(' ');

  const percentileDots = points.map(p => {
    const y = svgBottom - Math.round((Math.min(p.val, maxAxis) / maxAxis) * svgRange);
    return `
      <circle cx="${p.x}" cy="${y}" r="4" fill="#06b6d4" stroke="#090d16" stroke-width="2"/>
      <text x="${p.x}" y="${y - 8}" text-anchor="middle" fill="#38bdf8" font-size="10" font-family="monospace">${p.val.toFixed(0)}ms</text>
      <text x="${p.x}" y="${svgBottom + 16}" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="sans-serif">${p.label}</text>
    `;
  }).join('');

  const percentileSvg = `<svg viewBox="0 0 460 145" width="100%" height="145" xmlns="http://www.w3.org/2000/svg">
    <line x1="30" y1="${svgBottom}" x2="435" y2="${svgBottom}" stroke="#334155" stroke-width="1"/>
    <polyline fill="none" stroke="#06b6d4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${polyCoords}"/>
    ${percentileDots}
  </svg>`;

  // 2. Latency Distribution SVG
  const distBuckets = summary.latencyDistribution?.buckets || summary.distribution?.buckets || [];
  let distBars = '';
  if (distBuckets.length) {
    const barW = 38;
    const gap = 12;
    const startX = 30;
    const maxPct = Math.max(...distBuckets.map(b => Number(b.percentage ?? b.pct ?? 0)), 1);

    distBars = distBuckets.map((b, i) => {
      const x = startX + i * (barW + gap);
      const pct = Number(b.percentage ?? b.pct ?? 0);
      const h = Math.round((pct / maxPct) * 75);
      const y = svgBottom - h;
      return `
        <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="url(#cyanGrad)"/>
        <text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" fill="#f8fafc" font-size="9" font-family="monospace">${pct}%</text>
        <text x="${x + barW / 2}" y="${svgBottom + 14}" text-anchor="middle" fill="#94a3b8" font-size="8" font-family="sans-serif">${b.label}</text>
      `;
    }).join('');
  }

  const distributionSvg = `<svg viewBox="0 0 440 145" width="100%" height="145" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="cyanGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#06b6d4"/>
        <stop offset="100%" stop-color="#3b82f6"/>
      </linearGradient>
    </defs>
    <line x1="20" y1="${svgBottom}" x2="430" y2="${svgBottom}" stroke="#334155" stroke-width="1"/>
    ${distBars}
  </svg>`;

  // 3. Anomaly Warnings Box
  const anomalies = summary.latencyDistribution?.anomalies || [];
  let anomalyHtml = '';
  if (anomalies.length) {
    anomalyHtml = `<div class="alert-box alert-warn" style="margin-bottom:24px;">
      <div style="font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
        <span>⚠️</span> <span>Performance Anomalies Detected:</span>
      </div>
      ${anomalies.map(a => `<div style="font-size:13px;margin-top:4px;">• <b>[${htmlEscape(a.type)}]</b> ${htmlEscape(a.message)}</div>`).join('')}
    </div>`;
  }

  // 4. Bandwidth formatted
  let throughputStr = 'N/A';
  let totalDataStr = 'N/A';
  if (summary.bandwidth) {
    throughputStr = summary.bandwidth.throughputMbps >= 1 
      ? `${summary.bandwidth.throughputMbps.toFixed(2)} MB/s`
      : `${summary.bandwidth.throughputKbps.toFixed(1)} KB/s`;
    const mb = (summary.bandwidth.totalBytes / (1024 * 1024)).toFixed(2);
    totalDataStr = `${mb} MB`;
  }

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Safe Load Lab Report - ${htmlEscape(summary.testName)}</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #0f172a;
      --subtle: #131c31;
      --border: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #06b6d4;
      --success: #10b981;
      --warn: #f59e0b;
      --danger: #ef4444;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.5; padding: 32px 20px; }
    main { max-width: 1200px; margin: 0 auto; }
    .header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 28px; }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 800; color: var(--text); letter-spacing: -0.02em; }
    .brand-badge { background: linear-gradient(135deg, #06b6d4, #3b82f6); width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 16px; }
    .meta-tag { font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); background: var(--subtle); padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 28px; }
    .kpi-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
    .kpi-metric { font-size: 28px; font-weight: 800; color: #38bdf8; font-family: var(--font-mono); }
    .kpi-label { font-size: 11px; text-transform: uppercase; font-weight: 600; color: var(--text-muted); margin-top: 4px; letter-spacing: 0.05em; }
    .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 28px; }
    @media (max-width: 900px) { .chart-grid { grid-template-columns: 1fr; } }
    .chart-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
    .chart-title { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
    .alert-box { padding: 14px 18px; border-radius: 8px; border-left: 4px solid; }
    .alert-warn { background: rgba(245, 158, 11, 0.1); border-color: var(--warn); color: #fde68a; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 28px; }
    .card-header { padding: 14px 18px; background: var(--subtle); border-bottom: 1px solid var(--border); font-size: 14px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 11px 16px; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: var(--subtle); color: var(--text-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; font-family: var(--font-mono); }
    .badge-success { background: rgba(16, 185, 129, 0.15); color: var(--success); }
    .badge-warning { background: rgba(245, 158, 11, 0.15); color: var(--warn); }
    .badge-danger { background: rgba(239, 68, 68, 0.15); color: var(--danger); }
    @media print {
      body { background: #fff !important; color: #000 !important; }
      .kpi-card, .chart-card, .card { border-color: #cbd5e1 !important; background: #f8fafc !important; }
      .kpi-metric { color: #0284c7 !important; }
    }
  </style>
</head>
<body>
  <main>
    <div class="header">
      <div class="brand">
        <div class="brand-badge">⚡</div>
        <div>Safe Load Lab <span style="font-size:12px;color:var(--text-muted);font-weight:400;">Executive Performance Report</span></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <span class="meta-tag">Test: ${htmlEscape(summary.testName)}</span>
        <span class="meta-tag">Duration: ${(Number(summary.elapsedSeconds || summary.durationSeconds || summary.duration || 0)).toFixed(1)}s</span>
        <span class="meta-tag">${htmlEscape((summary.startedAt || '').slice(0, 19).replace('T', ' '))}</span>
      </div>
    </div>

    ${anomalyHtml}

    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-metric">${(summary.totals?.requests || 0).toLocaleString()}</div>
        <div class="kpi-label">Total Requests</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-metric" style="color:${(summary.totals?.failed || 0) > 0 ? '#ef4444' : '#10b981'};">${(summary.totals?.failed || 0).toLocaleString()}</div>
        <div class="kpi-label">Failed Requests</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-metric" style="color:${(summary.totals?.errorRate || 0) > 0 ? '#ef4444' : '#10b981'};">${((summary.totals?.errorRate || 0) * 100).toFixed(2)}%</div>
        <div class="kpi-label">Error Rate</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-metric">${(summary.totals?.achievedRps || 0).toFixed(1)}</div>
        <div class="kpi-label">Achieved RPS</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-metric">${(summary.latencyMs?.p95 || 0).toFixed(1)}ms</div>
        <div class="kpi-label">p95 Latency</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-metric" style="font-size:24px;">${throughputStr}</div>
        <div class="kpi-label">Throughput (${totalDataStr})</div>
      </div>
    </div>

    <div class="chart-grid">
      <div class="chart-card">
        <div class="chart-title">
          <span>📈 Latency Percentile Progression</span>
          <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">Avg: ${summary.latencyMs.avg.toFixed(1)}ms</span>
        </div>
        ${percentileSvg}
      </div>
      <div class="chart-card">
        <div class="chart-title">
          <span>📊 Latency HDR Histogram Distribution</span>
          <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">p99: ${summary.latencyMs.p99.toFixed(1)}ms</span>
        </div>
        ${distributionSvg}
      </div>
    </div>

    <div class="card">
      <div class="card-header">🎯 SLA Threshold Scorecard</div>
      <table>
        <thead><tr><th>Threshold Name</th><th>Status</th><th>Actual Value</th><th>Target SLA</th></tr></thead>
        <tbody>${thresholdRows}</tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-header">🌐 Target Endpoints Performance</div>
      <table>
        <thead><tr><th>Endpoint</th><th>Requests</th><th>Failed</th><th>Error Rate</th><th>Avg Latency</th><th>p95 Latency</th><th>p99 Latency</th></tr></thead>
        <tbody>${endpointRows}</tbody>
      </table>
    </div>

    <div style="display:grid;grid-template-columns:300px 1fr;gap:20px;margin-bottom:28px;">
      <div class="card" style="margin-bottom:0;">
        <div class="card-header">🔢 Status Codes</div>
        <table>
          <thead><tr><th>Code</th><th>Count</th></tr></thead>
          <tbody>${statusRows}</tbody>
        </table>
      </div>
      <div class="card" style="margin-bottom:0;">
        <div class="card-header">⏱️ Recent Requests Audit (Last 100)</div>
        <div style="max-height:260px;overflow-y:auto;">
          <table>
            <thead><tr><th>Time</th><th>Endpoint</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
            <tbody>${recentRows}</tbody>
          </table>
        </div>
      </div>
    </div>

    <footer style="text-align:center;color:var(--text-muted);font-size:12px;margin-top:20px;">
      Safe Load Lab Performance Engineering Suite • Confidential Benchmark
    </footer>
  </main>
</body>
</html>`;

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
| Distribution | \`${summary.latencySparkline || 'N/A'}\` |

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

${summary.errorBreakdown && summary.totals.failed > 0 ? `
## Error Breakdown

| Category | Count |
|----------|-------|
| Timeouts | ${summary.errorBreakdown.timeouts} |
| HTTP 5xx | ${summary.errorBreakdown.http5xx} |
| HTTP 4xx | ${summary.errorBreakdown.http4xx} |
| Connection Drops | ${summary.errorBreakdown.connectionReset} |
| Other | ${summary.errorBreakdown.other} |
` : ''}

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

function generatePrometheusMetrics(summary, results = []) {
  const lines = [];
  const testName = String(summary.testName || 'load-test').replace(/[^a-zA-Z0-9_-]/g, '_');

  lines.push('# HELP safe_load_lab_requests_total Total HTTP requests made');
  lines.push('# TYPE safe_load_lab_requests_total counter');
  for (const [status, count] of Object.entries(summary.byStatus || {})) {
    lines.push(`safe_load_lab_requests_total{status="${status}",test="${testName}"} ${count}`);
  }

  lines.push('# HELP safe_load_lab_achieved_rps Achieved requests per second');
  lines.push('# TYPE safe_load_lab_achieved_rps gauge');
  lines.push(`safe_load_lab_achieved_rps{test="${testName}"} ${(summary.totals?.achievedRps || 0).toFixed(2)}`);

  lines.push('# HELP safe_load_lab_error_rate Ratio of failed requests');
  lines.push('# TYPE safe_load_lab_error_rate gauge');
  lines.push(`safe_load_lab_error_rate{test="${testName}"} ${(summary.totals?.errorRate || 0).toFixed(4)}`);

  lines.push('# HELP safe_load_lab_latency_seconds Latency percentiles in seconds');
  lines.push('# TYPE safe_load_lab_latency_seconds summary');
  lines.push(`safe_load_lab_latency_seconds{test="${testName}",quantile="0.50"} ${((summary.latencyMs?.p50 || 0) / 1000).toFixed(4)}`);
  lines.push(`safe_load_lab_latency_seconds{test="${testName}",quantile="0.90"} ${((summary.latencyMs?.p90 || 0) / 1000).toFixed(4)}`);
  lines.push(`safe_load_lab_latency_seconds{test="${testName}",quantile="0.95"} ${((summary.latencyMs?.p95 || 0) / 1000).toFixed(4)}`);
  lines.push(`safe_load_lab_latency_seconds{test="${testName}",quantile="0.99"} ${((summary.latencyMs?.p99 || 0) / 1000).toFixed(4)}`);

  return lines.join('\n') + '\n';
}

function generateSvgBadge(summary) {
  const isPassed = !Object.values(summary.thresholds || {}).some(t => !t.pass) && (summary.totals?.errorRate || 0) < 0.05;
  const statusText = isPassed ? `pass | p95: ${(summary.latencyMs?.p95 || 0).toFixed(0)}ms` : `fail | err: ${((summary.totals?.errorRate || 0) * 100).toFixed(1)}%`;
  const color = isPassed ? '#10b981' : '#ef4444';
  const width = 160;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="load-test: ${statusText}">
  <linearGradient id="b" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="a"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#a)">
    <rect width="65" height="20" fill="#1e293b"/>
    <rect x="65" width="${width - 65}" height="20" fill="${color}"/>
    <rect width="${width}" height="20" fill="url(#b)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="32.5" y="14">load-test</text>
    <text x="${65 + (width - 65) / 2}" y="14">${statusText}</text>
  </g>
</svg>`;
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
  if (summary.latencySparkline) {
    const minMs = (summary.latencyMs.min || 0).toFixed(0);
    const maxMs = (summary.latencyMs.max || 0).toFixed(0);
    console.log(`Distribution: ${chalk.cyan.bold(summary.latencySparkline)} ${chalk.gray('[' + minMs + 'ms ... ' + maxMs + 'ms]')}`);
  }
  if (summary.bandwidth) {
    const mbRecv = (summary.bandwidth.bytesReceived / (1024 * 1024)).toFixed(2);
    const mbSent = (summary.bandwidth.bytesSent / (1024 * 1024)).toFixed(2);
    const rate = summary.bandwidth.throughputMbps >= 1 
      ? `${summary.bandwidth.throughputMbps.toFixed(2)} MB/s`
      : `${summary.bandwidth.throughputKbps.toFixed(1)} KB/s`;
    console.log(`Throughput:   ${chalk.cyan.bold(rate)} (${chalk.gray(mbRecv + ' MB in, ' + mbSent + ' MB out')})`);
  }

  if (summary.latencyDistribution?.buckets?.length) {
    const populated = summary.latencyDistribution.buckets.filter(b => b.count > 0);
    if (populated.length) {
      console.log(chalk.gray('\nLatency Buckets:'));
      for (const b of populated) {
        const barLen = Math.max(1, Math.round(b.percentage / 4));
        const bar = '■'.repeat(barLen);
        console.log(`  ${b.label.padEnd(10)} ${chalk.cyan(bar)} ${b.percentage}% (${b.count})`);
      }
    }
  }

  if (summary.latencyDistribution?.anomalies?.length) {
    console.log(chalk.bold.yellow('\n⚠️  Latency Anomalies:'));
    for (const a of summary.latencyDistribution.anomalies) {
      console.log(chalk.yellow(`  • [${a.type}] ${a.message}`));
    }
  }
  
  console.log(chalk.gray('\nStatus Distribution:'));
  for (const [status, count] of Object.entries(summary.byStatus)) {
    const statusNum = parseInt(status);
    const statusColor = isNaN(statusNum) ? chalk.red : 
                       statusNum >= 200 && statusNum < 300 ? chalk.green :
                       statusNum >= 400 ? chalk.red : chalk.yellow;
    console.log(`  ${statusColor(status)}: ${count}`);
  }

  if (summary.errorBreakdown && summary.totals.failed > 0) {
    const eb = summary.errorBreakdown;
    const parts = [];
    if (eb.timeouts > 0) parts.push(`${eb.timeouts} timeouts`);
    if (eb.http5xx > 0) parts.push(`${eb.http5xx} HTTP 5xx`);
    if (eb.http4xx > 0) parts.push(`${eb.http4xx} HTTP 4xx`);
    if (eb.connectionReset > 0) parts.push(`${eb.connectionReset} conn drops`);
    if (eb.other > 0) parts.push(`${eb.other} other`);
    if (parts.length) {
      console.log(chalk.gray('\nFailure Breakdown: ') + chalk.yellow(parts.join(', ')));
    }
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

// Compare two test reports with regression analysis & CI gate
function compareReports(file1Path, file2Path, options = {}) {
  const report1 = typeof file1Path === 'object' ? file1Path : JSON.parse(fs.readFileSync(file1Path, 'utf8'));
  const report2 = typeof file2Path === 'object' ? file2Path : JSON.parse(fs.readFileSync(file2Path, 'utf8'));
  const s1 = report1.summary || report1;
  const s2 = report2.summary || report2;

  const maxLatencyDiff = Number(options['max-latency-diff'] || options.maxLatencyDiff || 15);
  const maxErrorDiff = Number(options['max-error-diff'] || options.maxErrorDiff || 0);

  console.log(chalk.bold('\n🔍 Safe Load Lab — Report Comparison & Regression Gate'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(`Baseline (A): ${chalk.cyan(s1.testName || 'Test A')} (${s1.startedAt || 'N/A'})`);
  console.log(`Current  (B): ${chalk.cyan(s2.testName || 'Test B')} (${s2.startedAt || 'N/A'})\n`);

  const rows = [];
  const compare = (label, val1, val2, unit = '', lower = true) => {
    const v1 = Number(val1 || 0);
    const v2 = Number(val2 || 0);
    const diff = v2 - v1;
    const pct = v1 ? Number(((diff / v1) * 100).toFixed(2)) : (v2 ? 100 : 0);
    const better = lower ? (diff <= 0) : (diff >= 0);
    const icon = diff === 0 ? '=' : better ? chalk.green('✅') : chalk.yellow('⚠️ ');
    const sign = diff > 0 ? '+' : '';
    console.log(`${icon} ${label.padEnd(16)} ${chalk.white(v1.toFixed(2) + unit)} → ${chalk.white(v2.toFixed(2) + unit)} (${sign}${pct}%)`);
    rows.push({ label, val1: `${v1.toFixed(2)}${unit}`, val2: `${v2.toFixed(2)}${unit}`, diff: `${sign}${pct}%`, better });
  };

  compare('Requests', s1.totals?.requests, s2.totals?.requests, '', false);
  compare('Failed', s1.totals?.failed, s2.totals?.failed, '', true);
  compare('Error Rate', (s1.totals?.errorRate || 0) * 100, (s2.totals?.errorRate || 0) * 100, '%', true);
  compare('Achieved RPS', s1.totals?.achievedRps, s2.totals?.achievedRps, '', false);
  compare('Avg Latency', s1.latencyMs?.avg, s2.latencyMs?.avg, 'ms', true);
  compare('p95 Latency', s1.latencyMs?.p95, s2.latencyMs?.p95, 'ms', true);
  compare('p99 Latency', s1.latencyMs?.p99, s2.latencyMs?.p99, 'ms', true);

  const p95DiffPct = s1.latencyMs?.p95 ? Number((((s2.latencyMs.p95 - s1.latencyMs.p95) / s1.latencyMs.p95) * 100).toFixed(2)) : 0;
  const errorRateDiff = Number((((s2.totals?.errorRate || 0) - (s1.totals?.errorRate || 0)) * 100).toFixed(2));

  let isRegression = false;
  let regressionReason = '';
  if (p95DiffPct > maxLatencyDiff) {
    isRegression = true;
    regressionReason = `p95 Latency degraded by ${p95DiffPct}% (allowed threshold: ${maxLatencyDiff}%)`;
  } else if (errorRateDiff > maxErrorDiff) {
    isRegression = true;
    regressionReason = `Error rate increased by ${errorRateDiff}% (allowed threshold: ${maxErrorDiff}%)`;
  }

  console.log(chalk.gray('─'.repeat(60)));
  if (isRegression) {
    console.log(chalk.bold.red(`❌ PERFORMANCE REGRESSION DETECTED: ${regressionReason}\n`));
  } else {
    console.log(chalk.bold.green(`✅ Comparison Passed: No regression detected (within tolerance).\n`));
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const summaryMd = [
        '### 🔍 Safe Load Lab Performance Regression Gate',
        `**Status**: ${isRegression ? '❌ **Failed** - Regression Detected' : '✅ **Passed** - Within Tolerances'}`,
        isRegression ? `> **Violation**: ${regressionReason}` : '',
        '',
        '| Metric | Baseline (A) | Current (B) | Delta | Status |',
        '|--------|--------------|-------------|-------|--------|',
        ...rows.map(r => `| ${r.label} | ${r.val1} | ${r.val2} | ${r.diff} | ${r.better ? '✅' : '⚠️'} |`),
        ''
      ].filter(Boolean).join('\n');
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n' + summaryMd + '\n');
    } catch (_) {}
  }

  return { isRegression, regressionReason, p95DiffPct, errorRateDiff };
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

async function runCapacityTest(args) {
  if (!args.url && !args.config && !args.curl) {
    throw new Error('capacity requires --url <url>, --config <file>, or --curl "<command>"');
  }

  const slaMs = Number(args.sla || args['sla-ms'] || args.targetSla || 200);
  const maxErrorRate = Number(args['max-error'] || args['max-error-rate'] || args.maxFailureRate || 0.01);
  const stepDuration = Number(args['step-duration'] || args.stepDuration || 5);
  const startRps = Math.max(5, Number(args['start-rps'] || args.startRps || 10));
  const maxCapRps = Math.min(Number(args['max-rps'] || args.maxRps || 200), HARD_LIMITS.maxRps);
  const stepIncrement = Number(args['step-increment'] || args.stepIncrement || 0);
  const concurrencyRatio = Number(args['concurrency-ratio'] || args.concurrencyRatio || 0.5);

  console.log(chalk.bold.cyan('\n============================================================'));
  console.log(chalk.bold.cyan('     ⚡ SAFE LOAD LAB — AUTONOMOUS CAPACITY DISCOVERY       '));
  console.log(chalk.bold.cyan('============================================================\n'));
  console.log(`Target:           ${chalk.white(args.url || args.config || 'Target Endpoint')}`);
  console.log(`SLA Limit (p95):  ${chalk.yellow(slaMs + 'ms')}`);
  console.log(`Max Error Rate:   ${chalk.yellow((maxErrorRate * 100).toFixed(1) + '%')}`);
  console.log(`Step Duration:    ${chalk.white(stepDuration + 's per probe')}`);
  console.log(`Probe Range:      ${chalk.white(startRps + ' RPS → ' + maxCapRps + ' RPS')}\n`);

  const rpsSteps = [];
  let curr = startRps;
  while (curr <= maxCapRps) {
    rpsSteps.push(curr);
    if (stepIncrement > 0) curr += stepIncrement;
    else if (curr < 25) curr += 15;
    else if (curr < 100) curr += 25;
    else curr += 50;
  }
  if (!rpsSteps.includes(maxCapRps)) rpsSteps.push(maxCapRps);

  const matrix = [];
  let sweetSpotRps = 0;
  let kneeRps = null;
  let breakingRps = null;
  let stopReason = null;
  let prevP95 = 0;
  let baseSlope = null;

  for (let i = 0; i < rpsSteps.length; i++) {
    const targetRps = rpsSteps[i];
    const targetConcurrency = Math.max(2, Math.min(Math.ceil(targetRps * concurrencyRatio), HARD_LIMITS.maxConcurrency));

    console.log(chalk.bold.blue(`▶ Step ${i + 1}/${rpsSteps.length}: Probing ${targetRps} RPS (concurrency: ${targetConcurrency}) ...`));

    const stepConfig = normalizeConfig({
      ...args,
      duration: stepDuration,
      concurrency: targetConcurrency,
      rps: targetRps,
      thresholds: {}
    });

    const { summary } = await runTest(stepConfig);

    const achievedRps = summary.totals.achievedRps;
    const errorRate = summary.totals.errorRate;
    const avgMs = summary.latencyMs.avg;
    const p95Ms = summary.latencyMs.p95;
    const p99Ms = summary.latencyMs.p99;
    const failed = summary.totals.failed;
    const total = summary.totals.requests;

    let slope = 0;
    if (i > 0 && achievedRps > matrix[i - 1].achievedRps) {
      slope = (p95Ms - matrix[i - 1].p95Ms) / (achievedRps - matrix[i - 1].achievedRps);
      if (baseSlope === null && slope > 0) baseSlope = slope;
    }

    const stepRecord = {
      step: i + 1,
      targetRps,
      concurrency: targetConcurrency,
      achievedRps: Number(achievedRps.toFixed(1)),
      total,
      failed,
      errorRate: Number((errorRate * 100).toFixed(2)),
      avgMs: Number(avgMs.toFixed(1)),
      p95Ms: Number(p95Ms.toFixed(1)),
      p99Ms: Number(p99Ms.toFixed(1)),
      slope: Number(slope.toFixed(2)),
      status: 'OK'
    };

    const errorBreached = errorRate > maxErrorRate;
    const slaBreached = p95Ms > slaMs;
    const severeBreach = p95Ms > slaMs * 2.5;

    if (!kneeRps && baseSlope !== null && slope > baseSlope * 2.5 && p95Ms > prevP95 * 1.5) {
      kneeRps = targetRps;
      stepRecord.status = 'KNEE';
    }

    if (!errorBreached && !slaBreached) {
      sweetSpotRps = targetRps;
    }

    if (errorBreached || severeBreach) {
      breakingRps = targetRps;
      stepRecord.status = errorBreached ? 'ERRORS' : 'SATURATED';
      stopReason = errorBreached
        ? `Error rate ${(errorRate * 100).toFixed(1)}% exceeded allowed limit of ${(maxErrorRate * 100).toFixed(1)}%`
        : `p95 Latency ${p95Ms.toFixed(1)}ms exceeded severe threshold (2.5x SLA)`;
      matrix.push(stepRecord);
      break;
    }

    if (slaBreached) {
      stepRecord.status = 'DEGRADED';
    }

    matrix.push(stepRecord);
    prevP95 = p95Ms;
  }

  console.log(chalk.bold('\n📊 Capacity Discovery Matrix'));
  console.log(chalk.gray('─'.repeat(75)));
  console.log(
    'Step'.padEnd(6) +
    'Target RPS'.padEnd(12) +
    'Achieved'.padEnd(11) +
    'p95 Latency'.padEnd(14) +
    'Error Rate'.padEnd(13) +
    'Status'.padEnd(10)
  );
  console.log(chalk.gray('─'.repeat(75)));

  for (const m of matrix) {
    const statusColor = m.status === 'OK' ? chalk.green :
                        m.status === 'KNEE' ? chalk.cyan :
                        m.status === 'DEGRADED' ? chalk.yellow : chalk.red;
    console.log(
      `#${m.step}`.padEnd(6) +
      `${m.targetRps}`.padEnd(12) +
      `${m.achievedRps}`.padEnd(11) +
      `${m.p95Ms}ms`.padEnd(14) +
      `${m.errorRate}%`.padEnd(13) +
      statusColor.bold(m.status)
    );
  }
  console.log(chalk.gray('─'.repeat(75)));

  const recProductionRps = Math.max(sweetSpotRps, matrix[0]?.achievedRps || 0);
  const recommendation = `Target safely handles up to ${recProductionRps} RPS with p95 < ${slaMs}ms. Sizing recommendation: set production autoscaling threshold to ${Math.round(recProductionRps * 0.8)} RPS (80% headroom).`;

  console.log(chalk.bold.green('\n🎯 Capacity Findings & Production Sizing:'));
  console.log(`  • ${chalk.bold('Sweet Spot (Max Sustainable)')}: ${chalk.green.bold(sweetSpotRps + ' RPS')}`);
  if (kneeRps) {
    console.log(`  • ${chalk.bold('Queueing Knee Point')}:           ${chalk.yellow.bold(kneeRps + ' RPS')} (latency growth accelerates)`);
  }
  if (breakingRps) {
    console.log(`  • ${chalk.bold('Breaking Point')}:                ${chalk.red.bold(breakingRps + ' RPS')} (${stopReason})`);
  }
  console.log(`  • ${chalk.bold('Recommendation')}:                ${chalk.white(recommendation)}\n`);

  const safeHeadroom = Math.round(recProductionRps * 0.8);

  return {
    target: args.url || args.config || 'target',
    slaMs,
    targetSlaMs: slaMs,
    maxErrorRate,
    sweetSpotRps,
    safeHeadroomRps: safeHeadroom,
    saturationKneeRps: kneeRps,
    breakingPointRps: breakingRps,
    kneeRps,
    breakingRps,
    stopReason,
    reason: stopReason || 'Completed within SLA threshold',
    recommendation,
    matrix,
    steps: matrix,
    timestamp: new Date().toISOString()
  };
}

function generateCapacityMarkdownReport(cap) {
  return `# ⚡ Safe Load Lab — Capacity Discovery Report

**Target**: ${cap.target}  
**Date**: ${cap.timestamp}  
**SLA Target (p95)**: ${cap.slaMs}ms  
**Allowed Error Rate**: ${(cap.maxErrorRate * 100).toFixed(1)}%  

## Executive Sizing Recommendation
> **${cap.recommendation}**

- **Optimal Sustainable Load (Sweet Spot)**: **${cap.sweetSpotRps} RPS**
${cap.kneeRps ? `- **Queueing Inflection / Knee Point**: **${cap.kneeRps} RPS**\n` : ''}${cap.breakingRps ? `- **Breaking / Saturation Point**: **${cap.breakingRps} RPS** (${cap.stopReason})\n` : ''}
## Capacity Step Matrix

| Step | Target RPS | Concurrency | Achieved RPS | Avg Latency | p95 Latency | p99 Latency | Error Rate | Status |
|------|------------|-------------|--------------|-------------|-------------|-------------|------------|--------|
${cap.matrix.map(m => `| #${m.step} | ${m.targetRps} | ${m.concurrency} | ${m.achievedRps} | ${m.avgMs}ms | ${m.p95Ms}ms | ${m.p99Ms}ms | ${m.errorRate}% | **${m.status}** |`).join('\n')}

---
*Generated by Safe Load Lab Autonomous Capacity Engine*
`;
}

function writeCapacityHtmlReport(filePath, cap) {
  ensureDirFor(filePath);
  const rows = cap.matrix.map(m => {
    const cls = m.status === 'OK' ? 'pass' : m.status === 'DEGRADED' || m.status === 'KNEE' ? 'warn' : 'fail';
    return `<tr>
      <td>#${m.step}</td>
      <td>${m.targetRps}</td>
      <td>${m.concurrency}</td>
      <td>${m.achievedRps}</td>
      <td>${m.avgMs}ms</td>
      <td>${m.p95Ms}ms</td>
      <td>${m.p99Ms}ms</td>
      <td>${m.errorRate}%</td>
      <td><span class="badge ${cls}">${m.status}</span></td>
    </tr>`;
  }).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Capacity Discovery - Safe Load Lab</title><style>
    body{font-family:Inter,-apple-system,sans-serif;margin:0;background:#090d16;color:#f8fafc}
    main{max-width:1100px;margin:0 auto;padding:32px 20px}
    .header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1e293b;padding-bottom:16px;margin-bottom:24px}
    .brand{font-size:20px;font-weight:800;color:#06b6d4}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
    .card{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:20px}
    .metric{font-size:32px;font-weight:800;color:#38bdf8}
    .label{font-size:12px;color:#94a3b8;text-transform:uppercase;margin-top:4px}
    .alert-box{background:rgba(6,182,212,0.1);border-left:4px solid #06b6d4;padding:16px;border-radius:6px;margin-bottom:24px;font-size:15px;line-height:1.5}
    table{width:100%;border-collapse:collapse;background:#0f172a;border-radius:10px;overflow:hidden;border:1px solid #1e293b}
    th,td{padding:12px 14px;border-bottom:1px solid #1e293b;text-align:left;font-size:13px}
    th{background:#131c31;color:#94a3b8;font-size:11px;text-transform:uppercase}
    .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700}
    .pass{background:rgba(16,185,129,0.15);color:#10b981}
    .warn{background:rgba(245,158,11,0.15);color:#f59e0b}
    .fail{background:rgba(239,68,68,0.15);color:#ef4444}
  </style></head><body><main>
    <div class="header">
      <div class="brand">⚡ Safe Load Lab — Capacity Discovery</div>
      <div style="font-family:monospace;color:#94a3b8;">${htmlEscape(cap.target)}</div>
    </div>
    <div class="alert-box">
      <strong>🎯 Production Sizing Recommendation:</strong><br>${htmlEscape(cap.recommendation)}
    </div>
    <div class="grid">
      <div class="card"><div class="metric">${cap.sweetSpotRps} RPS</div><div class="label">Sweet Spot (Max Sustainable)</div></div>
      <div class="card"><div class="metric">${cap.kneeRps ? cap.kneeRps + ' RPS' : 'None'}</div><div class="label">Knee / Queueing Inflection</div></div>
      <div class="card"><div class="metric" style="color:${cap.breakingRps ? '#ef4444' : '#10b981'};">${cap.breakingRps ? cap.breakingRps + ' RPS' : 'None'}</div><div class="label">Breaking Point</div></div>
      <div class="card"><div class="metric">${cap.slaMs}ms</div><div class="label">SLA Target (p95)</div></div>
    </div>
    <h2>Step-by-Step Probe Matrix</h2>
    <table>
      <thead>
        <tr><th>Step</th><th>Target RPS</th><th>Concurrency</th><th>Achieved RPS</th><th>Avg Latency</th><th>p95 Latency</th><th>p99 Latency</th><th>Error Rate</th><th>Status</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </main></body></html>`;
  fs.writeFileSync(filePath, html);
}

async function saveCapacityReports(args, cap) {
  const defaultOut = `reports/capacity-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const out = args.out || defaultOut;
  ensureDirFor(out);
  fs.writeFileSync(out, JSON.stringify(cap, null, 2));
  console.log(chalk.green(`✓ Capacity JSON report saved: ${out}`));

  if (args.html) {
    writeCapacityHtmlReport(args.html, cap);
    console.log(chalk.green(`✓ Capacity HTML report saved: ${args.html}`));
  }
  if (args.markdown || args.md) {
    const mdPath = args.markdown || args.md;
    ensureDirFor(mdPath);
    fs.writeFileSync(mdPath, generateCapacityMarkdownReport(cap));
    console.log(chalk.green(`✓ Capacity Markdown report saved: ${mdPath}`));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const summaryMd = generateCapacityMarkdownReport(cap);
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n' + summaryMd + '\n');
    } catch (_) {}
  }
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
  if (command === 'compare' || command === 'diff' || command === 'check-regression') {
    const file1 = args._[1] || args.baseline;
    const file2 = args._[2] || args.current;
    if (!file1 || !file2) throw new Error(`${command} requires two report files: sll ${command} <baseline.json> <current.json>`);
    const diffResult = compareReports(file1, file2, args);
    if (diffResult.isRegression) process.exitCode = 1;
    return;
  }
  if (command === 'ui' || command === 'studio') {
    const port = Number(args.port || process.env.PORT || 3001);
    process.env.PORT = String(port);
    const uiServerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'server.js');
    const { default: app } = await import(pathToFileURL(uiServerPath).href);
    const srv = app.listen(port, () => {
      console.log(chalk.bold.green(`✓ Safe Load Lab Studio running on http://localhost:${port}`));
      console.log(chalk.gray('  Interactive visual workspace for scenario builder, live telemetry, and exports.'));
      console.log(chalk.gray('  Press Ctrl+C to stop.\n'));
    });
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nStopping Studio server...'));
      srv.close(() => process.exit(0));
    });
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
  if (command === 'import-postman') {
    const file = args._[1] || args.file;
    if (!file) throw new Error('import-postman requires a JSON file path: sll import-postman <file.json>');
    const content = fs.readFileSync(file, 'utf8');
    const configOut = parsePostmanCollection(content, args);
    if (args.out) {
      ensureDirFor(args.out);
      fs.writeFileSync(args.out, JSON.stringify(configOut, null, 2));
      console.log(chalk.green(`✓ Converted Postman Collection to ${args.out} (${configOut.endpoints.length} endpoints)`));
    } else {
      console.log(JSON.stringify(configOut, null, 2));
    }
    return;
  }
  if (command === 'import-openapi' || command === 'import-swagger') {
    const file = args._[1] || args.file;
    if (!file) throw new Error('import-openapi requires an OpenAPI/Swagger JSON file path: sll import-openapi <file.json>');
    const content = fs.readFileSync(file, 'utf8');
    const configOut = parseOpenApiSpec(content, args);
    if (args.out) {
      ensureDirFor(args.out);
      fs.writeFileSync(args.out, JSON.stringify(configOut, null, 2));
      console.log(chalk.green(`✓ Converted OpenAPI Spec to ${args.out} (${configOut.endpoints.length} endpoints)`));
    } else {
      console.log(JSON.stringify(configOut, null, 2));
    }
    return;
  }
  if (command === 'import-har') {
    const file = args._[1] || args.file;
    if (!file) throw new Error('import-har requires a HAR file path: sll import-har <file.har>');
    const content = fs.readFileSync(file, 'utf8');
    const configOut = parseHarRecording(content, args);
    if (args.out) {
      ensureDirFor(args.out);
      fs.writeFileSync(args.out, JSON.stringify(configOut, null, 2));
      console.log(chalk.green(`✓ Converted HAR recording to ${args.out} (${configOut.endpoints.length} endpoints)`));
    } else {
      console.log(JSON.stringify(configOut, null, 2));
    }
    return;
  }
  if (command === 'export-k6') {
    const file = args._[1] || args.config || args.file;
    if (!file) throw new Error('export-k6 requires a config file: sll export-k6 <config.json>');
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    const k6Script = exportToK6(content);
    if (args.out) {
      ensureDirFor(args.out);
      fs.writeFileSync(args.out, k6Script);
      console.log(chalk.green(`✓ Exported k6 script to ${args.out}`));
    } else {
      console.log(k6Script);
    }
    return;
  }
  if (command === 'export-postman') {
    const file = args._[1] || args.config || args.file;
    if (!file) throw new Error('export-postman requires a config file: sll export-postman <config.json>');
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    const postmanJson = exportToPostman(content);
    if (args.out) {
      ensureDirFor(args.out);
      fs.writeFileSync(args.out, postmanJson);
      console.log(chalk.green(`✓ Exported Postman Collection to ${args.out}`));
    } else {
      console.log(postmanJson);
    }
    return;
  }
  if (command === 'probe' || command === 'ping') {
    let ep;
    if (args.curl) {
      ep = parseCurlCommand(args.curl);
    } else if (args.config) {
      const cfg = JSON.parse(fs.readFileSync(args.config, 'utf8'));
      ep = cfg.endpoints?.[0];
      if (!ep) throw new Error('Config contains no endpoints to probe');
      ep.variables = cfg.variables || {};
    } else if (args.url) {
      ep = { url: args.url, method: args.method || 'GET', headers: parseHeaders(args.header), body: args.body };
    } else {
      throw new Error('probe requires --url <url>, --config <file>, or --curl "<command>"');
    }
    const result = await probeEndpoint(ep, args.timeout ? Number(args.timeout) : 10000);
    printProbeResult(result);
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (command === 'ci') {
    const type = args.type || args._[1] || 'github';
    const yaml = generateCiWorkflow(type, args);
    if (args.out) {
      ensureDirFor(args.out);
      fs.writeFileSync(args.out, yaml);
      console.log(chalk.green(`✓ Generated ${type} CI workflow in ${args.out}`));
    } else {
      console.log(yaml);
    }
    return;
  }
  if (!args['i-own-this-target']) throw new Error('Missing required safety flag: --i-own-this-target');
  if (command === 'bench' || command === 'quick') {
    const targetUrl = args._[1] || args.url;
    if (!targetUrl) throw new Error('bench requires a target URL: sll bench <url> --i-own-this-target');
    args.url = targetUrl;
    args.duration = args.duration || 10;
    args.concurrency = args.concurrency || 5;
    args.rps = args.rps || 10;
    const config = normalizeConfig(args);
    const { summary, results } = await runTest(config);
    printSummary(summary);
    await saveReports(args, summary, results);
    if (Object.values(summary.thresholds || {}).some(v => !v.pass)) process.exitCode = 2;
    return;
  }
  if (command === 'ab' || command === 'diff') {
    const { diff } = await runAbTest(args);
    if (diff.isRegression) process.exitCode = 2;
    return;
  }
  if (command === 'rate-limit') { await runRateLimitCheck(args); return; }
  if (command === 'capacity' || command === 'break') {
    const capacityResult = await runCapacityTest(args);
    await saveCapacityReports(args, capacityResult);
    return;
  }
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
  if (args.prometheus) {
    const prom = generatePrometheusMetrics(summary, results);
    ensureDirFor(args.prometheus);
    fs.writeFileSync(args.prometheus, prom);
    console.log(chalk.green(`✓ Prometheus metrics saved: ${args.prometheus}`));
  }
  if (args.badge) {
    const badgeSvg = generateSvgBadge(summary);
    ensureDirFor(args.badge);
    fs.writeFileSync(args.badge, badgeSvg);
    console.log(chalk.green(`✓ Status badge saved: ${args.badge}`));
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
  parseArgs,
  parsePostmanCollection,
  parseOpenApiSpec,
  generatePrometheusMetrics,
  generateSvgBadge,
  loadEnvFile,
  parseCsvData,
  probeEndpoint,
  generateCiWorkflow,
  parseHarRecording,
  exportToK6,
  exportToPostman,
  resolveDynamicGenerator,
  setHighCapacityMode,
  compareReports,
  generateSparkline,
  computeLatencyDistribution,
  generateTrafficProfile,
  runCapacityTest,
  generateCapacityMarkdownReport,
  writeCapacityHtmlReport,
  saveCapacityReports,
  writeHtmlReport
};

