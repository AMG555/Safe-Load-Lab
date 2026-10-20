# Release Notes v2.2.0 - A/B Differential Testing & Hermetic Mock Server

Safe Load Lab v2.2.0 introduces game-changing capabilities for developers, QA engineers, and DevOps teams: automated **A/B Differential Load Testing**, a **Hermetic Local Mock Server**, and **cURL Import**.

## Highlights

### 1. ⚖️ A/B Differential Load Testing (`sll ab` / `sll diff`)
Compare two endpoints, two versions of a microservice, or two deployment environments side-by-side under identical load conditions.
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
- Automatically determines statistical delta for throughput, avg, p50, p90, p95, and p99 latencies.
- Identifies the winner (`🏆 Variant B is WINNER` or `⚠️ Variant A was Faster`).
- Flags performance regressions with exit code 2 to gate CI/CD pipelines.

### 2. 🧪 Hermetic Built-in Mock Server (`sll mock`)
Zero-dependency, high-performance mock HTTP server tailored for API load testing.
```bash
sll mock --port 8080
```
Included routes:
- `GET /health` — Health check, uptime, version, time
- `GET /fast` — High-throughput 200 OK
- `GET /slow?delay=100` — Configurable latency simulation
- `GET /error?status=500` — Configurable error status codes
- `GET /rate-limit?limit=10&window=5` — Sliding window rate limit simulation with HTTP 429 and `Retry-After`
- `POST /echo` — Echoes back request method, headers, and parsed body
- `GET /json` — Sample JSON data payload

### 3. ⚡ cURL Import (`sll import-curl` & `--curl`)
Turn any curl request into a load test instantly:
```bash
# Run directly from curl
sll run --curl "curl -X POST http://localhost:8080/echo -H 'Content-Type: application/json' -d '{\"msg\":\"hello\"}'" --duration 10 --i-own-this-target

# Or convert curl to config JSON
sll import-curl "curl https://myapi.com/items" --out load-test.json
```

### 4. 📊 Enhanced Web UI Dashboard
- Dedicated A/B testing tab with real-time progress and comparative result cards.
- Integrated Mock Server control toggle and one-click endpoint auto-fill.
- Fixed SSE metrics binding to display actual live test metrics accurately.

### 5. 🛡️ 63 Automated Tests (100% Pass)
- Complete unit, integration, performance, smoke, A/B differential, and comprehensive QA suites.
- Fully self-contained without external network flakiness.

### 6. ⚙️ CI/CD Modernization
- Fixed missing `npm ci` bug in global CLI installation.
- Migrated runners to Node 22 with dependency caching.
