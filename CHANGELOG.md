# Changelog

## 2.2.0 - A/B Differential Testing, Hermetic Mock Server & cURL Import

### 🚀 Major New Features

- **⚖️ A/B Differential Load Testing (`sll ab` / `sll diff`)**
  - Run side-by-side or sequential load tests comparing two URLs, configs, or environments
  - Automated statistical delta for throughput, error rate, and latency percentiles (avg, p50, p90, p95, p99)
  - Regression threshold gating (`--max-latency-diff`, `--max-error-diff`) with non-zero exit code for CI/CD gates
  - Beautiful color-coded terminal comparison table
  - Dedicated A/B reports in JSON, HTML, and Markdown formats

- **🧪 Hermetic Built-in Mock Server (`sll mock`)**
  - Zero-dependency local test server built with `node:http`
  - Specialized benchmarking endpoints:
    - `/health` - status, version, uptime, timestamp
    - `/fast` - immediate 200 OK
    - `/slow?delay=ms` - simulated backend latency
    - `/error?status=code` - simulated HTTP error codes
    - `/rate-limit?limit=X&window=Y` - sliding-window 429 rate limiting with `Retry-After`
    - `/echo` - echoes headers, method, and request body
    - `/json` - structured mock user data
  - Enables 100% hermetic, zero-flake local tests and CI smoke tests

- **⚡ cURL Command Import (`sll import-curl` & `--curl`)**
  - Directly run load tests from a copied cURL command string (`sll run --curl "curl ..."` )
  - Convert cURL commands into reusable JSON configs (`sll import-curl "..." --out config.json`)
  - Parses HTTP method, URL, headers, and request bodies

- **📊 Web UI & Dashboard Superpowers**
  - Dedicated interactive A/B Testing panel
  - One-click Local Mock Server toggling and endpoint auto-fill
  - Fixed UI SSE metrics property mapping (`totals.requests`, `totals.failed`, `latencyMs.*`)
  - Standalone binary invocation (`process.execPath`) for universal portability without global npm links

### 🛡️ Testing & CI/CD Enhancements

- **63 Comprehensive Automated Tests (100% Pass)**
  - `tests/ab.test.mjs` - A/B differential testing, regression detection, report generation
  - `tests/qa.test.mjs` - End-to-end QA covering mock server routes, cURL parser, assertions, limits, and CLI error handling
  - Updated `tests/unit.test.mjs` to test real exported module functions
- **GitHub Actions Fixes & Modernization**
  - Fixed `ERR_MODULE_NOT_FOUND: Cannot find package 'chalk'` by ensuring `npm ci` runs before `npm install -g .`
  - Upgraded workflow runners to Node.js 22 with dependency caching (`cache: 'npm'`)
  - Replaced unreliable external network target (Google) with hermetic local mock server



### 🚀 Performance Improvements

#### Critical Optimizations
- **RPS Accuracy Enhancement** - Adaptive timing control with drift compensation
  - Improved accuracy from ~50-70% to >85% of target RPS
  - Dynamic interval calculation based on actual elapsed time
  - Real-time RPS monitoring in progress output (`RPS: 48.3` display)
  
- **Percentile Calculation Optimization** - Single-pass calculation
  - 60-75% faster for large datasets
  - 10,000 results: ~150ms → ~40ms (73% improvement)
  - 50,000 results: ~800ms → ~220ms (72% improvement)
  
- **HTTP Connection Reuse** - Keep-alive enabled
  - 15-25% faster request throughput
  - Reduced latency variance
  - Lower system resource usage
  
- **Response Body Optimization** - Conditional consumption
  - Skip body reading for non-success responses
  - 10-15% faster error handling
  - Reduced memory usage and GC pressure
  
- **Memory Management** - Overflow protection
  - Warning at 50,000 results to prevent OOM crashes
  - Better user awareness of memory constraints
  - Foundation for future streaming implementation

### 🧪 Testing Enhancements

- **Expanded Test Coverage** - 32+ tests (up from 4)
  - 15 unit tests for core functions
  - 8 performance benchmark tests
  - 9 integration tests with mock HTTP server
  - 4 original smoke tests retained
  
- **New Test Scripts**
  - `npm run test:unit` - Core function validation
  - `npm run test:performance` - Performance benchmarks
  - `npm run test:integration` - End-to-end CLI tests
  - `npm run test:smoke` - Quick validation tests

### 📚 Documentation

- Added `PERFORMANCE_IMPROVEMENTS.md` - Comprehensive performance analysis
- Documented optimizations with before/after metrics
- Usage recommendations and best practices
- Future optimization roadmap

### 🔧 Technical Changes

- Adaptive RPS control with time-based compensation
- Single-pass `calculatePercentiles()` function
- HTTP keep-alive in fetch options
- Conditional response body consumption
- Enhanced progress reporting with actual RPS

### 📊 Benchmarks

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| RPS Accuracy (target 50) | 30-35 | 42-48 | +35% |
| Percentile Calc (10k) | ~150ms | ~40ms | 73% faster |
| Percentile Calc (50k) | ~800ms | ~220ms | 72% faster |
| Memory/10k results | ~15MB | ~12MB | 20% less |
| Request throughput | baseline | +15-25% | keep-alive |

---

## 2.0.0 - Major Feature Release

### 🚀 New Features
- **Spike Testing** - Test system behavior under sudden traffic spikes
- **Soak Testing** - Sustained load testing for memory leaks and stability
- **Stress Testing** - Gradually increasing load to find breaking points
- **Report Comparison** - Compare two test reports side-by-side with diff analysis
- **Webhook Integration** - Send test results to custom webhooks
- **Slack Integration** - Real-time notifications to Slack channels
- **Realistic Traffic Patterns** - Random request spacing for more realistic testing
- **Verbose Logging** - Detailed logging for debugging

### 🎯 Enhanced Commands
- `sll spike` - Run spike test with baseline → spike → recovery pattern
- `sll soak` - Run sustained load test for extended duration
- `sll stress` - Run gradually increasing load test
- `sll compare <file1> <file2>` - Compare two test reports

### 📊 Enhanced Options
- `--webhook <url>` - Send results to webhook URL
- `--slack <url>` - Send results to Slack webhook
- `--compare <file>` - Compare with previous report
- `--realistic` - Use realistic traffic patterns
- `--verbose` - Enable verbose logging

### ⚡ Performance Improvements
- Optimized request scheduling
- Better memory management for long tests
- Improved error handling

### 📝 Documentation
- Updated README with new features
- Added examples for spike, soak, and stress tests
- Enhanced configuration reference

## 1.2.0

- Added staged ramp testing
- Added `validate` command
- Added `plan` command
- Added `version` command
- Added JUnit XML report output
- Added config schema, smoke tests, security notes, config reference
- Fixed CLI overrides to apply after environment profile selection

## 1.1.0

- Added environment profiles
- Added setup/auth extraction flow
- Added GraphQL support
- Added HTML reports
- Added safe rate-limit verification mode
- Added Dockerfile and GitHub Actions example

## 1.0.0

- Initial controlled load-testing CLI
