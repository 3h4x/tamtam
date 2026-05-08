---
model: fast
schedule: 8h
---

Check the TamTam application logs for errors, warnings, and anomalies by running: curl -s 'http://localhost:1337/api/monitoring/pm2-logs' | jq -r '.lines[]' 2>/dev/null || curl -s 'http://localhost:1337/api/monitoring/pm2-logs' . Analyze the output for repeated errors, stack traces, unhandled rejections, or missing log context that hints at silent failures. If you find a clear bug, fix it in the source code. If logs are noisy but not bugs (e.g. verbose but unhelpful messages), improve the log statement. If everything looks healthy, add a brief comment to the run log and exit. Always run pnpm type-check after any code change.
