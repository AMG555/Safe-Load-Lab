# Safe Load Lab

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.4.0-blue.svg)](https://github.com/AMG555/Safe-Load-Lab/releases)
[![CI](https://github.com/AMG555/Safe-Load-Lab/actions/workflows/safe-load-lab.yml/badge.svg)](https://github.com/AMG555/Safe-Load-Lab/actions/workflows/safe-load-lab.yml)
[![Tests: 124 Passing](https://img.shields.io/badge/tests-124%20passing-brightgreen.svg)](https://github.com/AMG555/Safe-Load-Lab)

A production-ready, feature-rich CLI for **controlled load testing**, **autonomous capacity discovery**, **A/B differential benchmarking**, and **performance regression detection** of applications you own or have explicit permission to test.

This is **not** a DDoS tool. It is designed for safe capacity, performance, rate-limit, auth-flow, GraphQL, and resilience testing with built-in safety limits and ethical use guidelines.

## 🚀 What's New in v2.4.0

- 🏥 **Automated SRE Root-Cause Bottleneck Diagnosis Engine (`sll diagnose` / `sll blame`)**: Automated root-cause blame for endpoint latency mass drag, temporal cold-start vs cascading resource leaks, tail amplification divergence ($p_{95}/p_{50} \ge 4.0$), and proxy timeout errors with a 0–100 health score.
- 🔄 **OpenAPI Intelligent CRUD Journey Flow Generator (`sll autogen-flow` / `sll generate-journey`)**: Synthesizes production-ready multi-step scenario journey configs with dynamic variable extraction (`{{id}}`) and assertion chains directly from OpenAPI/Swagger specs.
- ⚡ **Autonomous Capacity Discovery (`sll capacity` / `sll break`)**: Automated stepped-ladder ramp algorithm finds breaking points, saturation knee, sweet spot RPS, and computes recommended 80% safe headroom for autoscaling sizing.
- 🌊 **Traffic Shaping Waveforms**: Shape realistic traffic profiles using `sine` (sinusoidal diurnal wave), `ladder` (stepped with cooldown), `burst` (periodic spikes on baseline), or `constant`.
- 📊 **HDR Latency Histograms & Statistical Anomaly Detection**: 8 logarithmic latency buckets with automated detection of tail divergence ($p_{95}/p_{50} \ge 3.5$) and bimodal distributions.
- 💥 **Chaos Engineering & Dynamic Mock Routes**: Hermetic mock server extended with `/chaos` (configurable failure rate & delay jitter), `/slow-stream` (chunked streaming), and runtime `/mock/routes` CRUD API.
- 📑 **Zero-Dependency Executive HTML Reports**: Self-contained dark-mode report with embedded pure-SVG percentile progression curves and HDR histogram charts.
- 🎨 **Visual Multi-Step Scenario Journey Flow Builder**: Interactive visual step sequence editor in Studio UI with response variable extraction and assertion chaining.
- 🛡️ **124 Automated Quality Tests**: 100% passing test coverage across Unit, Integration, Performance, Smoke, A/B, UI Server, and QA suites.

## 🎯 Why Safe Load Lab?

- **Zero-Friction Sandbox** - Built-in mock server with chaos injection means instant testing without external dependencies
- **Autonomous Capacity Sizing** - Discovers maximum sustainable RPS and safe autoscaling headroom automatically
- **A/B Regression Gate** - Catch latency degradation in PRs before shipping to production
- **cURL Native** - Copy request as cURL from Chrome DevTools and run a load test in seconds
- **Production-Ready** - Used by developers and QA engineers for controlled load testing
- **Feature-Rich** - Capacity, spike, soak, stress, A/B tests, webhooks, Slack alerts, assertions, and retries
- **Safe by Design** - Hard-coded safety limits prevent accidental abuse
- **Developer-Friendly** - Beautiful colored CLI, JSON configs, standalone SVG HTML reports, and Web UI

## Features

- ✅ **Autonomous Capacity Discovery** - Automated breaking point detection and production sizing
- ✅ **Traffic Shaping Waveforms** - Sinusoidal diurnal waves, stepped ladders, and periodic bursts
- ✅ **HDR Latency Histogram & Anomalies** - 8 logarithmic buckets with tail divergence and bimodal detection
- ✅ **A/B Differential Testing** - Automated side-by-side endpoint comparison with regression alerts
- ✅ **Hermetic Mock Server & Chaos** - Zero-dependency local test server with `/chaos`, `/slow-stream`, and dynamic routes
- ✅ **Executive HTML Reports** - Zero-dependency dark-mode reports with embedded SVG charts
- ✅ **Visual Scenario Journey Flow** - Multi-step request chaining with JSONPath variable extraction
- ✅ **cURL Command Import** - Run tests directly from cURL commands
- ✅ **Controlled Load Testing** - Configurable concurrency, RPS, and duration with hard safety limits
- ✅ **Staged Testing** - Warm-up, steady-state, and cool-down phases
- ✅ **Spike Testing** - Test system behavior under sudden traffic increases
- ✅ **Soak Testing** - Sustained load for stability and memory leak detection
- ✅ **Stress Testing** - Gradually increasing load to find breaking points
- ✅ **Auth Flow Testing** - Setup requests with token extraction
- ✅ **GraphQL Support** - Native GraphQL endpoint testing
- ✅ **Rate-Limit Verification** - Safe verification of rate-limiting behavior
- ✅ **Environment Profiles** - Different configurations for local, staging, production
- ✅ **Report Comparison** - Side-by-side comparison of test runs
- ✅ **Webhook Integration** - Send results to custom webhooks
- ✅ **Slack Notifications** - Real-time test results in Slack
- ✅ **Multiple Report Formats** - JSON, CSV, HTML, Markdown, and JUnit XML reports
- ✅ **Interactive Web UI Studio** - Modern dashboard for visual test management and dynamic routes
- ✅ **Docker Support** - Containerized testing environment
- ✅ **CI/CD Ready** - Hermetic CI workflow with exit codes suitable for automation


## Quick Links

- 📖 [Quick Start Guide](QUICK_START.md) - Get started in 5 minutes
- 🚀 [Features Guide](FEATURES.md) - Comprehensive feature documentation
- 🗺️ [Roadmap](ROADMAP.md) - Future plans and feature requests
- 🛠️ [Setup Guide](SETUP.md) - Detailed installation and troubleshooting
- ⚙️ [Configuration Reference](CONFIG_REFERENCE.md) - Complete config options
- 🤝 [Contributing](CONTRIBUTING.md) - How to contribute
- 💬 [Support](SUPPORT.md) - Get help

## Requirements

- Node.js 18+ (Node.js 20 LTS recommended)

## Installation

### Global Installation

```bash
npm install -g safe-load-lab
```

Then use either command:

```bash
safe-load-lab help
sll help
```

### Local Installation

```bash
npm install safe-load-lab
npx safe-load-lab help
npx sll help
```

## Quick Start

### One-Command Test

```bash
sll run \
  --url http://localhost:3000/api/health \
  --duration 30 \
  --concurrency 5 \
  --rps 10 \
  --i-own-this-target
```

### Config-Based Test

```bash
# Create a sample config
sll sample --out load-test.json

# Edit the config file, then run:
sll run --config load-test.json --i-own-this-target
```

### Validate Before Running

```bash
# Validate config without sending traffic
sll validate --config examples/advanced.json --env local

# Preview the test plan without sending traffic
sll plan --config examples/advanced.json --env local
```

## Commands

| Command | Description |
|---------|-------------|
| `diagnose`, `blame` | Automated SRE root-cause bottleneck diagnosis & 0–100 health scoring for test reports |
| `autogen-flow`, `generate-journey` | Synthesize complete CRUD lifecycle journey scenarios from OpenAPI/Swagger spec |
| `capacity`, `break` | Autonomous breaking point discovery with 80% safe headroom production sizing |
| `bench`, `quick` | Run instant zero-config micro-benchmark on single endpoint |
| `run` | Run a controlled load test |
| `probe`, `ping` | Send a single preflight probe request to verify endpoint status, latency, and assertions |
| `ci` | Generate ready-to-use CI/CD workflow (`github` or `gitlab`) |
| `ab`, `diff` | Run differential A/B benchmark comparing two endpoints or config profiles |
| `mock` | Start local hermetic mock server with `/chaos`, `/slow-stream`, and dynamic routes |
| `import-curl` | Convert cURL command string to Safe Load Lab test config |
| `import-postman` | Convert Postman Collection JSON to Safe Load Lab test config |
| `import-openapi` | Convert OpenAPI 3.0 / Swagger 2.0 specification to Safe Load Lab test config |
| `import-har` | Convert browser HAR (HTTP Archive) network recording to test config |
| `spike` | Run a spike test (baseline → spike → recovery) |
| `soak` | Run a soak test (sustained load over time) |
| `stress` | Run a stress test (gradually increasing load) |
| `validate` | Validate config without sending traffic |
| `plan` | Preview resolved test plan without sending traffic |
| `sample` | Create a sample config file |
| `rate-limit` | Safe rate-limit verification for owned endpoints |
| `compare` | Compare two test reports side-by-side |
| `version` | Show version |
| `help` | Show help |

## 🏥 Automated SRE Bottleneck Diagnosis Engine

Stop guessing why your service slowed down. Safe Load Lab automatically analyzes test execution reports to pinpoint exact root causes, computes a **0–100 System Health Score**, and provides concrete SRE recommendations:

```bash
# Analyze any test report and output SRE findings
sll diagnose reports/my-report.json
# or use alias
sll blame reports/my-report.json
```

**Diagnosed Root Causes**:
- **Endpoint Latency Drag (`ENDPOINT_BOTTLENECK`)**: Flags routes that consume $\ge 50\%$ of accumulated system latency mass.
- **Cold-Start Warmup Surges (`COLD_START_LAG`)**: Detects high-latency clusters in the opening third of test runs (JIT compilation, connection pool starvation).
- **Cascading Resource Leaks (`CASCADING_LEAK`)**: Detects monotonically increasing failure rates or tail latency degradation towards the end of test runs (unclosed connections, memory leaks, file descriptor exhaustion).
- **Extreme Tail Latency Divergence (`TAIL_AMPLIFICATION`)**: Identifies $p_{95}/p_{50} \ge 4.0\times$ divergence caused by lock contention or GC pauses.
- **Reverse Proxy Saturation (`GATEWAY_TIMEOUT`)**: Pinpoints upstream 502/504 timeouts when backend queue depths overflow.
- **Strict Rate Limiting (`RATE_LIMIT_EXCEEDED`)**: Identifies HTTP 429 throttling triggers.

## 🔄 OpenAPI Intelligent CRUD Journey Flow Generator

Convert static OpenAPI/Swagger endpoint definitions into production-grade, realistic user journeys in one command:

```bash
# Synthesize complete multi-step CRUD lifecycle scenario
sll autogen-flow swagger.json --out scenario-journey.json
```

**What it synthesizes**:
1. **POST (Create)**: Generates create requests with dynamic random payloads and automatically extracts created resource IDs (`extract: { orderId: 'body.id' }`).
2. **GET (Read)**: Reads created resources using extracted dynamic variables (`url: '/orders/{{orderId}}'`).
3. **PUT / PATCH (Update)**: Sends update mutations referencing the active resource.
4. **DELETE (Cleanup)**: Deletes the created entity to leave your test database clean.
5. **Response Assertions**: Auto-wires HTTP 200, 201, 204 status validations for every step.

## ⚡ Autonomous Capacity Discovery & Breaking Point Engine

Find the exact inflection knee and breaking point of your service without manual guesswork:

```bash
# Autonomous capacity test against endpoint with SLA threshold
sll capacity http://localhost:8080/fast \
  --sla 200 \
  --max-rps 100 \
  --step-duration 5 \
  --step-inc 10 \
  --i-own-this-target
```

**Key Outputs**:
- **Sweet Spot (Max Sustainable RPS)**: Maximum RPS meeting SLA (e.g. $p_{95} \le 200\text{ms}$) and error rate $\le 1.0\%$.
- **Breaking Point**: First rate where latency explodes or error rate breaches thresholds.
- **Saturation Knee**: First inflection where system begins queuing and achieved RPS diverges from target RPS.
- **Production Sizing Recommendation**: Mathematically calculated autoscaling threshold with 80% safe headroom.
- **Executive Reports**: Generates detailed Markdown table and standalone dark-mode HTML report (`capacity-discovery-<timestamp>.html`).

## 🌊 Traffic Shaping Waveforms

Shape traffic distributions dynamically instead of flat RPS profiles:

```json
{
  "name": "diurnal-load",
  "waveform": "sine",
  "waveformOptions": {
    "minRps": 10,
    "maxRps": 80,
    "duration": 60,
    "cycles": 2
  }
}
```

Supported waveforms:
- `constant`: Uniform target RPS rate.
- `sine`: Diurnal traffic curve oscillating between `minRps` and `maxRps`.
- `ladder`: Stepped progressive stair-climb with automatic cool-down valleys.
- `burst`: Sustained baseline rate with periodic high-intensity bursts.

## 💥 Chaos Engineering & Dynamic Mock Server

Zero-flake hermetic mock server with built-in chaos and runtime programmable routes:

```bash
# Start hermetic mock server
sll mock --port 8080
```

- **Chaos Endpoint**: `/chaos?failRate=0.3&minDelay=100&maxDelay=500` - simulates jitter and intermittent HTTP 500/503 failures.
- **Slow Streaming Endpoint**: `/slow-stream?chunks=5&delay=50` - emits chunked HTTP transfer-encoding stream.
- **Dynamic In-Memory Route Registration**:
  - `POST /mock/routes` with `{ "path": "/api/v2/items", "status": 201, "body": { "created": true } }`
  - `GET /mock/routes` - lists registered dynamic routes
  - `DELETE /mock/routes?path=/api/v2/items` - unregisters mock route

## Preflight Single-Request Probe

Verify connectivity, latency, headers, and response assertions before launching full load tests:

```bash
# Test single endpoint
sll probe --url http://localhost:8080/fast

# Test from cURL command
sll probe --curl "curl -X POST http://localhost:8080/echo -d '{\"status\":\"ok\"}'"

# Test against config file with assertions
sll probe --config load-test.json
```

## Parameterized Data Feeds (CSV)

Drive load tests using real dataset rows to prevent database cache skewing:

```bash
sll run \
  --url "http://localhost:8080/users/{{data.id}}" \
  --data users.csv \
  --duration 30 \
  --concurrency 5 \
  --rps 10 \
  --i-own-this-target
```

Each row is interpolated into URL, headers, and request body using `{{data.columnName}}`.

## CI/CD Pipeline Integration

Generate automated SLA workflows for GitHub Actions or GitLab CI:

```bash
# Output GitHub Actions workflow
sll ci --type github --out .github/workflows/load-test.yml

# Output GitLab CI workflow
sll ci --type gitlab --out .gitlab-ci.yml
```

Tests run in CI fail automatically when response times exceed thresholds or error rate limits are breached.

## Quick Micro-Benchmarking

Run instant zero-config micro-benchmarks on any endpoint without creating configuration files:

```bash
# Instant 10-second benchmark (5 concurrency, 10 RPS)
sll bench http://localhost:8080/fast --i-own-this-target

# Custom duration and rate
sll bench http://localhost:8080/fast --duration 15 --concurrency 10 --rps 25 --i-own-this-target
```

## Browser HAR Recording Conversion

Export network activity directly from Chrome/Firefox DevTools and convert it into a load-test scenario:

```bash
# Convert HAR into Safe Load Lab config (filters binary assets automatically)
sll import-har user-flow.har -o scenario.json

# Include static assets if desired
sll import-har user-flow.har --include-assets -o scenario.json
```

## Bi-Directional Script Exporters (k6 & Postman)

Seamlessly migrate tests between Safe Load Lab and existing team toolchains:

```bash
# Export config to production-grade k6 JavaScript test script
sll export-k6 load-test.json -o k6-test.js

# Export config to Postman v2.1 Collection
sll export-postman load-test.json -o postman-collection.json
```

Both export formats are also available directly via the Web UI Studio export modals.

## Built-In Dynamic Data Generators

Generate realistic, high-entropy test payloads on the fly without external CSV data files:

- `{{$uuid}}` / `{{$guid}}` - Cryptographically strong UUID v4
- `{{$timestamp}}` - Current epoch millisecond timestamp
- `{{$isoDate}}` - ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`)
- `{{$randomEmail}}` - Deterministic randomized test email
- `{{$randomInt:min:max}}` - Random integer within specified bounds (e.g. `{{$randomInt:100:999}}`)
- `{{$randomAlpha:length}}` - Alphanumeric random string (e.g. `{{$randomAlpha:16}}`)
- `{{$randomIp}}` - Synthesized IPv4 address

Usable anywhere across request URLs, custom headers, and JSON/text request bodies:

```json
{
  "name": "create-user",
  "method": "POST",
  "url": "https://api.example.com/v1/users",
  "headers": { "X-Request-ID": "{{$uuid}}" },
  "body": {
    "email": "{{$randomEmail}}",
    "age": "{{$randomInt:18:65}}"
  }
}
```

## Multi-Step User Journey Scenarios

Model realistic customer workflows with variable correlation and step dependencies:

```json
{
  "name": "checkout-journey",
  "durationSeconds": 60,
  "concurrency": 10,
  "rps": 20,
  "scenarios": [
    {
      "name": "login-and-order",
      "weight": 3,
      "steps": [
        {
          "name": "authenticate",
          "method": "POST",
          "url": "https://api.example.com/auth/token",
          "body": { "client_id": "app", "client_secret": "secret" },
          "extract": { "authToken": "body.access_token" }
        },
        {
          "name": "create-order",
          "method": "POST",
          "url": "https://api.example.com/orders",
          "headers": { "Authorization": "Bearer {{authToken}}" },
          "body": { "sku": "ITEM-{{$randomInt:1000:9999}}", "qty": 1 }
        }
      ]
    }
  ]
}
```

## High-Capacity Limit Unlock

For enterprise infrastructure stress testing on authorized hardware, bypass the default safety caps:

```bash
# Unlock up to 24-hour durations, 2,000 concurrency, and 10,000 requests/second
sll run --config enterprise-stress.json --unlock-limits --i-own-this-target
# Or alias
sll run --config enterprise-stress.json --high-capacity --i-own-this-target
```

## Prometheus & OpenMetrics Live Scraping

Safe Load Lab Web Studio exposes an OpenMetrics Prometheus endpoint:

```bash
# Start Studio
npm run ui

# Scrape metrics (Prometheus format)
curl http://localhost:3001/metrics
```

Metrics include:
- `safeloadlab_uptime_seconds`
- `safeloadlab_active_test` (1 or 0)
- `safeloadlab_mock_running` (1 or 0)
- `safeloadlab_last_test_requests`
- `safeloadlab_last_test_failed`
- `safeloadlab_last_test_rps`
- `safeloadlab_last_test_p95_ms`
- `safeloadlab_last_test_error_rate`
- `safeloadlab_last_test_bytes_total`
- `safeloadlab_last_test_throughput_kbps`

## Hermetic Local Mock Server

Run reproducible tests locally with zero third-party dependencies:

```bash
sll mock --port 8080
# Routes ready: /health, /fast, /slow?delay=100, /error?status=500, /rate-limit, /auth, /flaky, /items, /echo
```

## Examples

### Basic Test

```json
{
  "name": "basic-api-test",
  "durationSeconds": 30,
  "concurrency": 5,
  "rps": 10,
  "endpoints": [
    {
      "name": "health",
      "method": "GET",
      "url": "http://localhost:3000/api/health"
    }
  ]
}
```

### Spike Test

```bash
# Test system behavior under sudden traffic spike
sll spike \
  --url http://localhost:3000/api/health \
  --i-own-this-target \
  --html reports/spike-test.html
```

### Soak Test

```bash
# Test for memory leaks with sustained load
sll soak \
  --url http://localhost:3000/api/health \
  --duration 300 \
  --concurrency 10 \
  --rps 20 \
  --i-own-this-target \
  --html reports/soak-test.html
```

### Stress Test

```bash
# Find breaking point with gradually increasing load
sll stress \
  --url http://localhost:3000/api/health \
  --i-own-this-target \
  --html reports/stress-test.html
```

### Compare Reports & SLA Regression Gate

Compare two test runs or gate PRs in CI against performance regressions:

```bash
# Basic comparison
sll compare reports/baseline.json reports/current.json

# Enforce strict SLA regression gate in CI (fails with exit code 1 if violated)
sll diff reports/baseline.json reports/current.json --max-latency-diff 10 --max-error-diff 0
# Or alias
sll check-regression reports/baseline.json reports/current.json
```

Outputs formatted regression delta tables to console and appends directly to `$GITHUB_STEP_SUMMARY` in GitHub Actions.

### Unicode Latency Sparkline Distributions

Real-time latency histogram sparklines in terminal summaries and Markdown reports:

```
Avg latency:  19.20ms
p95 latency:  36.00ms
p99 latency:  48.00ms
Distribution:  ▂▃▄▅▆▇█ [10ms ... 65ms]
Throughput:   1.42 MB/s (12.4 MB in, 1.8 MB out)
```

### Webhook Integration

```bash
# Send results to webhook
sll run \
  --config load-test.json \
  --i-own-this-target \
  --webhook https://your-webhook.com/endpoint \
  --slack https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
```

### Staged Ramp Testing

```json
{
  "stages": [
    { "name": "warm-up", "durationSeconds": 30, "concurrency": 3, "rps": 8 },
    { "name": "steady", "durationSeconds": 60, "concurrency": 10, "rps": 25 },
    { "name": "cool-down", "durationSeconds": 30, "concurrency": 3, "rps": 8 }
  ]
}
```

### Auth Flow with Token Extraction

```json
{
  "setup": [
    {
      "name": "login",
      "method": "POST",
      "url": "{{baseUrl}}/api/login",
      "body": { "email": "{{email}}", "password": "{{password}}" },
      "extract": { "token": "body.token" }
    }
  ],
  "endpoints": [
    {
      "name": "profile",
      "headers": { "Authorization": "Bearer {{token}}" }
    }
  ]
}
```

### GraphQL Testing

```json
{
  "endpoints": [
    {
      "name": "graphql",
      "graphql": {
        "query": "query { users { id name } }",
        "variables": {}
      }
    }
  ]
}
```

## Reports

Generate reports in multiple formats:

```bash
sll run \
  --config load-test.json \
  --i-own-this-target \
  --out reports/result.json \
  --csv reports/result.csv \
  --html reports/result.html \
  --junit reports/junit.xml
```

| Format | Option | Description |
|--------|--------|-------------|
| JSON | `--out` | Full machine-readable report |
| CSV | `--csv` | Per-request data |
| HTML | `--html` | Human-readable dashboard |
| JUnit XML | `--junit` | CI/CD test results |

## Configuration

Full configuration reference: [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md)

JSON schema: [schema/config.schema.json](schema/config.schema.json)

## Docker

Build:

```bash
docker build -t safe-load-lab .
```

Run:

```bash
docker run --rm safe-load-lab help
```

Against Docker Desktop host:

```bash
docker run --rm safe-load-lab run \
  --url http://host.docker.internal:3000/api/health \
  --duration 30 \
  --concurrency 5 \
  --rps 10 \
  --i-own-this-target
```

## CI/CD & GitHub Actions

### As a Reusable GitHub Action

Drop Safe Load Lab directly into any repository's CI pipeline with automatic Step Summary markdown reports:

```yaml
- name: Performance Regression Gate
  uses: AMG555/Safe-Load-Lab@main
  with:
    command: ab
    url-a: 'https://staging-v1.example.com/api'
    url-b: 'https://staging-v2.example.com/api'
    max-latency-diff: 15
    duration: 10
```

### CLI in GitHub Actions

```yaml
- name: Install CLI
  run: |
    npm ci
    npm install -g .
- name: Run A/B Differential Gate
  run: |
    sll ab \
      --url-a http://127.0.0.1:8080/fast \
      --url-b http://127.0.0.1:8080/slow?delay=50 \
      --duration 5 \
      --max-latency-diff 20 \
      --i-own-this-target
```

*Note: In GitHub Actions, markdown comparison tables and pass/fail verdicts automatically append to `$GITHUB_STEP_SUMMARY` for instant pull request and run dashboard visibility!*


## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Test completed and thresholds passed |
| 1 | Configuration/runtime error |
| 2 | Test completed but thresholds failed |

## Safety Limits

- Max duration: 600 seconds
- Max concurrency: 100
- Max RPS: 200
- Max body size: 1 MB
- Requires `--i-own-this-target` flag for `run` and `rate-limit` commands

## Documentation

| Document | Description |
|----------|-------------|
| [FEATURES.md](FEATURES.md) | Complete feature guide with examples |
| [SETUP.md](SETUP.md) | Detailed setup and troubleshooting guide |
| [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md) | Complete configuration reference |
| [docs/benchmarks.md](docs/benchmarks.md) | Benchmark data & performance architecture |
| [docs/ui-guide.md](docs/ui-guide.md) | Studio Web UI interactive guide |
| [SECURITY.md](SECURITY.md) | Safety and security guidelines |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributing guidelines |
| [SUPPORT.md](SUPPORT.md) | Getting help |

## Project Structure

```
safe-load-lab/
├── bin/
│   └── safe-load-lab.js    # Core CLI & test engine
├── docs/                   # Guides, benchmarks, and release notes
├── examples/               # Test configuration presets
├── schema/                 # JSON schema specifications
├── tests/                  # 120 unit, integration, performance, & UI tests
├── ui/                     # Web UI Studio & server
├── .github/                # GitHub Actions CI & workflows
└── reports/                # Output artifacts (JSON, HTML, CSV, Markdown)
```

## Related Tools

For enterprise-scale testing, consider:

- [k6](https://k6.io/) - Modern load testing
- [JMeter](https://jmeter.apache.org/) - Feature-rich testing
- [Locust](https://locust.io/) - Python-based testing
- [Grafana Cloud k6](https://k6.io/cloud/) - Cloud-based testing
- [Cloud Provider load testing](https://aws.amazon.com/performance/testing/) - Infrastructure-native testing

## License

[MIT](LICENSE)

## Acknowledgments

Safe Load Lab is designed for responsible, controlled testing of systems you own or have permission to test. Use responsibly and ethically.