# Safe Load Lab - Quick Start Guide

## Installation

```bash
npm install -g safe-load-lab
# or
npx safe-load-lab help
```

## 🚀 The Fastest Ways to Start

### 1. Visual Web Studio (Zero Config / Zero JSON)

```bash
# Start studio from workspace root:
npm start

# Or with global CLI:
sll ui
```
Open **`http://localhost:3001`** in browser. Fill in Target URL, Concurrency, and RPS in visual forms. Click **"Run Test"** to see live graphs and telemetry.

To test authenticated endpoints:
- Select **"Dynamic Login Step (Auto-Extract Token)"** in Authentication dropdown.
- Enter login endpoint (e.g., `/api/auth/login`), JSONPath (e.g., `token`), and credentials body.
- Safe Load Lab auto-logs in before the test and injects Bearer token into all requests.

### 2. Interactive Terminal Wizard (No JSON Editing)

```bash
# Start wizard from workspace root:
npm run wizard

# Or with global CLI:
sll wizard
```
Answers 4 step-by-step terminal prompts:
- Target URL
- Duration (s)
- Concurrency (virtual users)
- Target RPS
Choose **"Y"** to run immediately.

---

## 5-Minute Command Line Quick Start

### 1. Basic CLI Test (30 seconds)

```bash
sll run \
  --url http://localhost:3000/api/health \
  --duration 30 \
  --concurrency 5 \
  --rps 10 \
  --i-own-this-target
```

### 2. Generate Sample Config

```bash
sll sample --out my-test.json
```

Edit `my-test.json` with your URLs, then:

```bash
sll run --config my-test.json --i-own-this-target
```

### 3. Validate Before Running

```bash
sll validate --config my-test.json
sll plan --config my-test.json
```

### 4. Generate Reports

```bash
sll run \
  --config my-test.json \
  --i-own-this-target \
  --out reports/result.json \
  --html reports/result.html \
  --csv reports/result.csv
```

## Test Types

### Standard Load Test
```bash
sll run --config load-test.json --i-own-this-target
```

### Spike Test (baseline → spike → recovery)
```bash
sll spike --url http://localhost:3000/api --i-own-this-target
```

### Soak Test (sustained load, 5 mins)
```bash
sll soak --url http://localhost:3000/api --duration 300 --i-own-this-target
```

### Stress Test (gradually increasing)
```bash
sll stress --url http://localhost:3000/api --i-own-this-target
```

## Integrations

### Slack Notifications
```bash
sll run \
  --config my-test.json \
  --i-own-this-target \
  --slack https://hooks.slack.com/services/YOUR/WEBHOOK
```

### Webhook
```bash
sll run \
  --config my-test.json \
  --i-own-this-target \
  --webhook https://your-api.com/results
```

### Compare Reports
```bash
sll compare reports/before.json reports/after.json
```

## Common Options

| Option | Description | Example |
|--------|-------------|---------|
| `--config` | JSON config file | `--config test.json` |
| `--url` | Target URL | `--url http://localhost:3000/api` |
| `--duration` | Test duration (seconds) | `--duration 60` |
| `--concurrency` | Max concurrent requests | `--concurrency 10` |
| `--rps` | Requests per second | `--rps 20` |
| `--env` | Environment profile | `--env staging` |
| `--out` | JSON output file | `--out reports/test.json` |
| `--html` | HTML report | `--html reports/test.html` |
| `--csv` | CSV output | `--csv reports/test.csv` |
| `--junit` | JUnit XML | `--junit reports/junit.xml` |
| `--webhook` | Webhook URL | `--webhook https://...` |
| `--slack` | Slack webhook | `--slack https://hooks.slack.com/...` |
| `--compare` | Compare with previous | `--compare reports/previous.json` |

## Safety Limits

- Max duration: **600 seconds** (10 minutes)
- Max concurrency: **100**
- Max RPS: **200**
- Max body size: **1 MB**
- Requires `--i-own-this-target` flag

## What to Monitor

During tests, monitor:
- ✅ CPU usage
- ✅ Memory usage
- ✅ HTTP errors (4xx/5xx)
- ✅ API latency (p95, p99)
- ✅ Database connections
- ✅ Queue depth
- ✅ Application logs

## Best Practices

1. **Start Small**: Begin with 1-5 concurrency and 5-10 RPS
2. **Test Locally First**: Use `http://localhost` before staging
3. **Use Staging**: Test in staging before production
4. **Monitor Everything**: Watch your infrastructure during tests
5. **Increase Gradually**: Double load incrementally
6. **Set Alerts**: Configure monitoring alerts before testing

## Examples

### Multi-Stage Test
```json
{
  "name": "multi-stage-test",
  "stages": [
    { "name": "warm-up", "durationSeconds": 30, "concurrency": 3, "rps": 8 },
    { "name": "steady", "durationSeconds": 60, "concurrency": 10, "rps": 25 },
    { "name": "cool-down", "durationSeconds": 30, "concurrency": 3, "rps": 8 }
  ],
  "endpoints": [
    { "name": "health", "method": "GET", "url": "http://localhost:3000/api/health" }
  ]
}
```

### Auth Flow Test
```json
{
  "setup": [
    {
      "name": "login",
      "method": "POST",
      "url": "http://localhost:3000/api/login",
      "body": { "email": "test@example.com", "password": "password" },
      "extract": { "token": "body.token" }
    }
  ],
  "endpoints": [
    {
      "name": "profile",
      "method": "GET",
      "url": "http://localhost:3000/api/profile",
      "headers": { "Authorization": "Bearer {{token}}" }
    }
  ]
}
```

## Troubleshooting

### Command not found
```bash
npm install -g safe-load-lab
```

### Missing safety flag
```bash
# Add --i-own-this-target flag
sll run --url http://localhost:3000/api --i-own-this-target
```

### Connection refused
```bash
# Check if your app is running
curl http://localhost:3000/api/health
```

## Next Steps

- Read [FEATURES.md](FEATURES.md) for detailed feature guide
- Read [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md) for full configuration options
- Read [SETUP.md](SETUP.md) for detailed setup instructions
- Check [examples/](examples/) for more configuration examples

## Support

- Issues: https://github.com/amg555/Safe-Load-Lab/issues
- Documentation: [SUPPORT.md](SUPPORT.md)