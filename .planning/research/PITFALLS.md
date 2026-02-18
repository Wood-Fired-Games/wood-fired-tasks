# Pitfalls Research: Slack Integration

**Domain:** Adding Slack slash commands, Socket Mode, and bot notifications to existing Node.js/Fastify service
**Context:** Subsequent milestone — Wood Fired Bugs v1.5. Existing: Fastify, EventBus, SQLite, better-sqlite3, 636 tests.
**Researched:** 2026-02-17
**Confidence:** HIGH (all critical pitfalls verified with official Slack docs + bolt-js GitHub issues)

---

## Critical Pitfalls

### Pitfall 1: Calling ack() After Async Work Instead of Before

**What goes wrong:**
The slash command handler awaits a database query or service call before calling `ack()`. Slack's 3-second deadline passes. Users see "operation_timeout" error in Slack. The command appears to fail even though the work completed successfully. With 24 slash commands this is easy to repeat across the entire handler surface.

**Why it happens:**
Developers write handlers in natural "do work, then respond" order. The handler pattern looks like other async middleware—you do work then send a response. The key difference is that `ack()` is not the response: it is purely the receipt acknowledgment, and the actual response goes through `respond()` using the `response_url`. The work can continue after `ack()` returns.

**How to avoid:**
Call `ack()` as the very first statement in every slash command handler, before any async operation. Then perform all service calls, database queries, and business logic. Use `respond()` for the actual message back to the user.

```typescript
// WRONG — ack() after await
app.command('/tasks-list', async ({ ack, respond, command }) => {
  const tasks = await taskService.listTasks(...); // timeout if >3s
  await ack();
  await respond({ text: formatTaskList(tasks) });
});

// CORRECT — ack() first, always
app.command('/tasks-list', async ({ ack, respond, command }) => {
  await ack(); // acknowledge immediately
  const tasks = await taskService.listTasks(...); // safe, no deadline
  await respond({ text: formatTaskList(tasks) });
});
```

Note: `processBeforeResponse: true` (for AWS Lambda / FaaS) changes this behavior and should NOT be set for a long-running Node.js process. Verify this option is absent from the Bolt App constructor.

**Warning signs:**
- Users see "This slash command's response URL has expired or the app did not respond in time" in Slack
- bolt-js logs show `operation_timeout` events
- Tests pass locally but commands fail in Slack when the database is slow
- Any handler has `await` before `await ack()`

**Phase to address:**
Slash Command Foundation phase — enforce ack-first pattern as a review checklist item for all 24 command handlers. Add a lint rule or comment convention flagging violations.

---

### Pitfall 2: Socket Mode Runs Two Independent Event Loops (Bolt vs. Fastify)

**What goes wrong:**
Bolt's default initialization creates its own HTTP server on port 3000 (via ExpressReceiver) alongside the existing Fastify server on port 3001. They are two separate event listeners. In Socket Mode this manifests differently: Bolt creates a `SocketModeReceiver` that handles all WebSocket communication but if you also pass a custom `receiver:` to the constructor with `socketMode: true`, Bolt silently discards the custom receiver (bolt-js issue #834). Routes defined on that receiver become unreachable with no error.

**Why it happens:**
Bolt was designed around Express. Socket Mode changed how the receiver works, but the behavior of silently dropping custom receivers when `socketMode: true` persisted until it was partially fixed. Developers expect to be able to register Slack slash-command routes on the Fastify server like any other route.

**How to avoid:**
Use Socket Mode as the primary transport (no HTTP receiver needed for Slack events — the WebSocket handles everything). Do not pass a custom Fastify receiver when `socketMode: true`. The Bolt `App` instance is a standalone component that communicates via WebSocket outbound; it does not need to listen on a port for slash commands.

```typescript
// CORRECT for Socket Mode — no receiver needed
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  // DO NOT pass receiver: here
});

// Fastify server is completely separate — no conflict
await fastify.listen({ port: 3001 });
await slackApp.start(); // connects WebSocket, no port binding
```

The two "loops" coexist safely: Fastify owns HTTP, Bolt owns the WebSocket to Slack. They share the same Node.js process and can share service instances.

**Warning signs:**
- Bolt attempts to start a server on port 3000 when your Fastify server is on 3001
- Custom Fastify routes registered via a Bolt receiver are unreachable (404)
- No error thrown when passing `receiver:` alongside `socketMode: true` (older bolt-js versions)
- Bolt logs show "Listening on port 3000" — it should show WebSocket connection logs, not port binding

**Phase to address:**
Socket Mode Infrastructure phase — the startup wiring (index.ts or createApp) is where this gets decided. Validate by checking that Fastify starts on 3001 and Bolt logs show WebSocket URL, not HTTP port.

---

### Pitfall 3: too_many_websockets Errors From Stale Connections on Service Restart

**What goes wrong:**
Every time the service restarts (during development or after a crash), `slackApp.start()` opens a new WebSocket connection. Previous connections from before the restart are still registered against the app-level token from Slack's side until they time out (~30 minutes). With frequent restarts Socket Mode reports `disconnect reason: too_many_websockets`. The limit is 10 concurrent connections per app. Events start distributing randomly across all connections (round-robin), causing event loss and duplicate processing.

**Why it happens:**
The app-level token keeps WebSocket connections alive server-side even after the client disconnects uncleanly (crash, kill -9, nodemon restart). Socket Mode's reconnection logic may also open additional connections during its own retry attempts, compounding the problem.

**How to avoid:**
1. In development, avoid rapid service restarts (use `--watch` with Node.js 22 native watch mode rather than nodemon, which reduces restart frequency).
2. Call `await slackApp.stop()` in Fastify's `onClose` hook before process exit to close the WebSocket cleanly.
3. If `too_many_websockets` occurs, revoke and regenerate the app-level token in the Slack console — this resets all connections.
4. Do not run multiple instances of the service locally (systemd + development terminal simultaneously).

```typescript
// Register cleanup so Bolt closes WebSocket on graceful shutdown
fastify.addHook('onClose', async () => {
  await slackApp.stop();
});
```

**Warning signs:**
- bolt-js logs: `Received "disconnect" (reason: too_many_websockets) message`
- Commands work for the first connection but randomly stop responding after several restarts
- Slack delivers some events but not others (round-robin distribution across stale + active connections)
- `too_many_websockets` in logs within seconds of a fresh restart

**Phase to address:**
Socket Mode Infrastructure phase — add `slackApp.stop()` to the existing graceful shutdown hook at the same time as `slackApp.start()` is added.

---

### Pitfall 4: Signing Secret Verification Fails Due to Raw Body Consumption

**What goes wrong:**
If Slack were ever sending HTTP requests (e.g., during development testing with forwarded requests or if Socket Mode is disabled temporarily), the `x-slack-signature` verification fails because the request body was already consumed by Fastify's JSON parser before Bolt's signature check reads it. This produces `slack_bolt_receiver_authenticity_error` and all events are rejected with 401. Even in full Socket Mode this is a concern for any HTTP-based health or OAuth endpoints Bolt might serve.

**Why it happens:**
HMAC-SHA256 signature verification requires the raw, unparsed request body as a string. Fastify (and Express) body parsers deserialize JSON before middleware runs, giving Bolt a parsed object instead of the raw bytes. The computed signature mismatches because the input differs.

**How to avoid:**
In Socket Mode, Bolt does not receive HTTP requests for slash commands — this removes the primary risk. However, if any HTTP-mode testing is done:
- Configure Fastify to preserve the raw body on `/slack/events` routes.
- Ensure Bolt's receiver reads from the raw buffer, not the parsed JSON.
- Never forward already-parsed bodies to Bolt.
- Verify with a real 5-minute timestamp window — reject replayed requests.

For the production Socket Mode path: sign verification happens Slack-side over the WebSocket TLS channel, so this pitfall is substantially reduced. Still document it so the team doesn't accidentally add an HTTP receiver later.

**Warning signs:**
- `slack_bolt_receiver_authenticity_error` in logs
- All slash commands return 401 or are silently rejected
- Signature mismatch despite correct signing secret in `.env`
- Intermittent failures that correlate with body parse timing

**Phase to address:**
Socket Mode Infrastructure phase — use Socket Mode exclusively, avoiding HTTP receivers, to sidestep this entirely.

---

### Pitfall 5: Bot Cannot Post to Channel Because It Was Never Invited

**What goes wrong:**
The notification system calls `client.chat.postMessage({ channel: '#bugs-channel', ... })` and receives `not_in_channel` error. The bot was authorized (correct scopes, valid token) but was never added as a member of the target channel. Notifications silently fail or throw uncaught errors. Users see no notifications even though subscriptions exist in SQLite.

**Why it happens:**
Developers test with DMs (where the bot is always a participant) but forget that `chat.postMessage` to a channel requires the bot to be an explicit channel member — unless the `chat:write.public` scope is added. The scope `chat:write` alone is insufficient for channels the bot has not joined.

**How to avoid:**
Two options:
1. **Add `chat:write.public` scope** to the bot's OAuth scopes in the Slack app config. This allows posting to any public channel without joining. This is the right choice for a single-workspace internal tool.
2. **Require `/invite @wood-fired-bugs`** during channel subscription setup and emit a clear error message if the bot is not in the channel when `chat.postMessage` fails.

Option 1 is simpler and more reliable. Document the required scopes explicitly in the setup guide.

**Warning signs:**
- `not_in_channel` errors in logs when posting notifications
- Notifications work in DMs but fail in channels
- Channel subscription record exists in SQLite but no messages are sent
- `channel_not_found` errors for private channels (bot not invited, channel appears not to exist)

**Phase to address:**
Bot Notification phase — add `chat:write.public` scope to the app manifest and verify during subscription registration.

---

### Pitfall 6: Using Slack Display Names as Assignee Identifiers (Not User IDs)

**What goes wrong:**
The system stores `profile.display_name` as the task assignee when a user runs `/tasks-assign @username`. Display names are not unique in Slack — two users can have the same display name. Display names change when users update their profile. A user renamed `"Stuart"` to `"Stuart W"` breaks all tasks assigned to the old name. The lookup from user ID to display name requires an API call on every display.

**Why it happens:**
Display names are human-readable and seem like the obvious choice. The `@mention` in a slash command looks like a username. Developers store what they see rather than the underlying user ID.

**How to avoid:**
Store Slack user IDs (format: `U012AB3CD`) as the canonical assignee identifier everywhere — in SQLite, in task records, in all service layer logic. Resolve user IDs to display names only at presentation time. Cache the ID-to-name mapping in memory (or SQLite) with a TTL of 1 hour, refreshing via `users.info` on cache miss.

```
task.assignee = "U012AB3CD"          // stored in DB — stable
display: resolve("U012AB3CD") → "Stuart W"  // resolved at render time
```

Slack's own documentation explicitly states: "Your apps should really no longer be concerned with usernames or the name field. Reference user IDs instead."

**Warning signs:**
- `assignee` column in tasks table contains strings like `"stuart"` or `"Stuart W"` (not `U012AB3CD`)
- `/tasks-mine` command returns different results after a user renames themselves
- Two users share a display name and get each other's tasks
- Display name lookup fails for deactivated users (their `users.info` still returns but with a deactivated flag)

**Phase to address:**
Slash Command Foundation phase — define the data model before writing any command handlers. If the existing `assignee` field in tasks already stores strings, the migration strategy must be documented.

---

### Pitfall 7: Rate Limit Exhaustion From Unbatched users.info Calls

**What goes wrong:**
Every time a task list is displayed in Slack (e.g., `/tasks-list` returns 20 tasks), the handler calls `users.info` once per task to resolve assignee names. With 20 tasks, that's 20 API calls. `users.info` is a Tier 3 method (50+ per minute). A channel with active agents running frequent `/tasks-list` commands exhausts the rate limit within minutes. The Slack Web API returns HTTP 429, bolt-js retries with backoff, and commands hang until the quota resets. Users experience multi-second or multi-minute delays.

**Why it happens:**
Individual item rendering feels natural. Developers don't realize that a single command can fan out to many API calls. `users.info` rate limits are per-app-per-workspace — all commands share the same quota.

**How to avoid:**
Implement a user display name cache in memory (or SQLite) keyed by user ID with a 1-hour TTL. Populate it lazily on first lookup. For bulk task lists, deduplicate user IDs before calling `users.info` — a list of 20 tasks might only have 3 unique assignees.

```typescript
class SlackUserCache {
  private cache = new Map<string, { name: string; expiresAt: number }>();
  async getDisplayName(userId: string): Promise<string> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;
    const user = await slackClient.users.info({ user: userId });
    const name = user.user?.profile?.display_name || user.user?.real_name || userId;
    this.cache.set(userId, { name, expiresAt: Date.now() + 3600_000 });
    return name;
  }
}
```

**Warning signs:**
- Commands that return long task lists are slow or time out
- bolt-js logs show `RateLimitedError` or `retryAfter` events
- `/tasks-list` works fine with 3 tasks but hangs with 30 tasks
- Memory usage grows unbounded if cache has no TTL or size limit

**Phase to address:**
Slack Notification / Display Name Resolution phase — build the cache before implementing any command that renders task lists with assignees. Set a max cache size (e.g., 500 entries) to prevent memory growth.

---

### Pitfall 8: Channel Subscription Table Missing Index on channel_id

**What goes wrong:**
The notification fan-out queries `SELECT * FROM slack_channel_subscriptions WHERE event_type = ?` to find which channels should receive a given event. Without an index on `(event_type)` or `(channel_id, event_type)`, this becomes a full table scan. With 50 subscriptions across 10 channels this is trivial, but the query runs on every task update event. The EventBus fires `task.updated` on every task save — including bulk imports and workflow automation cascades. Notification queries start showing up in slow-query logs.

**Why it happens:**
SQLite tables are created without indexes by default. A small number of subscriptions makes the missing index invisible during development. The interaction with the EventBus-driven notification loop (which fires synchronously in the event loop) means slow queries block event processing.

**How to avoid:**
Add `CREATE INDEX IF NOT EXISTS idx_subscriptions_event_type ON slack_channel_subscriptions(event_type)` in the migration that creates the subscriptions table. Also index `(active, event_type)` if subscriptions can be disabled without being deleted.

**Warning signs:**
- `tasks doctor` shows slow queries on the subscriptions table
- Notification delivery slows during bulk task imports (many events firing)
- EXPLAIN QUERY PLAN shows "SCAN" instead of "SEARCH" on subscriptions queries
- Event loop lag increases during workflow automation cascades

**Phase to address:**
Slack Subscription Persistence phase — add indexes in the same migration as the table creation, never as a follow-up.

---

### Pitfall 9: EventBus Subscriber Error Kills Notification Delivery Silently

**What goes wrong:**
The Slack notification subscriber registers on the EventBus with a handler that calls `client.chat.postMessage(...)`. If `postMessage` throws (network blip, not_in_channel, rate limit), the EventBus's try/catch wrapper catches the error and logs it — but the notification is lost silently. The EventBus was designed to isolate subscriber errors to prevent crashes, but this means failed notifications are not retried and the user never knows a notification was dropped.

**Why it happens:**
The existing `EventBus.subscribe()` wraps handlers in try/catch (see `event-bus.ts` line 42-49). This is correct for SSE — a failed SSE broadcast should not crash the service. But for Slack notifications, "failed silently" means an important alert was dropped. The same isolation that protects SSE becomes a hidden failure mode for Slack.

**How to avoid:**
Implement retry logic inside the Slack notification subscriber itself, before the error reaches the EventBus wrapper. Use exponential backoff for transient errors (network, rate limits) and log + dead-letter permanent failures (`not_in_channel`, invalid channel).

```typescript
// Wrap with retry INSIDE the subscriber — don't rely on EventBus to retry
eventBus.subscribe('task.updated', async (event) => {
  await withRetry(
    () => notifySlackChannels(event),
    { maxAttempts: 3, backoff: 'exponential' }
  );
});
```

Do not use `async` handlers in the current EventBus (it is synchronous — `handler: (payload) => void`). Either make the EventBus support async handlers, or fire-and-forget with internal error handling.

**Warning signs:**
- Slack notifications sometimes don't arrive but no errors appear in logs
- "Error in event handler" log lines appear during Slack API rate limiting
- bot-js retry events visible in Slack SDK debug logs but notifications never deliver
- Notifications work during testing (no errors) but drop under load

**Phase to address:**
Slack Notification Integration phase — design the subscriber error handling before wiring it to the EventBus. Also evaluate whether the EventBus needs to support async handlers for this milestone.

---

### Pitfall 10: Slash Commands Registered With Wrong Pattern — Bolt Receives Nothing

**What goes wrong:**
A command is registered in the Slack App Dashboard (e.g., `/tasks-list`) but the Bolt handler pattern doesn't match (e.g., `app.command('/tasks_list', ...)` with underscore vs. dash). Slack sends the command over the WebSocket, Bolt receives it, finds no matching handler, and returns a generic "dispatch_failed" to Slack. Users see "An error occurred" with no detail. With 24 commands this is easy to get wrong for several of them.

**Why it happens:**
The command name in the Slack Dashboard and the string in `app.command(...)` must match exactly, including slashes, dashes, and underscores. There is no automatic normalization. With 24 commands, one typo in either place silently breaks that command.

**How to avoid:**
Maintain a single source of truth: a `SLACK_COMMANDS` constant array listing all command names. Register commands in Bolt by iterating this array. Keep the Slack Dashboard configuration aligned with this array. Add an integration test that verifies each registered command name matches a registered handler.

```typescript
export const SLACK_COMMANDS = [
  '/tasks-list', '/tasks-create', '/tasks-view', '/tasks-assign',
  // ... all 24 commands
] as const;
```

**Warning signs:**
- Slack shows "dispatch_failed" or "An error occurred" for specific commands but not others
- bolt-js does not log any handler execution for a command that was invoked
- The Slack Dashboard shows a command configured but `app.command()` uses a different string
- "Did you mean?" style confusion between dashes and underscores in command names

**Phase to address:**
Slash Command Foundation phase — define the command registry before registering any handlers.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Store `display_name` instead of user ID as assignee | Readable in DB | Breaks on rename, not unique, migration required | Never |
| Skip user display name caching (always call `users.info`) | Simpler code | Rate limit exhaustion at scale, slow command responses | Never |
| Hardcode Slack tokens in source or config files | Fast setup | Token exposure in git, security incident, rotation required | Never |
| Add `processBeforeResponse: true` for a long-running service | Matches FaaS docs | ack() timeout on any slow command | Never |
| Use `app.command('*', ...)` catch-all for unhandled commands | Avoids dispatch_failed | Swallows all routing errors, hides configuration bugs | Never for production |
| Skip per-channel subscription validation on subscribe | Simpler setup | Notifications silently fail for invalid channel IDs | Only in MVP with clear TODO |
| Sync Slack notification calls in EventBus handler | Simpler code | Blocks event loop during API calls | Never |

---

## Integration Gotchas

Common mistakes when connecting Slack to the existing Fastify/EventBus/SQLite service.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Bolt + Socket Mode | Passing `receiver:` alongside `socketMode: true` | Omit receiver; Bolt manages WebSocket internally |
| Bolt + Fastify | Running both on the same port | Fastify owns HTTP (3001); Bolt WebSocket is outbound only |
| EventBus + Slack | Async Slack API calls in sync EventBus handler | Fire-and-forget with internal retry; do not block |
| Slash command + DB | `await taskService...` before `await ack()` | Always `await ack()` first |
| Notification + Channel | `chat.postMessage` without `chat:write.public` scope | Add `chat:write.public` for single-workspace internal tool |
| Assignee + Slack | Storing `display_name` as assignee | Store user ID (`U012AB3CD`), resolve name at display time |
| Shutdown + WebSocket | Not stopping Bolt on process exit | Add `slackApp.stop()` to Fastify `onClose` hook |
| App token + Restarts | Process crashes leave stale WebSocket connections | Clean stop on shutdown; revoke/rotate token if `too_many_websockets` |
| better-sqlite3 + Async | Calling async Slack APIs inside SQLite transactions | Never await async I/O inside `db.transaction()` |

---

## Performance Traps

Patterns that work at small scale but degrade as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| N calls to `users.info` per task list | Commands slow, rate limit errors | In-memory user ID cache with 1h TTL | >10 tasks with assignees per command invocation |
| Unbounded user cache | Memory grows as workspace grows | LRU cap at 500 entries | Workspace > 500 members |
| Sync notification in EventBus handler | Event loop lag during task events | Async fire-and-forget with internal retry | Any moderate event volume |
| Full table scan on subscriptions | Slow notifications during bulk events | Index on `(event_type)` at creation time | >20 subscriptions |
| `conversations.list` for channel validation | Slow subscription setup | Cache channel list locally; Tier 2 (20/min) | Repeated validation calls |
| Posting notification for every EventBus event | Rate limit exhaustion on workflow cascades | Debounce/deduplicate events per task per second | Workflow with >5 cascade events |

---

## Security Mistakes

Domain-specific security issues for Slack integration.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Logging bot token or signing secret | Token exposure in log files, rotation required | Never log `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET`; use structured logging redaction |
| Storing tokens in `.env` committed to git | Token exposure in repo history | Add `.env` to `.gitignore` before first commit; use `dotenv` for local dev only |
| Not validating that slash command user is workspace member | Any HTTP client can forge commands | In Socket Mode, Slack validates all commands before delivery — no custom validation needed |
| Trusting `user_id` in slash command payload | Could be spoofed in HTTP mode | In Socket Mode, Slack authenticates the WebSocket — payload is trustworthy |
| Using `chat:write` without `chat:write.public` and trying to post to unjoined channels | Silent notification failure | Add `chat:write.public` for internal tool or require bot invite |
| Not rotating tokens after exposure | Ongoing compromise window | Treat tokens like passwords; document rotation procedure |
| Exposing signing secret through error messages | Client can forge signatures | Never echo config values in error responses |

---

## UX Pitfalls

Common user experience mistakes in Slack bot design.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Long ephemeral response for task lists | Wall of unformatted text | Use Slack Block Kit with sections; paginate at 10 tasks |
| No acknowledgment visible while work runs | User thinks command failed; runs it again | ack() with a short "Working..." text if operation may take >1s |
| Bot posts notifications to wrong channel | Noise in unrelated channels | Validate channel ID at subscription time, not at notification time |
| Notification for every task update (no filtering) | Notification spam | Filter by event_type in subscription; allow `status_changed` vs. `all` |
| Error messages expose internal details | Security + confusion | Return user-friendly messages; log detailed errors server-side |
| Commands with ambiguous names | Users can't discover commands | Follow Slack's slash command naming guide; use `/tasks-` prefix consistently |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Slash commands:** Every handler has `await ack()` as first statement — verify with grep/AST
- [ ] **Socket Mode:** Bolt logs WebSocket connection URL, NOT "Listening on port 3000"
- [ ] **Shutdown:** `slackApp.stop()` is registered in Fastify `onClose` hook alongside existing cleanup
- [ ] **Bot scopes:** `chat:write.public` is in the Slack app manifest for channel posting
- [ ] **Assignee storage:** `slack_subscriptions` and task assignee fields store user IDs (`U...`), not display names
- [ ] **User cache:** `users.info` is never called more than once per unique user ID per hour
- [ ] **Subscription index:** `slack_channel_subscriptions` migration includes index on `event_type`
- [ ] **Token safety:** `.env` is in `.gitignore`; tokens are not logged at any level
- [ ] **Tokens distinguished:** `SLACK_APP_TOKEN` (`xapp-...`) is distinct from `SLACK_BOT_TOKEN` (`xoxb-...`)
- [ ] **Command registry:** All 24 command names match exactly between Slack Dashboard and `app.command()` calls

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| `operation_timeout` on commands | LOW | Find handler, move `ack()` to first line, redeploy |
| `too_many_websockets` | LOW | Revoke and regenerate app-level token in Slack Dashboard; restart service |
| Wrong assignee type (display name stored) | HIGH | Migration to convert stored names to user IDs via `users.lookupByEmail` or manual mapping |
| Token committed to git | HIGH | Immediately revoke token in Slack Dashboard; rotate; purge from git history; audit access |
| Bot not in channel (silent notification failure) | LOW | Add `chat:write.public` scope; reauth app; or invite bot manually |
| User cache unbounded | LOW | Add LRU cap; restart service to clear |
| Missing subscription index | MEDIUM | Add index migration; run against production DB; verify with EXPLAIN QUERY PLAN |
| Notification lost silently (EventBus catches error) | MEDIUM | Add retry wrapper in subscriber; review and replay missed notifications from event logs |

---

## Pitfall-to-Phase Mapping

How Slack integration phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| ack() after async work | Slash Command Foundation | grep for any `await` before `await ack()` in command handlers |
| Bolt + Fastify port conflict | Socket Mode Infrastructure | Service starts without port conflict; Bolt logs WebSocket URL |
| too_many_websockets on restart | Socket Mode Infrastructure | `slackApp.stop()` present in `onClose`; clean restart leaves no stale connections |
| Signing secret / raw body issue | Socket Mode Infrastructure | Using Socket Mode exclusively; no HTTP receiver configured |
| Bot not in channel | Bot Notification setup | `chat:write.public` in app manifest; test post to unjoined channel succeeds |
| Display name as assignee | Slash Command Foundation | `assignee` values in test DB are `U...` format |
| Rate limit from unbatched user lookups | Display Name Resolution phase | Task list with 20 items triggers ≤3 `users.info` calls |
| Missing subscription index | Slack Subscription Persistence | EXPLAIN QUERY PLAN shows SEARCH not SCAN on event_type |
| Silent notification failure | Slack Notification Integration | Simulate `not_in_channel` error; verify retry attempts and error is logged |
| Command name mismatch | Slash Command Foundation | Integration test that maps `SLACK_COMMANDS` array against registered handlers |

---

## Key Insight: Socket Mode Removes Most HTTP Attack Surface

Using Socket Mode (no public URL) eliminates the largest class of Slack integration problems:
- No request signature verification failures from body parser interference
- No need to expose a public endpoint (no ngrok, no port forwarding, no firewall rules)
- No replay attacks (Slack authenticates the WebSocket channel)
- No incorrect `x-slack-request-timestamp` clock skew issues

The primary risks shift to:
1. **WebSocket lifecycle management** (disconnect handling, stale connections, clean shutdown)
2. **Application-level correctness** (ack() timing, command name matching)
3. **Data model decisions** (user ID storage, subscription schema)
4. **Rate limit discipline** (user info caching, event debouncing)

These are all manageable with discipline rather than infrastructure.

---

## Sources

### Slack Bolt and Socket Mode
- [Using Socket Mode — Slack Official Docs](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Socket Mode reliability issues — bolt-js #1151](https://github.com/slackapi/bolt-js/issues/1151)
- [Custom receiver discarded with socketMode — bolt-js #834](https://github.com/slackapi/bolt-js/issues/834)
- [too_many_websockets error — bolt-js #2238](https://github.com/slackapi/bolt-js/issues/2238)
- [WebSocket disconnection handling — node-slack-sdk #1243](https://github.com/slackapi/node-slack-sdk/issues/1243)
- [Bolt + Fastify integration gist by @seratch](https://gist.github.com/seratch/2b97e752645e83322a1066a9c24e2a20)

### Slash Commands and ack() Deadline
- [Implementing slash commands — Slack Official](https://api.slack.com/interactivity/slash-commands)
- [Acknowledging requests — Bolt for JavaScript Docs](https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/)
- [operation_timeout after immediate ack — bolt-js #1548](https://github.com/slackapi/bolt-js/issues/1548)
- [operation_timeout — bolt-js #1727](https://github.com/slackapi/bolt-js/issues/1727)

### Security and Token Management
- [Verifying requests from Slack — Official](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Security best practices — Slack Official](https://api.slack.com/authentication/best-practices)
- [Slack bot token remediation — GitGuardian](https://www.gitguardian.com/remediation/slack-bot-token)

### Rate Limits
- [Rate limits — Slack Developer Docs](https://docs.slack.dev/apis/web-api/rate-limits/)
- [Rate limit changes for non-Marketplace apps, May 2025](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/) — internal apps unaffected
- [Best way to maintain users/channels cache — node-slack-sdk #1345](https://github.com/slackapi/node-slack-sdk/issues/1345)

### Channel Membership and Scopes
- [chat.postMessage — Slack Official](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Troubleshooting channel_not_found — Knock](https://knock.app/blog/troubleshooting-channel-not-found-in-slack-incoming-webhooks)

### Display Names and User IDs
- [The one about usernames — Slack Changelog 2017](https://docs.slack.dev/changelog/2017-09-the-one-about-usernames/) — "don't use display_name as identifier"

---

*Pitfalls research for: Wood Fired Bugs v1.5 Slack Integration*
*Researched: 2026-02-17*
*Confidence: HIGH — All critical pitfalls verified with official Slack documentation and bolt-js GitHub issues*
