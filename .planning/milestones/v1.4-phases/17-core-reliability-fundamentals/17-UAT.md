---
status: testing
phase: 17-core-reliability-fundamentals
source:
  - 17-01-SUMMARY.md
  - 17-02-SUMMARY.md
  - 17-03-SUMMARY.md
  - 17-04-SUMMARY.md
started: 2026-02-17T12:55:00Z
updated: 2026-02-17T12:57:00Z
---

## Current Test

number: 3
name: Pretty Logs - Development Mode
expected: |
  When NODE_ENV=development, logs are colorized and human-readable (not raw JSON). The output uses pino-pretty formatting with colors for different log levels.
awaiting: user response

## Tests

### 1. Configuration Validation - Missing API Keys
expected: |
  Starting the service without API_KEYS environment variable should fail immediately with a clear error message. The error should indicate that API_KEYS is required, and the process should exit with code 78 (EX_CONFIG).
result: pass

### 2. Structured Logging - Production Mode
expected: |
  When NODE_ENV=production, the service emits structured JSON logs. Sensitive fields like req.headers.authorization, cookie, x-api-key, password, secret, apiKey, and token are redacted and show as "[REDACTED]".
result: pass

### 3. Pretty Logs - Development Mode
expected: |
  When NODE_ENV=development, logs are colorized and human-readable (not raw JSON). The output uses pino-pretty formatting with colors for different log levels.
result: pending

### 4. Health Endpoint - Healthy Response
expected: |
  GET /health returns HTTP 200 when the database is healthy. The response includes: status (healthy), timestamp (ISO format), version (from package.json), and checks object with database, eventBus, and sseManager statuses.
result: pending

### 5. Health Endpoint - Component Status
expected: |
  The /health response includes component checks: database (ok/failed), eventBus (ok/degraded/unknown), sseManager (ok/degraded/unknown). It also includes stats: eventBus.listenerCount, sseManager.clientCount, and sseManager.uptime.
result: pending

### 6. Health Endpoint - Unhealthy Database
expected: |
  When the database is down or unreachable, GET /health returns HTTP 503 with status: unhealthy and checks.database: failed.
result: pending

### 7. Connection Timeouts
expected: |
  The service has configurable timeouts: connectionTimeout (2 min), requestTimeout (1 min), keepAliveTimeout (10 sec). These can be set via environment variables and prevent hung connections.
result: pending

### 8. Graceful Shutdown
expected: |
  Sending SIGTERM to the running service triggers graceful shutdown: stops accepting new connections, runs WAL checkpoint, closes database, and exits cleanly with code 0.
result: pending

### 9. Exit Codes
expected: |
  The service uses standard exit codes: 0 for success, 78 for configuration errors, 70 for software errors. Scripts can rely on these codes for automation.
result: pending

### 10. Periodic WAL Checkpoint
expected: |
  The service runs WAL checkpoint every 15 minutes (configurable via WAL_CHECKPOINT_INTERVAL_MS) to prevent the WAL file from growing unbounded.
result: pending

## Summary

total: 10
passed: 2
issues: 0
pending: 8
skipped: 0

## Gaps

(none yet)
