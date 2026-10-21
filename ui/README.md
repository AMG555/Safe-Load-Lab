# Safe Load Lab - Web UI

A modern, non-technical web interface for Safe Load Lab load testing tool.

## Features

- **Visual Config Builder** - Easy-to-use forms instead of JSON
- **Quick Mode** - Simple URL, duration, concurrency, and RPS fields
- **Advanced Mode** - Full JSON configuration editor
- **Real-time Results** - Live progress tracking and results dashboard
- **Results Summary** - Key metrics including latency percentiles
- **Test History** - View all previous test runs

## Requirements

- Node.js 18+
- Safe Load Lab CLI installed globally (`npm install -g .` from the main project)

## Installation

```bash
cd ui
npm install
```

## Running the UI

From the main workspace root:

```bash
npm start
# or
sll ui
```

Or from the `ui/` directory:

```bash
npm start
```

Then open your browser to:

```
http://localhost:3001
```

## How to Use

### Quick Start

1. Enter a target URL (e.g., `http://localhost:3000/api/health`)
2. Set duration, concurrency, and RPS
3. Click "Run Test"
4. View results in real-time

### Advanced Testing

1. Click the "Advanced" tab
2. Paste or edit your JSON configuration
3. Use staged testing for warm-up, steady-state, and cool-down phases
4. Click "Run Test"

## Generated Reports

All test reports are saved to the `reports/` directory in the main project:

- `*.json` - Full machine-readable report
- `*.html` - Visual dashboard
- `*.csv` - Per-request data

## Safety

- All safety flags are handled automatically
- Built-in limits are enforced:
  - Max duration: 600 seconds
  - Max concurrency: 100
  - Max RPS: 200
- Only test systems you own or have permission to test

## Configuration Examples

### Simple Health Check

```json
{
  "url": "http://localhost:3000/api/health"
}
```

### Staged Testing

```json
{
  "url": "http://localhost:3000/api/users",
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
    }
  ]
}
```

## Troubleshooting

### `sll: command not found`

Install the CLI globally from the main project:

```bash
cd ..
npm install -g .
```

### Port 3001 already in use

Change the PORT in `ui/server.js` and restart.

### No connection to application

Verify your application is running and the URL is correct by testing with curl:

```bash
curl http://localhost:3000/api/health
```
