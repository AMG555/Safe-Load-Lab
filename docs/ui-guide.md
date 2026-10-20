# Safe Load Lab - UI User Guide

## 🚀 Quick Start

### Step 1: Start the Web UI

**Windows:**
- Double-click `start-ui.bat`

**macOS/Linux:**
```bash
bash start-ui.sh
```

Or manually:
```bash
cd ui
npm start
```

### Step 2: Open in Browser

When you see the message "Safe Load Lab UI running at http://localhost:3001", open:
```
http://localhost:3001
```

You'll see the Safe Load Lab dashboard.

---

## 📋 Understanding the Interface

The dashboard has three main sections:

### 1. Configure Test (Left Side)
Enter details about your load test here.

### 2. Results (Right Side)
View real-time results and summary statistics.

### 3. Test History (Bottom)
See all previous tests you've run.

---

## 🎯 Using Quick Mode (Recommended for Beginners)

### Step 1: Fill in the form

**Target URL**: The website/API you want to test
- Example: `http://localhost:3000/api/health`
- Make sure your application is running!

**Duration (seconds)**: How long to run the test
- Start with: `30` (30 seconds)
- Max: `600` (10 minutes)

**Concurrency**: How many requests at the same time
- Start with: `5`
- Max: `100`

**Requests per Second (RPS)**: Speed of requests
- Start with: `10`
- Max: `200`

### Step 2: Validate (Optional but Recommended)
Click **Validate** to check if your configuration is correct before running.

### Step 3: Run Test
Click **Run Test** to start the load test.

You'll see:
- A progress bar
- Real-time status updates
- Live results appear on the right

---

## 📊 Understanding the Results

After your test completes, you'll see:

**Total Requests** - How many requests were sent
```
Example: 1,500 requests
```

**Success Rate** - Percentage of successful responses
```
Example: 98% means 98 out of 100 requests succeeded
```

**Average Latency** - Average response time
```
Example: 145ms means responses took 145 milliseconds on average
```

**Success Count** - Actual number of successful requests
```
Example: 1,470 out of 1,500 succeeded
```

**P95 Latency** - 95% of requests were faster than this
```
Example: 220ms means 95% of requests took less than 220ms
```

**P99 Latency** - 99% of requests were faster than this
```
Example: 280ms means 99% of requests took less than 280ms
```

---

## 🔧 Common Scenarios

### Test a Health Check Endpoint

```
URL: http://localhost:3000/api/health
Duration: 30 seconds
Concurrency: 2
RPS: 5
```

This is a safe starting point.

### Test Under Moderate Load

```
URL: http://localhost:3000/api/users
Duration: 60 seconds
Concurrency: 10
RPS: 25
```

Good for testing normal peak conditions.

### Test Breaking Point

```
URL: http://localhost:3000/api/search
Duration: 120 seconds
Concurrency: 50
RPS: 100
```

This is more aggressive - monitor your app closely!

---

## 📁 Where Results Are Saved

All test results are saved in the `reports/` folder:

- **result.json** - Complete data (for analysis)
- **result.html** - Visual dashboard (open in browser)
- **result.csv** - Per-request data (for Excel)

Each report has a timestamp, so you can run multiple tests and find them easily.

---

## ⚠️ Important Safety Tips

### Before You Start Testing

1. **Make sure YOU own the application**
   - Test your own apps
   - Test staging environments
   - Do NOT test public websites
   - Do NOT test other people's apps without permission

2. **Notify team members**
   - Tell others you're load testing
   - Load tests can cause CPU spikes
   - Shared systems might be affected

3. **Monitor your application**
   - Watch CPU usage
   - Check memory usage
   - Look for error messages
   - Stop immediately if it crashes

### Built-in Limits (You can't exceed these)

```
Max Duration: 10 minutes (600 seconds)
Max Concurrency: 100 simultaneous requests
Max RPS: 200 requests per second
Max Body Size: 1 MB per request
```

---

## 🐛 Troubleshooting

### "Connection refused"

**Problem**: You get an error about "Connection refused"

**Solution**: 
- Make sure your application is running
- Check the URL is correct
- Try opening the URL in your browser first
- Test with curl:
  ```bash
  curl http://localhost:3000/api/health
  ```

### "Test won't start"

**Problem**: You click Run Test but nothing happens

**Solution**:
- Fill in all required fields (marked with *)
- Check the URL starts with http:// or https://
- Try Validate first to see if there's an error

### "sll: command not found" (in browser)

**Problem**: You see an error about "sll" command

**Solution**:
- The CLI tool isn't installed globally
- Go back and run: `npm install -g .` from the main folder
- Then restart the UI

### Port 3001 already in use

**Problem**: "Port 3001 is already in use"

**Solution**:
- Another program is using port 3001
- Wait for it to finish, or
- Restart your computer

---

## 💡 Pro Tips

### Staged Testing (Advanced Users)

For realistic testing, use three stages:
1. **Warm-up** - Low load to prepare the system
2. **Steady** - Normal peak load
3. **Cool-down** - Gradual wind-down

This better simulates real traffic patterns.

### Interpret the Numbers

```
Success Rate 95% = Normal
Success Rate 80% = Application struggling
Success Rate 50% = Application overloaded
```

```
P99 Latency 200ms = Good
P99 Latency 500ms = Acceptable
P99 Latency 2000ms = Needs optimization
```

---

## ❓ Frequently Asked Questions

**Q: Is this safe to use on production?**
A: Only if you own it and have permission. The tool is designed for safe testing of your own systems.

**Q: How do I test authenticated endpoints?**
A: Use Advanced mode with full JSON config that includes auth headers.

**Q: Why are my results inconsistent?**
A: Network, CPU, and disk I/O vary. Run multiple tests for better average results.

**Q: Can I test external APIs?**
A: Only if you have written permission from the API owner. Unauthorized load testing is illegal.

---

## 📞 Need Help?

1. Check test results for error messages
2. Review the URL and make sure app is running
3. Look at application logs while testing
4. Verify the environment variables if needed

---

Enjoy testing! 🎉
