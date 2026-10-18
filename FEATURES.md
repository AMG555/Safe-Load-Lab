# Safe Load Lab Features Guide

## Table of Contents

1. [Load Testing Modes](#load-testing-modes)
2. [Integration Features](#integration-features)
3. [Report Comparison](#report-comparison)
4. [Advanced Configuration](#advanced-configuration)

## Load Testing Modes

### Standard Load Test

```bash
sll run --config load-test.json --i-own-this-target
```

Standard controlled load test with configurable stages.

### Spike Test

**Purpose:** Test system behavior under sudden traffic increases

```bash
sll spike --url http://localhost:3000/api/health --i-own-this-target
```

**Test Pattern:**
1. **Baseline** (30s): Low traffic (2 concurrent, 5 RPS)
2. **Spike** (60s): High traffic (20 concurrent, 50 RPS)
3. **Recovery** (30s): Back to low traffic (2 concurrent, 5 RPS)

**What to Monitor:**
- Error rate during spike
- Recovery time after spike
- Resource usage peaks
- Queue depth during spike

### Soak Test

**Purpose:** Test for memory leaks and stability under sustained load

```bash
sll soak --url http://localhost:3000/api/health --duration 300 --concurrency 10 --rps 20 --i-own-this-target
```

**Test Pattern:**
- Sustained constant load for extended duration (default 5 minutes)
- Monitors for gradual performance degradation

**What to Monitor:**
- Memory usage over time
- Response times over duration
- Database connection pool
- Cache effectiveness
- Slow query accumulation

### Stress Test

**Purpose:** Find breaking point by gradually increasing load

```bash
sll stress --url http://localhost:3000/api/health --i-own-this-target
```

**Test Pattern:**
1. **Stage 1** (60s): 5 concurrent, 10 RPS
2. **Stage 2** (60s): 10 concurrent, 20 RPS
3. **Stage 3** (60s): 20 concurrent, 40 RPS
4. **Stage 4** (60s): 40 concurrent, 80 RPS
5. **Stage 5** (60s): 60 concurrent, 120 RPS

**What to Monitor:**
- Point where errors start increasing
- Latency degradation
- Resource saturation (CPU, memory, connections)
- Auto-scaling triggers

### A/B Differential Testing (`sll ab` / `sll diff`)

**Purpose:** Compare two versions, endpoints, or environments under identical load and catch performance regressions before production.

```bash
# Compare endpoint A vs endpoint B
sll ab \
  --url-a http://localhost:8080/fast \
  --url-b http://localhost:8080/slow?delay=50 \
  --duration 10 \
  --concurrency 5 \
  --rps 10 \
  --max-latency-diff 15 \
  --i-own-this-target \
  --html reports/ab-report.html \
  --markdown reports/ab-report.md
```

**What it Evaluates:**
- Requests delta and achieved throughput
- Error rate differences
- Latency percentiles: avg, p50, p90, p95, and p99
- Winner determination (`🏆 Variant B is WINNER` or `⚠️ Variant A was Faster`)
- Exits with code 2 on performance regression to automatically fail CI/CD pull requests

### Hermetic Local Mock Server (`sll mock`)

**Purpose:** Zero-dependency local mock server for immediate testing without external services.

```bash
sll mock --port 8080
```

**Built-in Routes:**
- `GET /health`: Health status, version, uptime, timestamp
- `GET /fast`: Ultra-fast 200 OK
- `GET /slow?delay=ms`: Configurable artificial latency
- `GET /error?status=code`: Configurable HTTP error code simulation
- `GET /rate-limit?limit=X&window=Y`: Realistic sliding window rate limiting
- `POST /echo`: Echoes headers, method, and request body
- `GET /json`: Structured mock user fixture

### cURL Command Import (`sll import-curl` & `--curl`)

**Purpose:** Directly run tests from cURL commands copied from DevTools, Postman, or documentation.

```bash
# Direct run from cURL
sll run --curl "curl -X POST http://localhost:8080/echo -H 'Content-Type: application/json' -d '{\"msg\":\"hello\"}'" --duration 10 --i-own-this-target

# Convert cURL to config JSON
sll import-curl "curl https://myapi.com/items" --out load-test.json
```

## Integration Features


### Webhook Integration

Send test results to any webhook endpoint:

```bash
sll run \
  --config load-test.json \
  --i-own-this-target \
  --webhook https://your-api.com/load-test-results
```

**Payload Format:**
```json
{
  "testName": "my-test",
  "timestamp": "2026-06-09T12:00:00.000Z",
  "requests": 1000,
  "failed": 5,
  "errorRate": 0.005,
  "rps": 33.33,
  "latency": {
    "avg": 45.2,
    "p95": 120.5,
    "p99": 250.8
  },
  "thresholds": {}
}
```

### Slack Integration

Get real-time notifications in Slack:

```bash
sll run \
  --config load-test.json \
  --i-own-this-target \
  --slack https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
```

**Message Includes:**
- Test name and status (✅ or ❌)
- Total requests and failures
- Error rate and RPS
- Latency metrics (avg, p95)
- Threshold pass/fail status

## Report Comparison

Compare two test runs to analyze performance changes:

```bash
# Run baseline test
sll run --config load-test.json --i-own-this-target --out reports/baseline.json

# Make changes to your app

# Run comparison test
sll run --config load-test.json --i-own-this-target --out reports/after-fix.json

# Compare results
sll compare reports/baseline.json reports/after-fix.json
```

**Output:**
```
🔍 Report Comparison

Report 1: my-test (2026-06-09T10:00:00.000Z)
Report 2: my-test (2026-06-09T11:00:00.000Z)

✅ Requests              1000.00 → 1000.00 (+0.00%)
✅ Failed                10.00 → 5.00 (-50.00%)
✅ Error Rate            1.00% → 0.50% (-50.00%)
= Achieved RPS           33.33 → 33.33 (+0.00%)
✅ Avg Latency           50.00ms → 35.00ms (-30.00%)
✅ p95 Latency           150.00ms → 100.00ms (-33.33%)
✅ p99 Latency           300.00ms → 200.00ms (-33.33%)
```

## Advanced Configuration

### Combined Features Example

```bash
sll run \
  --config load-test.json \
  --env staging \
  --i-own-this-target \
  --out reports/staging-test.json \
  --html reports/staging-test.html \
  --csv reports/staging-test.csv \
  --junit reports/junit.xml \
  --webhook https://your-api.com/results \
  --slack https://hooks.slack.com/services/YOUR/WEBHOOK \
  --compare reports/previous-staging-test.json
```

This command will:
1. Run the test with staging environment profile
2. Generate JSON, HTML, CSV, and JUnit reports
3. Send results to webhook
4. Send notification to Slack
5. Compare with previous test run

### Realistic Traffic Patterns

Use `--realistic` flag for more realistic request spacing:

```bash
sll run --config load-test.json --i-own-this-target --realistic
```

This adds random jitter to request timing, simulating real user behavior better than fixed RPS.

### Verbose Logging

Enable detailed logging for debugging:

```bash
sll run --config load-test.json --i-own-this-target --verbose
```

Shows:
- Individual request details
- Stage transitions
- Setup step execution
- Token extraction values
- Detailed error messages

## Best Practices

### 1. Start Small, Scale Up

```bash
# Week 1: Baseline
sll run --url $API --duration 60 --concurrency 5 --rps 10 --i-own-this-target

# Week 2: Moderate Load
sll run --url $API --duration 120 --concurrency 10 --rps 20 --i-own-this-target

# Week 3: Production-like
sll run --url $API --duration 300 --concurrency 20 --rps 40 --i-own-this-target
```

### 2. Use Appropriate Test Types

- **Spike**: Before major releases, marketing campaigns
- **Soak**: For long-running services, detecting memory leaks
- **Stress**: Finding capacity limits before scaling decisions

### 3. Monitor Infrastructure

Always monitor during tests:
- Application logs
- CPU and memory
- Database connections and queries
- Queue depth
- Cache hit rates
- Network bandwidth

### 4. Automate with CI/CD

```yaml
# GitHub Actions example
- name: Smoke Test
  run: sll run --url ${{ secrets.STAGING_URL }}/health --duration 30 --concurrency 5 --rps 10 --i-own-this-target
  
- name: Notify Slack
  if: always()
  run: sll run --url ${{ secrets.STAGING_URL }}/health --duration 30 --concurrency 5 --rps 10 --i-own-this-target --slack ${{ secrets.SLACK_WEBHOOK }}
```

## Safety Reminders

- All test modes respect hard safety limits (600s duration, 100 concurrency, 200 RPS)
- `--i-own-this-target` flag is always required
- Test only systems you own or have explicit permission to test
- Monitor your infrastructure during all tests
- Start with low loads and increase gradually
