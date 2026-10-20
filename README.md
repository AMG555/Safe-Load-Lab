# Safe Load Lab

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.2.0-blue.svg)](https://github.com/AMG555/Safe-Load-Lab/releases)
[![CI](https://github.com/AMG555/Safe-Load-Lab/actions/workflows/safe-load-lab.yml/badge.svg)](https://github.com/AMG555/Safe-Load-Lab/actions/workflows/safe-load-lab.yml)

A production-ready, feature-rich CLI for **controlled load testing**, **A/B differential benchmarking**, and **performance regression detection** of applications you own or have explicit permission to test.

This is **not** a DDoS tool. It is designed for safe capacity, performance, rate-limit, auth-flow, GraphQL, and resilience testing with built-in safety limits and ethical use guidelines.

## 🚀 What's New in v2.2.0

- ⚖️ **A/B Differential Load Testing (`sll ab`)**: Compare two endpoints or environments side-by-side with statistical latency delta, RPS comparison, automated winner determination, and performance regression gates for CI/CD.
- 🧪 **Hermetic Mock Server (`sll mock`)**: Built-in zero-dependency HTTP mock server (`/health`, `/fast`, `/slow`, `/error`, `/rate-limit`, `/echo`, `/json`) for 100% flake-free local testing and CI benchmarks.
- ⚡ **cURL Import (`sll import-curl` & `--curl`)**: Convert any browser/Postman cURL command directly into a reproducible load test.
- 🛡️ **75 Automated Quality Tests**: 100% passing test coverage across Unit, Integration, Performance, Smoke, A/B, UI Server, and QA suites.
- ⚙️ **Modern Node 22 Support**: Updated GitHub Actions CI with npm caching, automated mock server startup, and artifact generation.

## 🎯 Why Safe Load Lab?

- **Zero-Friction Sandbox** - Built-in mock server means you can start testing immediately without spinning up target servers
- **A/B Regression Gate** - Catch latency degradation in PRs before shipping to production
- **cURL Native** - Copy request as cURL from Chrome DevTools and run a load test in seconds
- **Production-Ready** - Used by developers and QA engineers for controlled load testing
- **Feature-Rich** - Spike, soak, stress, A/B tests, webhooks, Slack alerts, assertions, and retries
- **Safe by Design** - Hard-coded safety limits prevent accidental abuse
- **Developer-Friendly** - Beautiful colored CLI, JSON configs, HTML/Markdown reports, and Web UI

## Features

- ✅ **A/B Differential Testing** - Automated side-by-side endpoint comparison with regression alerts
- ✅ **Hermetic Mock Server** - Zero-dependency local test server for reliable benchmarking
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
- ✅ **Interactive Web UI** - Modern dashboard for visual test management
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
| `bench`, `quick` | Run instant zero-config micro-benchmark on single endpoint |
| `run` | Run a controlled load test |
| `probe`, `ping` | Send a single preflight probe request to verify endpoint status, latency, and assertions |
| `ci` | Generate ready-to-use CI/CD workflow (`github` or `gitlab`) |
| `ab`, `diff` | Run differential A/B benchmark comparing two endpoints or config profiles |
| `mock` | Start local hermetic mock server for zero-flake load tests |
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

### Compare Reports

```bash
# Compare two test runs
sll compare reports/baseline.json reports/after-optimization.json
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
├── tests/                  # 75 unit, integration, performance, & UI tests
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