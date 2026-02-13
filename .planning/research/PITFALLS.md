# Pitfalls Research

**Domain:** SQLite-backed task tracking service with REST + MCP APIs on Linux
**Researched:** 2026-02-13
**Confidence:** HIGH

## Critical Pitfalls

Mistakes that cause rewrites, data corruption, or major security issues.

### Pitfall 1: SQLite Transaction Upgrade Deadlock

**What goes wrong:**
Read transactions that upgrade to write transactions cause immediate SQLITE_BUSY errors even with busy_timeout configured. Multiple concurrent agent clients attempting to read then write creates instant deadlocks that ignore timeout settings.

**Why it happens:**
SQLite requires exclusive write locks. When a connection starts a read transaction (`BEGIN`), then tries to write (INSERT/UPDATE), it must upgrade to a write transaction. If another connection has already begun modifying the database, the upgrade fails immediately with SQLITE_BUSY, completely ignoring the configured timeout.

**Consequences:**
- SQLITE_BUSY errors appear instantly even with 5-10 second timeouts
- Errors correlate with concurrent agent requests
- Operations work in isolation but fail with multiple clients
- Debugging is difficult because errors seem contradictory (timeout ignored)

**Prevention:**
- Use `BEGIN IMMEDIATE` instead of `BEGIN` when writes are expected
- Never start with read transaction and upgrade to writes
- Structure API endpoints to declare intent: read-only vs. write operations
- For REST endpoints that modify data, use IMMEDIATE transactions
- For MCP tools that write, use IMMEDIATE from the start
- Document this pattern clearly for all database access code

**Detection:**
- SQLITE_BUSY errors appear even with high busy_timeout values
- Errors occur immediately, not after waiting
- Database operations work in single-threaded tests but fail under concurrent load
- Error logs show "database is locked" despite proper timeout configuration

**Phase to address:**
Phase 1 (Core Data Layer) - Database connection pooling and transaction management must handle this from the start.

---

### Pitfall 2: WAL Checkpoint Starvation with Continuous Agent Activity

**What goes wrong:**
With multiple concurrent agent clients constantly querying tasks, there are never "reader gaps" (moments when no processes are reading). WAL file grows unbounded, eventually consuming all disk space or causing severe performance degradation.

**Why it happens:**
WAL mode requires checkpoints to merge write-ahead log back to main database file. PASSIVE checkpoints (default) cannot complete if any reader exists. If agents maintain continuous connections for watching task updates, checkpoints never complete and the WAL file grows without bound.

**Consequences:**
- WAL file (-wal) grows continuously without shrinking
- WAL file can reach several gigabytes, filling disk space
- Database directory fills disk space unexpectedly
- Query performance degrades over time as WAL grows
- Service fails when disk is full

**Prevention:**
- Configure `wal_autocheckpoint` appropriately (default 1000 pages, adjust based on workload)
- Implement periodic FULL or TRUNCATE checkpoints during quiet periods
- Design API clients to use polling intervals rather than persistent connections
- Monitor WAL file size and checkpoint completion rates
- Use `PRAGMA wal_checkpoint(TRUNCATE)` periodically (e.g., nightly maintenance)
- Consider connection pooling with max connection lifetime to force reader gaps
- Set up alerts when WAL file exceeds reasonable size (e.g., 10MB)

**Detection:**
- WAL file (-wal) grows continuously without shrinking back
- WAL file exceeds several megabytes or gigabytes
- `PRAGMA wal_checkpoint` returns non-zero for uncompleted frames
- Disk space alerts triggered by database directory growth
- Query performance degrades over days of operation

**Phase to address:**
Phase 1 (Core Data Layer) - WAL configuration and checkpoint strategy must be designed upfront.

---

### Pitfall 3: POSIX Advisory Lock Cancellation on Thread Close

**What goes wrong:**
On Linux, calling close() on any file descriptor to the database cancels ALL POSIX advisory locks for that file across all threads in the process. A background health check thread opening and closing the database file invalidates locks held by request-handling threads, corrupting the database.

**Why it happens:**
POSIX advisory locking quirk: "the close() system call will cancel all POSIX advisory locks on the same file for all threads and all file descriptors in the process." SQLite relies on these locks for concurrency control. A separate thread opening/closing the database file - even just to check existence - cancels locks held by active transactions.

**Consequences:**
- Database corruption appears during normal multi-threaded operation
- SQLite error: "database disk image is malformed"
- Corruption correlates with health checks or monitoring activity
- Data loss requiring restore from backup
- Complete service failure until database is repaired

**Prevention:**
- Use a single connection pool managed by a dedicated database layer
- Never open additional database connections for health checks or status queries
- Don't spawn threads that independently access the database file
- Use existing connection pool for all database access (including health checks)
- Document this danger clearly with warnings in code comments
- For systemd health checks, query an HTTP endpoint that uses existing pool
- Test with concurrent operations and health checks to verify safety

**Detection:**
- Database corruption appears during normal operation with no power failures
- Corruption correlates with health check or monitoring execution
- File system monitoring shows database opened by multiple threads
- SQLite integrity check (`PRAGMA integrity_check`) fails unexpectedly

**Phase to address:**
Phase 1 (Core Data Layer) and Phase 2 (REST API) - Architecture must enforce single connection pool from the start. Health check design must use pool.

---

### Pitfall 4: MCP Confused Deputy Token Theft

**What goes wrong:**
Attacker exploits static Client ID in MCP OAuth flow to steal authorization codes and access tokens. Multiple agents using same MCP server creates authorization ambiguity - server acts on behalf of wrong user or with attacker's stolen credentials.

**Why it happens:**
MCP proxy servers often use a single static OAuth Client ID for all users. When third-party authorization servers remember consent via cookies, an attacker can initiate OAuth flow, trick victim into authorizing, and intercept the authorization code because it redirects to the attacker's registered callback. Attackers exchange code for access token, gaining access to victim's connected services.

**Consequences:**
- Attacker gains access to victim's connected services (Gmail, Slack, GitHub, databases)
- Authorization ambiguity: cannot determine which user authorized action
- No audit trail showing who actually accessed resources
- Complete compromise of multi-user MCP deployment
- Violation of security principles (confused deputy problem)

**Prevention:**
- Implement per-user client ID registry for OAuth flows
- Validate client_id against approved list before starting auth flow
- Store consent decisions server-side in database, not in cookies
- Use short-lived, scoped tokens issued explicitly to MCP server
- Validate token audience and claims before using for API calls
- Implement user-scoped authentication for MCP tools (not shared credentials)
- Maintain audit trail of which user triggered which tool calls
- Never use token passthrough (passing client tokens to downstream APIs)

**Detection:**
- Single shared credential used across all MCP clients
- OAuth implementation uses static client ID for all users
- No per-user token tracking or validation
- MCP tools run with server-level permissions, not user-level
- Audit logs cannot distinguish between different users' actions

**Phase to address:**
Phase 4 (MCP Server) - Security model must be designed correctly from initial implementation. Cannot be retrofitted easily.

---

### Pitfall 5: Circular Task Dependency Loops

**What goes wrong:**
Task A depends on Task B, Task B depends on Task C, Task C depends on Task A. System allows creation, then queries hang, updates fail, or dependency resolution produces infinite loops. Agents attempting to determine "what can I work on next" time out or crash.

**Why it happens:**
Graph traversal without cycle detection. Developers implement dependency tracking as simple foreign keys without validation logic. REST API accepts dependency additions without checking for cycles. Recursive queries (CTEs) to find "all blockers" never terminate.

**Consequences:**
- Recursive CTE queries don't return or time out
- Database CPU spikes when querying task dependencies
- "Find available tasks" queries hang or run indefinitely
- Tasks stuck in permanent "blocked" state with no resolution
- LLM agents confused by impossible dependency chains
- Manual intervention required to break cycles

**Prevention:**
- Implement cycle detection on dependency insertion/update
- Use topological sort to validate dependency graph before accepting changes
- Return 400 Bad Request with clear message if adding dependency would create cycle
- For large graphs, limit dependency chain depth (e.g., max 10 levels)
- Add database constraint: CHECK constraint preventing task from depending on itself
- Implement breadth-first search with visited-node tracking for dependency resolution
- Add API endpoint to validate dependency graph integrity
- Include cycle path in error message: "Would create cycle: A → B → C → A"

**Detection:**
- Recursive CTE queries timeout or never complete
- Database CPU usage spikes when querying dependencies
- Dependency visualization shows circular paths
- Tasks appear as simultaneously blocked and blocking
- Agent reports inability to find actionable tasks despite tasks existing

**Phase to address:**
Phase 1 (Core Data Layer) - Dependency model must include cycle detection from the start. Retrofitting is expensive.

---

### Pitfall 6: N+1 Query Problem in Comment Threading

**What goes wrong:**
Loading a task with comments requires 1 query for task + N queries for comments + N queries for comment authors + N*M queries for threaded replies. A task with 50 comments and replies requires 200+ database queries. API response time degrades from milliseconds to seconds.

**Why it happens:**
ORM or naive SQL fetches parent entities, then loops to fetch related entities individually. Comment threading exacerbates this - each comment might have replies, each reply might have nested replies. Without JOIN queries or materialized paths, system performs separate SELECT for each relationship.

**Consequences:**
- Response times increase dramatically for tasks with many comments
- Database connection pool exhaustion under light load
- Profiler shows hundreds of identical SELECT queries with different IDs
- API becomes unusable as comment count grows
- Scaling problems appear early (at 100-200 comments)

**Prevention:**
- Use materialized path for threaded comments (single query with ORDER BY path)
- Implement eager loading with JOINs for comment + author data
- Denormalize comment counts into task table for list views
- Use CTEs or recursive queries to fetch entire comment tree in one query
- Add query logging in development to detect N+1 patterns
- Paginate comments (don't load all comments for old tasks, default to recent 50)
- Use `EXPLAIN QUERY PLAN` to verify JOIN efficiency

**Detection:**
- Database query count scales linearly with comment count
- Query logs show hundreds of nearly-identical SELECT statements
- Response time profiling shows database time dominates
- Connection pool shows high utilization with few concurrent requests
- Adding more comments to task causes proportional slowdown

**Phase to address:**
Phase 3 (Task Comments & Metadata) - Comment data model must be designed for efficient retrieval from the start.

---

### Pitfall 7: API Key Exposure in Query Parameters

**What goes wrong:**
REST API accepts authentication via query parameter (?api_key=xxx). API keys appear in server access logs, browser history, proxy logs, and error tracking systems. Keys are stolen from logs or intercepted by network monitoring. Attackers gain full access to task system.

**Why it happens:**
Query parameters are simpler to implement and test (just paste URL in browser). Developers don't realize URLs are logged everywhere: nginx access logs, application logs, reverse proxies, CDN logs, browser history, error tracking services. Unlike request headers, query parameters persist in many systems indefinitely.

**Consequences:**
- API keys appear in plain text in multiple log files
- Keys stolen from log files grant full system access
- Browser history contains working API keys
- Error tracking services (Sentry, etc.) capture URLs with keys
- Compliance violations (logging sensitive credentials)
- No way to revoke keys already in logs

**Prevention:**
- Use Authorization header exclusively: `Authorization: Bearer <api_key>`
- Return 401 Unauthorized if API key appears in query parameter
- Document header-based auth clearly in API documentation
- Implement request logging that redacts Authorization headers
- For MCP tools, use header-based authentication in HTTP calls
- Add integration tests that verify query-parameter authentication is rejected
- Configure nginx/reverse proxy to not log Authorization header

**Detection:**
- API documentation shows examples with ?api_key=
- Server access logs contain patterns matching API key format
- Error messages include full request URLs with keys
- No middleware to reject query-parameter authentication
- Security audit finds keys in log files

**Phase to address:**
Phase 2 (REST API) - Authentication mechanism must be secure from initial implementation. Changing later is breaking change.

---

### Pitfall 8: File System Lock Failure on Network Mounts

**What goes wrong:**
SQLite database file placed on NFS, CIFS, or other network filesystem. POSIX advisory locks fail or behave incorrectly. Multiple processes believe they have exclusive write access. Database becomes corrupted. All task data lost or requires complex recovery.

**Why it happens:**
Network filesystems often don't implement POSIX advisory locking correctly. SQLite relies on these locks for multi-process concurrency. NFS is particularly notorious for buggy locking implementation. Even if locking works sometimes, network delays or disconnections cause lock state inconsistencies that lead to corruption.

**Consequences:**
- Database corruption appears randomly without clear cause
- Corruption correlates with network issues or server moves
- Multiple "database is locked" errors despite low concurrency
- Complete data loss requiring restore from backup
- Service completely fails, cannot recover without intervention

**Prevention:**
- Store SQLite database on local filesystem only (ext4, xfs, btrfs on Linux)
- Document explicitly: database MUST be on local disk, never network mount
- Add startup validation: check if database path is on network filesystem, refuse to start
- Use `df -T` or parse `/proc/mounts` to verify local filesystem at startup
- If backups need network storage, copy completed database file after checkpoint
- Add systemd unit file with filesystem dependency on local mount
- Test deployment to verify database is on local storage

**Detection:**
- Database corruption appears without power failures or crashes
- Corruption correlates with network events
- Database file path contains /mnt/, /net/, or known NFS/CIFS paths
- `df` command shows filesystem type as nfs, nfs4, cifs, or similar
- SQLite documentation warnings about network filesystems apply

**Phase to address:**
Phase 0 (Infrastructure/Deployment) - Infrastructure requirements must specify local filesystem before any development starts.

---

### Pitfall 9: Stray Logging to STDOUT Corrupting MCP Protocol

**What goes wrong:**
MCP server logs debug messages, stack traces, or progress updates to stdout. MCP client (Claude Code) receives corrupted protocol messages. All tool calls fail. Agents cannot track tasks. Error messages are cryptic: "invalid JSON" or "unexpected token".

**Why it happens:**
MCP uses STDIO transport - JSON-RPC messages over stdin/stdout. Any print(), console.log(), or logging framework writing to stdout inserts non-JSON data into message stream. Client parser fails when it encounters "DEBUG: processing request..." between JSON messages. Problem is invisible to server (logs look fine in isolation) but completely breaks all clients.

**Consequences:**
- MCP tool calls fail with JSON parsing errors
- Error messages mention "unexpected token" or "invalid character"
- Server logs show successful processing, but client reports complete failures
- Testing with curl/HTTP works fine, but MCP client fails
- Adding debug logging makes problems worse, not better
- Agents completely unable to use MCP tools

**Prevention:**
- Configure logging framework to stderr exclusively (never stdout)
- For Python: use `logging.StreamHandler(sys.stderr)`
- For Node.js: configure winston/pino to use stderr
- Add startup message to stderr confirming logging configuration
- Test MCP server with official MCP inspector tool before integration
- Add prominent comment in code: "CRITICAL: MCP uses stdout for protocol, all logs MUST go to stderr"
- Implement structured logging to make accidental stdout writes more obvious
- Code review checklist: verify no print/console.log statements

**Detection:**
- MCP tool calls fail with JSON parsing errors
- Server logs show successful operations but client reports failures
- Error messages reference unexpected characters or tokens
- Testing with HTTP/REST works but STDIO MCP fails
- Problem gets worse when debug logging is enabled

**Phase to address:**
Phase 4 (MCP Server) - Logging configuration must be correct from first implementation. Difficult to debug if wrong.

---

### Pitfall 10: Missing Journal Files After Crash Leading to Corruption

**What goes wrong:**
Application crashes or power fails during write transaction. System recovery procedures move or delete "temporary" files including database.db-wal or database.db-journal. Next startup, SQLite cannot recover uncommitted transactions. Database is corrupted. Task data is inconsistent or completely lost.

**Why it happens:**
SQLite writes transaction data to journal files (-wal, -journal, -shm) before committing to main database. These files are critical for crash recovery. Cleanup scripts, backup tools, or system administrators see "temporary-looking" files and delete them. Without journal files, SQLite cannot roll back partial transactions or complete pending writes, leaving database in inconsistent state.

**Consequences:**
- Database corruption appears after system crashes or reboots
- Backup/restore doesn't work (only .db file copied, not journals)
- Integrity check fails after restoring from backup
- Data loss requires manual recovery or rebuild
- Cannot trust backup procedures

**Prevention:**
- Document clearly: never delete, move, or rename database-related files
- Keep database.db, database.db-wal, database.db-shm, database.db-journal together always
- Configure backup tools to include all database-related files atomically
- Use SQLite backup API (`sqlite3_backup_*`) or `VACUUM INTO` instead of file copying
- Add file monitoring to alert if journal files are deleted while service runs
- Implement health check that verifies database integrity (`PRAGMA integrity_check`)
- For backups, use `sqlite3_rsync` utility or official backup API
- Test backup/restore procedures regularly, verify integrity after restore

**Detection:**
- Database corruption appears after crashes but not during normal operation
- Backup procedures only copy .db file, not -wal or -journal files
- Cleanup scripts in /etc/cron.daily match *.journal or *.wal patterns
- Database directory shows missing -wal file during active writes
- `PRAGMA integrity_check` fails after backup restore

**Phase to address:**
Phase 5 (CLI & Operations) - Backup and recovery procedures must be designed correctly from the start.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| PRAGMA synchronous=OFF | 2-3x write performance | Database corruption on power failure or crash | Never in production, only throwaway dev/test |
| Single global database connection | Simple implementation | SQLITE_BUSY errors, no concurrency | Only for single-threaded CLI tools |
| No cycle detection on dependencies | Faster dependency insertion | Infinite loops in resolution, data integrity issues | Never - cost to add later is very high |
| Storing API keys in environment variables | Easy configuration | Keys in process listings, logs, crash dumps | Acceptable only if filesystem permissions strictly controlled |
| Loading all task comments eagerly | Simpler code structure | N+1 queries, severe performance degradation | Acceptable for MVP with guaranteed <100 comments/task |
| Array/JSON field for task tags | Avoids JOIN complexity | Cannot efficiently filter by tag, poor query performance | Acceptable for MVP, must refactor before scale |
| No request rate limiting | Simpler initial implementation | API abuse, resource exhaustion, DoS | Acceptable for internal-only, trusted deployment |
| Exposing auto-increment IDs | Convenient, matches database | Cannot safely migrate/merge data, info disclosure | Never - use UUIDs or scoped IDs from start |

---

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| MCP Client Auth | Using token passthrough from client to downstream APIs | Issue short-lived tokens specifically for MCP server, validate audience claims |
| SQLite Backup | Copying database file with cp/rsync while service runs | Use VACUUM INTO or SQLite backup API, or stop service during copy |
| systemd Service | Not handling SIGTERM gracefully | Implement signal handlers to close database connections cleanly before exit |
| REST API CORS | Allowing * origin with credentials | Specify exact allowed origins, or use * without credentials |
| Task Webhooks | Synchronous HTTP calls blocking request thread | Queue webhook events, deliver asynchronously via background worker |
| Git Integration | Storing full absolute repo paths in database | Store relative paths, configure base path separately in config |
| Health Checks | Opening separate database connection for checks | Use existing connection pool via HTTP endpoint query |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| No pagination on task lists | All tasks loaded in single query, memory exhaustion | Implement cursor-based pagination from start, default limit 100 | >1,000 tasks |
| Unbounded comment loading | API timeouts for tasks with many comments | Paginate comments, default to most recent 50 | >200 comments/task |
| Full task reindex on every update | High write latency, CPU spikes | Update search index incrementally for changed fields only | >10,000 tasks |
| No connection pooling | SQLITE_BUSY errors increase linearly | Implement pool with max 1 writer + N readers from start | >5 concurrent clients |
| Synchronous dependency validation | API latency increases with chain depth | Limit max dependency depth (10 levels), consider async validation | Dependency chains >10 deep |
| No database index on foreign keys | Slow JOINs, full table scans | Add indexes on task_id, parent_id, user_id, project_id | >5,000 tasks with relationships |
| Loading full task history | Memory exhaustion, slow queries | Separate current state from history table, paginate history | >100,000 task updates |
| No prepared statement reuse | Parse overhead for each query | Use prepared statements, bind parameters | High query volume (>100/sec) |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Shared API key for all agents | Cannot identify which agent took action, no audit trail, blast radius of compromise | Issue unique API key per agent, track usage and attribution |
| No task ownership validation | Any agent can modify/delete any task, privilege escalation | Implement ownership model, validate permissions on every access |
| SQL injection in task search | Database compromise, data exfiltration, complete system takeover | Use parameterized queries exclusively, never string concatenation |
| Storing API keys plaintext in database | Key theft if database file leaked or backed up insecurely | Hash API keys (bcrypt/argon2), store only hash, verify on auth |
| No rate limiting per API key | Single compromised key can DoS entire service | Implement per-key rate limits (e.g., 100 req/min), track in memory |
| MCP tools with unrestricted filesystem access | Agents can read arbitrary files, info disclosure, privilege escalation | Restrict tools to specific directories via chroot or path validation |
| No validation of task IDs in URLs | Enumeration attack, information disclosure about other users | Use UUIDs, validate ownership on every access before returning data |
| Exposing internal sequential IDs | Predictable resource access, reveals volume metrics | Use UUIDs for external API, keep sequential IDs internal only |
| No API key rotation mechanism | Compromised keys remain valid indefinitely | Implement key expiration and rotation, admin endpoint to revoke |

---

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No partial match in task search | Can't find tasks without exact title match, poor search experience | Implement FTS5 full-text search with ranking, or LIKE with wildcards |
| 500 errors for dependency cycle attempts | Confusing error, no actionable information | Return 400 with clear message: "Would create dependency cycle: Task A → B → C → A" |
| Silent failures for agent API calls | Agent receives 200 OK but operation didn't complete, incorrect state | Use correct HTTP status codes, include error details in structured response |
| No indication of task blocking status | Agents waste time on blocked tasks, poor workflow efficiency | Include blockers[] array in task response, add is_blocked boolean flag |
| Pagination without total count | Cannot show progress, unclear dataset size, poor UX | Include X-Total-Count header and/or total_count field in response |
| No bulk operations | Thousands of individual requests to update statuses, slow and fragile | Implement PATCH /tasks/bulk for batch updates, return per-item results |
| Timestamp format inconsistency | Parsing errors, timezone confusion, data quality issues | Use ISO 8601 with UTC exclusively (2026-02-13T15:30:00Z) everywhere |
| Generic error messages | Difficult debugging, unclear how to fix | Include request_id, error_code, human message, and machine-readable details |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **SQLite WAL mode**: Often missing checkpoint strategy - verify wal_autocheckpoint configured and periodic TRUNCATE checkpoints scheduled
- [ ] **API authentication**: Often missing key rotation mechanism - verify admin endpoint to revoke/regenerate keys exists and works
- [ ] **Task dependencies**: Often missing cycle detection - verify graph validation logic exists and tested with circular dependency attempts
- [ ] **MCP tools**: Often missing error handling for database locks - verify retry logic with exponential backoff implemented
- [ ] **REST API errors**: Often missing structured error format - verify all endpoints return consistent JSON error objects with code, message, details
- [ ] **Database migrations**: Often missing rollback capability - verify down migrations exist, tested, and documented
- [ ] **Comment threading**: Often missing depth limit - verify max nesting level enforced (prevent 100-level deep threads causing performance issues)
- [ ] **Task filtering**: Often missing index support - verify EXPLAIN QUERY PLAN shows index usage for common filter combinations
- [ ] **Service shutdown**: Often missing graceful connection close - verify SIGTERM handler closes database cleanly, waits for pending writes
- [ ] **Backup validation**: Often missing restore testing - verify backup can actually restore to working database with integrity check
- [ ] **API rate limiting**: Often missing burst allowance - verify implementation allows reasonable bursts, not strict per-second limits
- [ ] **MCP authentication**: Often missing per-user scoping - verify tools operate with user context, not server-wide shared credentials
- [ ] **Transaction management**: Often missing BEGIN IMMEDIATE - verify write operations use IMMEDIATE, not default read transactions
- [ ] **Connection pool**: Often missing health validation - verify connections tested before use, stale connections removed

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Transaction upgrade deadlock | LOW | Add BEGIN IMMEDIATE to write operations, restart service, verify fixed with load test |
| WAL checkpoint starvation | LOW | Run `PRAGMA wal_checkpoint(TRUNCATE)` manually, configure wal_autocheckpoint, add scheduled checkpoints |
| POSIX lock cancellation corruption | HIGH | Restore from last good backup, redesign to use single connection pool, prevent health check file access |
| MCP confused deputy attack | MEDIUM | Revoke all potentially stolen tokens, implement client ID registry, audit all access logs for suspicious activity |
| Circular dependency loops | MEDIUM | Identify cycles with graph analysis, break manually via SQL UPDATE, add cycle detection, run integrity check |
| N+1 query problem | MEDIUM | Add indexes, optimize queries with JOINs/CTEs, implement query result caching, add pagination |
| API key exposure in logs | HIGH | Revoke all exposed keys immediately, regenerate new keys, configure log redaction, audit who had access to logs |
| Network filesystem corruption | HIGH | Restore from backup, migrate database to local filesystem, add startup check to prevent network mount usage |
| STDOUT logging corruption | LOW | Fix logging config to stderr, restart MCP server, verify with MCP inspector tool |
| Missing journal file corruption | MEDIUM-HIGH | Restore from backup (if includes journals), run `PRAGMA integrity_check`, rebuild database if necessary, fix backup procedure |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Transaction upgrade deadlock | Phase 1 (Core Data Layer) | Load test with 10 concurrent write requests, verify no SQLITE_BUSY errors |
| WAL checkpoint starvation | Phase 1 (Core Data Layer) | Monitor WAL file size over 24h continuous load, verify stays under 10MB |
| POSIX lock cancellation | Phase 1 (Core Data Layer) | Code review shows single connection pool, health checks use pool not file access |
| MCP confused deputy | Phase 4 (MCP Server) | Security audit shows per-user token validation and audit logging |
| Circular dependencies | Phase 1 (Core Data Layer) | Unit tests attempt cycle creation, verify rejection with clear error |
| N+1 queries | Phase 3 (Comments & Metadata) | Query logs show <=3 queries per task load with comments |
| API key in query params | Phase 2 (REST API) | Integration tests verify query param auth rejected with 401 |
| Network filesystem locks | Phase 0 (Infrastructure) | Startup script checks `df -T`, refuses to start on network filesystem |
| STDOUT MCP corruption | Phase 4 (MCP Server) | MCP inspector test suite passes with no parse errors |
| Missing journal files | Phase 5 (CLI & Operations) | Backup restore test includes all files, integrity check passes |

---

## Sources

### SQLite Concurrency & Locking
- [Abusing SQLite to Handle Concurrency](https://blog.skypilot.co/abusing-sqlite-to-handle-concurrency/)
- [SQLite User Forum: Multiple Writers](https://sqlite.org/forum/info/b4e8b29ae409cd198652c6b7e70b53b702f269e67e1d2573d627feeba37bbf85)
- [File Locking And Concurrency In SQLite Version 3](https://sqlite.org/lockingv3.html)
- [SQLite concurrent writes and "database is locked" errors](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/)
- [What to do about SQLITE_BUSY errors despite setting a timeout](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/)
- [Four different ways to handle SQLite concurrency](https://medium.com/@gwendal.roue/four-different-ways-to-handle-sqlite-concurrency-db3bcc74d00e)

### SQLite WAL Mode
- [Write-Ahead Logging](https://sqlite.org/wal.html)
- [How SQLite Scales Read Concurrency](https://fly.io/blog/sqlite-internals-wal/)
- [Handling Concurrency in SQLite: Best Practices](https://www.sqliteforum.com/p/handling-concurrency-in-sqlite-best)
- [SQLite WAL File: Complete Guide 2026](https://copyprogramming.com/howto/sqlite-wal-file-size-keeps-growing)

### SQLite Corruption & Backup
- [How To Corrupt An SQLite Database File](https://sqlite.org/howtocorrupt.html)
- [SQLite Over a Network, Caveats and Considerations](https://sqlite.org/useovernet.html)
- [Backup strategies for SQLite in production](https://oldmoe.blog/2024/04/30/backup-strategies-for-sqlite-in-production/)
- [SQLite Backup API](https://www.sqlite.org/backup.html)
- [Understanding and Resolving the "SQLite Database is Locked" Error](https://www.beekeeperstudio.io/blog/how-to-solve-sqlite-database-is-locked-error)

### MCP Implementation & Security
- [Implementing model context protocol (MCP): Tips, tricks and pitfalls](https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/)
- [Security Best Practices - Model Context Protocol](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- [Model Context Protocol: Security Risks & Mitigations](https://socprime.com/blog/mcp-security-risks-and-mitigations/)
- [MCP Authorization Patterns for Upstream API Calls](https://www.solo.io/blog/mcp-authorization-patterns-for-upstream-api-calls)
- [MCP Security Checklist: Complete Protection Guide 2026](https://www.networkintelligence.ai/blogs/model-context-protocol-mcp-security-checklist/)
- [Securing the Model Context Protocol: A Comprehensive Guide](https://dasroot.net/posts/2026/02/securing-model-context-protocol-oauth-mtls-zero-trust/)

### REST API Design & Security
- [Top 10 Mistakes in REST API Design](https://newsletter.kanaiyakatarmal.com/p/top-10-mistakes-in-rest-api-design)
- [REST API Best Practices: A Developer's Guide](https://blog.postman.com/rest-api-best-practices/)
- [REST API Security Best Practices (2026)](https://www.levo.ai/resources/blogs/rest-api-security-best-practices)
- [API Keys: Weaknesses and security best practices](https://www.techtarget.com/searchsecurity/tip/API-keys-Weaknesses-and-security-best-practices)
- [The State of API Security in 2026: Common Misconfigurations](https://www.appsecure.security/blog/state-of-api-security-common-misconfigurations)

### Task Dependencies & Data Modeling
- [8 Data Modeling Mistakes to Avoid in 2025 for Accuracy](https://www.owox.com/blog/articles/mistakes-in-data-modeling)
- [Understanding and managing task dependencies in project management](https://www.hellobonsai.com/blog/task-dependencies)
- [How would you model posts, comments, and threaded chat replies in a relational database?](https://github.com/orgs/community/discussions/167352)

### API Pagination & Performance
- [REST API Design: Filtering, Sorting, and Pagination](https://www.moesif.com/blog/technical/api-design/REST-API-Design-Filtering-Sorting-and-Pagination/)
- [REST API Response Pagination, Sorting and Filtering](https://restfulapi.net/api-pagination-sorting-filtering/)

### Schema Migrations & Versioning
- [SQLite Versioning and Migration Strategies](https://www.sqliteforum.com/p/sqlite-versioning-and-migration-strategies)
- [How to Safely Modify Table Columns in SQLite with Production Data](https://synkee.com.sg/blog/safely-modify-sqlite-table-columns-with-production-data/)
- [API Versioning Best Practices](https://redocly.com/blog/api-versioning-best-practices)
- [How to Handle API Deprecation](https://oneuptime.com/blog/post/2026-02-02-api-deprecation/view)

---
*Pitfalls research for: Wood Fired Bugs - SQLite-backed task tracking service with REST + MCP APIs*
*Researched: 2026-02-13*
