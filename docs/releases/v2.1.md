# Release Notes - Safe Load Lab v2.1.0

**Release Date**: January 2027  
**Type**: Minor Release (Feature Addition)

## 🎉 What's New

### 1. **Comprehensive Type Safety with JSDoc**
- Added complete JSDoc type definitions for all configuration objects
- Better IDE autocomplete and error detection
- Foundation for future TypeScript migration
- Enhanced documentation through inline types

### 2. **Exponential Backoff Retry Logic**
- Automatic retry for transient failures (500, 502, 503, 504, timeouts)
- Configurable retry attempts (default: 3)
- Exponential backoff with configurable multiplier (default: 2x)
- Max backoff cap to prevent excessive delays (default: 10s)
- Track retry exhaustion in reports

**Configuration Example**:
```json
{
  "retry": {
    "enabled": true,
    "maxAttempts": 3,
    "backoffMultiplier": 2,
    "maxBackoffMs": 10000,
    "retryOn": [500, 502, 503, 504, "timeout", "ECONNRESET"]
  }
}
```

### 3. **Response Assertion System**
- Validate responses during load tests
- Assertion types supported:
  - `status` - Validate HTTP status codes
  - `jsonPath` - Check JSON response values
  - `header` - Validate response headers
  - `responseTime` - Assert latency thresholds
- Track assertion failures separately from HTTP errors
- Detailed assertion results in reports

**Assertion Example**:
```json
{
  "endpoints": [
    {
      "url": "https://api.example.com/users",
      "assertions": [
        { "type": "status", "value": 200 },
        { "type": "header", "name": "content-type", "contains": "application/json" },
        { "type": "responseTime", "lessThan": 1000 }
      ]
    }
  ]
}
```

### 4. **Colored Console Output**
- Beautiful, color-coded terminal output using Chalk
- Green for success, yellow for warnings, red for errors
- Emoji indicators for better visual scanning
- Color-coded status distribution
- Enhanced threshold results display

### 5. **Real-Time Progress Bar**
- Visual progress bar during test execution
- Live metrics: current stage, RPS, requests, failures
- ETA calculation
- Replaces plain text progress output
- Cleaner, more professional appearance

### 6. **Markdown Report Format**
- Generate GitHub-flavored markdown reports
- Use `--markdown` or `--md` flag
- Clean, readable format for documentation
- Tables for metrics and status codes
- Perfect for including in PRs or wikis

### 7. **Automatic Failure Logging**
- Detailed logs for every failed request
- Separate JSON files per failure
- Includes full request/response details
- Captures assertion failures
- Saved to `reports/failures/` by default

### 8. **Enhanced Debugging**
- New `--debug` flag for verbose logging
- Request/response details in debug mode
- Retry attempt logging
- Better error messages with context
- Validation errors with precise location

## 🔄 Improvements

- **Better Error Messages**: More specific validation errors with actionable guidance
- **Input Validation**: URL validation catches issues before test starts
- **Response Headers**: Now captured and available for assertions
- **Memory Warnings**: Improved messaging for large result sets
- **Test Output**: Enhanced test start/finish messages with emojis

## 📊 Example Usage

### Basic Test with New Features
```bash
sll run \
  --config my-test.json \
  --i-own-this-target \
  --markdown reports/test.md \
  --debug
```

### Test with Assertions
```bash
sll run \
  --config examples/with-assertions.json \
  --i-own-this-target \
  --html reports/assertions.html \
  --markdown reports/assertions.md
```

### Debug Mode for Troubleshooting
```bash
sll run \
  --url https://api.example.com/health \
  --duration 60 \
  --i-own-this-target \
  --debug
```

## 📦 Dependencies

**New Dependencies**:
- `chalk@5.3.0` - Terminal color output
- `cli-progress@3.12.0` - Progress bar display

## 🔧 Breaking Changes

**None** - This release is 100% backward compatible with v2.0.x

## 🐛 Bug Fixes

- Fixed response body handling for error responses
- Improved memory management for large test runs
- Better cleanup of in-flight requests on Ctrl+C

## 📈 Performance

All performance improvements from v2.0.1 are retained:
- 35% more accurate RPS targeting
- 70%+ faster report generation
- 20% faster throughput with connection reuse
- 20% less memory usage

## 🚀 Migration Guide

### From v2.0.x to v2.1.0

No migration required! v2.1.0 is fully backward compatible.

**Optional Enhancements**:

1. **Add Retry Configuration** (optional):
```json
{
  "retry": {
    "enabled": true,
    "maxAttempts": 3
  }
}
```

2. **Add Response Assertions** (optional):
```json
{
  "endpoints": [
    {
      "url": "...",
      "assertions": [
        { "type": "status", "value": 200 }
      ]
    }
  ]
}
```

3. **Use New Report Format** (optional):
```bash
# Add --markdown flag to your existing commands
sll run --config test.json --i-own-this-target --markdown report.md
```

4. **Enable Debug Mode** (optional):
```bash
# Add --debug flag when troubleshooting
sll run --config test.json --i-own-this-target --debug
```

## 📚 Documentation Updates

- Updated README with new features
- Added `examples/with-assertions.json` example
- Enhanced CLI help text
- This release notes document

## 🙏 Acknowledgments

Thanks to the community for feature requests and feedback that shaped this release!

## 🔮 What's Next

Check our [ROADMAP.md](ROADMAP.md) for upcoming features:
- TypeScript migration (v2.2.0)
- Result streaming for unlimited duration (v2.2.0)
- HTTP/2 support (v2.3.0)
- Request chaining/scenarios (v2.3.0)
- Real-time web dashboard (v2.4.0)

## 📥 Installation

### Update Existing Installation
```bash
npm install -g safe-load-lab@2.1.0
```

### Fresh Installation
```bash
npm install -g safe-load-lab
```

### Verify Installation
```bash
sll version  # Should output: 2.1.0
```

## 🐛 Report Issues

Found a bug? Please [open an issue](https://github.com/amg555/Safe-Load-Lab/issues) with:
- Your `sll version` output
- Node.js version (`node --version`)
- Operating system
- Steps to reproduce
- Expected vs actual behavior

---

**Full Changelog**: [CHANGELOG.md](CHANGELOG.md)  
**Documentation**: [README.md](README.md)  
**Examples**: [examples/](examples/)
