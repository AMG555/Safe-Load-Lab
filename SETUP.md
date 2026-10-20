# Safe Load Lab Setup Guide

Safe Load Lab is a local, reusable CLI for controlled load testing of applications you own or have explicit permission to test.

It does **not** require any LLM, AI API, cloud account, or external service.

## 1. Requirements

You only need Node.js 18 or newer.

Check your Node.js version:

```bash
node -v
```

Expected:

```text
v18.x.x or higher
```

If Node.js is not installed, install it from:

```text
https://nodejs.org
```

Recommended version:

```text
Node.js 20 LTS or newer
```

## 2. Architecture & Dependencies

Safe Load Lab is completely self-contained. It requires zero cloud accounts, external SaaS subscriptions, or third-party API keys. All testing logic, concurrency scheduling, and reporting execute directly on your local Node.js runtime.

Safe Load Lab operates independently with:
- Zero external SaaS dependencies
- Zero third-party network egress during testing
- Zero cloud subscription lock-in
- Local hermetic mock server for offline verification

It runs locally using Node.js and sends HTTP requests directly to your own specified application target.

## 3. Install globally

From the workspace/project folder:

```bash
cd safe-load-lab
npm install -g .
```

After installation, you can use either command:

```bash
safe-load-lab help
```

or:

```bash
sll help
```

Check the version:

```bash
sll version
```

## 4. Validate the installation

Run:

```bash
sll help
```

You should see commands like:

```text
run
validate
plan
sample
rate-limit
version
help
```

## 5. Create a sample config

```bash
sll sample --out load-test.json
```

This creates:

```text
load-test.json
```

Edit the URLs inside this file to match your own application.

Example local URLs:

```json
{
  "url": "http://localhost:3000/api/health"
}
```

## 6. Validate a config without sending traffic

Before running any test, validate the config:

```bash
sll validate --config load-test.json
```

For the included advanced example:

```bash
sll validate --config examples/advanced.json --env local
```

## 7. Preview the test plan without sending traffic

Use `plan` to see exactly what will run:

```bash
sll plan --config load-test.json
```

For an environment profile:

```bash
sll plan --config examples/advanced.json --env local
```

This shows:

- selected environment
- stages
- duration
- concurrency
- RPS
- setup/auth steps
- endpoints
- thresholds

## 8. Run a quick local test

Example for a local health endpoint:

```bash
sll run \
  --url http://localhost:3000/api/health \
  --duration 30 \
  --concurrency 5 \
  --rps 10 \
  --i-own-this-target
```

The required flag:

```bash
--i-own-this-target
```

confirms that you own or have explicit permission to test the target.

## 9. Run from a config file

```bash
sll run \
  --config load-test.json \
  --i-own-this-target
```

With reports:

```bash
sll run \
  --config load-test.json \
  --i-own-this-target \
  --out reports/result.json \
  --csv reports/result.csv \
  --html reports/result.html \
  --junit reports/junit.xml
```

## 10. Run the advanced example

The advanced config supports:

- environment profiles
- login/setup flow
- token extraction
- authenticated requests
- GraphQL requests
- staged ramp testing

Validate it first:

```bash
sll validate --config examples/advanced.json --env local
```

Preview it:

```bash
sll plan --config examples/advanced.json --env local
```

Run it:

```bash
sll run \
  --config examples/advanced.json \
  --env local \
  --i-own-this-target \
  --out reports/local.json \
  --html reports/local.html
```

## 11. Safe rate-limit verification

Use this to check whether an endpoint starts returning `429` or `403` under controlled load.

Example login endpoint:

```bash
sll rate-limit \
  --url http://localhost:3000/api/login \
  --method POST \
  --body '{"email":"test@example.com","password":"wrong-password"}' \
  --header "Content-Type: application/json" \
  --duration 20 \
  --rps 10 \
  --concurrency 5 \
  --i-own-this-target \
  --html reports/rate-limit.html
```

Use only test accounts.

## 12. Staged testing

Use stages for realistic warm-up, steady-state, and cool-down testing.

Example:

```json
{
  "stages": [
    {
      "name": "warm-up",
      "durationSeconds": 30,
      "concurrency": 3,
      "rps": 8
    },
    {
      "name": "steady",
      "durationSeconds": 60,
      "concurrency": 10,
      "rps": 25
    },
    {
      "name": "cool-down",
      "durationSeconds": 30,
      "concurrency": 3,
      "rps": 8
    }
  ]
}
```

If you pass these CLI options:

```bash
--duration
--concurrency
--rps
```

they override the configured stages and run one steady stage.

## 13. Reports

Safe Load Lab can generate:

| Report | Option | Use |
|---|---|---|
| JSON | `--out reports/result.json` | Full machine-readable report |
| CSV | `--csv reports/result.csv` | Per-request data |
| HTML | `--html reports/result.html` | Human-readable dashboard |
| JUnit XML | `--junit reports/junit.xml` | CI/CD test result |

Example:

```bash
sll run \
  --config load-test.json \
  --i-own-this-target \
  --out reports/result.json \
  --csv reports/result.csv \
  --html reports/result.html \
  --junit reports/junit.xml
```

## 14. Built-in safety limits

Safe Load Lab has hard caps:

```text
Max duration:     600 seconds
Max concurrency:  100
Max RPS:          200
Max body size:    1 MB
```

The `run` and `rate-limit` commands require:

```bash
--i-own-this-target
```

## 15. Recommended safe workflow

Use this order:

```bash
sll validate --config load-test.json
sll plan --config load-test.json
sll run --config load-test.json --i-own-this-target
```

Start small:

```bash
sll run \
  --url http://localhost:3000/api/health \
  --duration 30 \
  --concurrency 2 \
  --rps 5 \
  --i-own-this-target
```

Then increase gradually.

## 16. What to monitor during testing

Monitor your application and infrastructure:

- CPU usage
- memory usage
- HTTP 4xx/5xx errors
- API latency
- p95 latency
- p99 latency
- database connections
- slow database queries
- queue depth
- worker lag
- cache hit ratio
- application logs
- network bandwidth

Stop immediately if real users or shared systems are affected.

## 17. Run tests for the tool itself

From inside the project:

```bash
cd safe-load-lab
npm test
```

Expected result:

```text
pass 4
fail 0
```

## 18. Docker setup

Build Docker image:

```bash
cd safe-load-lab
docker build -t safe-load-lab .
```

Run help:

```bash
docker run --rm safe-load-lab help
```

Run against a local app from Docker Desktop:

```bash
docker run --rm safe-load-lab run \
  --url http://host.docker.internal:3000/api/health \
  --duration 30 \
  --concurrency 5 \
  --rps 10 \
  --i-own-this-target
```

## 19. Troubleshooting

### `sll: command not found`

Reinstall globally:

```bash
cd safe-load-lab
npm install -g .
```

Check npm global bin path:

```bash
npm bin -g
```

Make sure that path is in your shell `PATH`.

### `Missing required safety flag`

Add:

```bash
--i-own-this-target
```

to `run` or `rate-limit` commands.

### `Environment profile not found`

Check the environment name in your config:

```json
"environments": {
  "local": {},
  "staging": {}
}
```

Then run:

```bash
sll run --config examples/advanced.json --env local --i-own-this-target
```

### Connection refused

Your application is probably not running or the URL is wrong.

Check your app:

```bash
curl http://localhost:3000/api/health
```

### Too many failed requests

Check:

- endpoint URL
- auth token
- request method
- request body
- headers
- server logs
- database availability

## 20. Important safety reminder

Only test:

- your own local apps
- your own staging apps
- production systems you own and are authorized to test
- systems where you have written permission

Do **not** test third-party systems, public websites, shared APIs, or external infrastructure without permission.
