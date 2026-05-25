# Security Policy

For repository structure and agent-context entry, see [`AGENTS.md`](AGENTS.md).

We take the security of wood-fired-tasks seriously. This document explains
which versions receive security fixes, how to report a vulnerability, and
what is in scope.

## Supported Versions

Only the current `main` branch and the most recent tagged release receive
security updates. Older tags are provided as-is.

| Version           | Supported          |
| ----------------- | ------------------ |
| `main` (HEAD)     | :white_check_mark: |
| `v1.11` (latest)  | :white_check_mark: |
| `v1.0` – `v1.10`  | :x:                |

"Latest" tracks whichever tag is most recent on GitHub; at the time of
writing that is `v1.11`. If you are reading this on an older checkout,
verify the current latest release via
`git tag --sort=-creatordate | head -1` or the GitHub Releases page.

## Reporting a Vulnerability

**Preferred:** open a private report via GitHub Security Advisories:

  https://github.com/Wood-Fired-Games/wood-fired-tasks/security/advisories/new

**Fallback:** email `security@woodfiredgames.com` with steps to reproduce,
affected version/commit, and the impact you observed. Please do not file
public GitHub issues for suspected vulnerabilities.

We will:

- Acknowledge your report within **5 business days**.
- Aim to ship a fix or documented workaround within **30 days** for issues
  rated high or critical. Lower-severity issues are batched into the next
  routine release.
- Credit reporters in the release notes unless you ask us not to.

## Scope

**In scope:**

- The Fastify REST API (TypeScript, Node ≥22) under `src/api/` — routes,
  plugins (auth, rate-limit, SSE), and request/response validation.
- The MCP server under `src/mcp/` — both transports: the **stdio** server
  (`npm run mcp` / installed Claude Code stdio target) and the **remote
  HTTP** server (`npm run mcp:remote`), including its tool implementations
  and prompt/resource handlers.
- The `tasks` CLI under `src/cli/` — command parsers, HTTP client, and the
  small set of offline subcommands that touch SQLite directly
  (`backup`, `doctor`, `stats`, `db-check`, `completed`).
- The Slack integration under `src/slack/` — Bolt subprocess, slash-command
  handlers, signed-request verification, and the EventBus → Slack notifier
  path.
- The shared service / repository / workflow layer under `src/services/`,
  `src/repositories/`, and `src/events/` that all four entry points sit on
  top of.

**Out of scope:**

- Third-party dependencies — please report those directly upstream
  (e.g. Fastify, `@slack/bolt`, `@modelcontextprotocol/sdk`,
  `better-sqlite3`, `commander`, `zod`).
- User-side customizations layered on top of the project, including
  custom auth proxies in front of the API, self-hosted reverse proxies,
  or forked deployments with modified middleware.
- Findings from automated scanners (SAST/DAST/dependency CVE noise)
  submitted without a working proof-of-concept against this codebase.

## What We Consider Security-Relevant

Issues we will prioritize include, but are not limited to:

- Authentication or authorization bypass on any endpoint, including
  bypassing the `X-API-Key` check, the admin-key check on write
  endpoints, or the SSE auth path.
- Secrets exposure (API keys, Slack tokens, `.env` leakage, log
  scrubbing gaps in pino redaction, Slack signing-secret disclosure).
- SQL injection or FTS5 injection in task/comment/project queries
  (better-sqlite3 prepared statements, search filters, sort/order
  parameters).
- Server-Side Request Forgery (SSRF) in any outbound HTTP call.
- Prompt-injection vectors via MCP tool descriptions, task fields,
  comment bodies, or resource contents that cause an MCP client to
  take unintended action.
- Signature-verification bypass on the Slack webhook / events endpoint,
  or replay of signed Slack requests.
- Anything that allows unauthenticated mutation of tasks, projects,
  comments, dependencies, or Slack channel subscriptions — including
  bypassing the admin-key check on write endpoints or escalating
  read-only access to write access on either MCP transport.

Thank you for helping keep wood-fired-tasks and its users safe.

## Authentication Architecture

As of v1.6, the REST API supports three authentication strategies, tried
in order by a Fastify chain plugin (`src/api/plugins/auth/index.ts`). The
first strategy that produces a valid `request.user` wins; the request
proceeds with that user's id stamped onto every write (`created_by_user_id`,
`assignee_user_id`, `author_user_id`) and surfaced in the per-request audit
log (`user_id`, `token_id`, `auth_method`).

| Order | Strategy | Credential | Wire format |
|-------|----------|------------|-------------|
| 1 | **PAT (Personal Access Token)** | A token row in `personal_access_tokens` | `Authorization: Bearer wfb_pat_<…>` |
| 2 | **Session** | An OIDC-derived sealed-box session cookie | `Cookie: wfb_session=<…>` |
| 3 | **Legacy** | An entry in the `API_KEYS` env list | `X-API-Key: <…>` |

The three strategies coexist intentionally — legacy keeps existing
deployments running while operators migrate; PAT is the recommended
machine credential; session is the recommended user credential.

### PAT lifecycle

PATs are minted from a logged-in `/me` web session **or** offline via the
CLI (`tasks db mint-token`, see [`docs/CLI.md`](docs/CLI.md)). The raw
token value is shown **once at mint time** — the database only stores a
SHA-256 hash, so a lost PAT cannot be recovered (only re-minted). PATs
have no expiry; revocation is explicit via the `/me` UI, the
`DELETE /me/tokens/:id` endpoint, or `tasks logout` (revokes the active
PAT and removes the local credentials file). Revoked PATs are rejected
immediately on the next request — there is no cache.

The PAT prefix (`wfb_pat_`) is part of the wire format: the remote MCP
server and the CLI HTTP client switch their auth header based on the
prefix, so the same env var (`WFT_API_KEY` for MCP, `API_KEY` for CLI)
transparently accepts a PAT or a legacy key.

### Session lifecycle

OIDC sign-in (`/auth/login` → Google → `/auth/callback`) creates a
sealed-box-encrypted cookie containing the user id and a small set of
claims. The cookie:

- Uses `SESSION_COOKIE_SECRET` (32 bytes, generated via
  `openssl rand -base64 32`) as the sodium sealed-box key.
- Has `maxAge=8h`, `httpOnly=true`, `sameSite=lax`, and
  `secure=true` in production (`NODE_ENV=production`).
- Has **no DB-side sessions table** — the cookie is self-contained.
  Rotating `SESSION_COOKIE_SECRET` invalidates every active session
  immediately because the existing cookies can no longer be decrypted.

The OIDC flow itself uses **PKCE + state** to prevent CSRF / replay
against the callback endpoint, and validates the issuer + audience
against `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` before binding the local
session.

### Per-request audit

Every authenticated request emits a structured pino log line carrying:

- `user_id` — the local `users.id` (NULL for service accounts like
  `mcp-bot` / `slack-bot` only when the bot row is missing; the seed
  guarantees they exist).
- `token_id` — the `personal_access_tokens.id` when strategy=PAT; NULL
  otherwise.
- `auth_method` — one of `pat`, `session`, `legacy`.
- `apiKeyLabel` — the human-friendly label for legacy keys, e.g.
  `key_alice-laptop`. Absent for PAT / session.

Failures emit a counterpart `tag: auth.failure` line with a coarse
`reasonCode` (`missing_credential`, `unknown_token`, `revoked_token`, …)
so secret values never appear in logs. The `auth-audit` helper enforces
this — it is the **only** sanctioned way for the auth plugin to
log into the request.

## Legacy Auth Sunset Timeline

The legacy `X-API-Key` strategy is deprecated as of v1.6 and scheduled for
removal in v1.7. Every legacy-authed REST response carries two RFC 8594
headers so clients can detect the deprecation programmatically:

```
Deprecation: true
Sunset: 2026-12-31
```

The `Sunset` value comes from the `LEGACY_AUTH_SUNSET_DATE` env var
(default `2026-12-31`, must be `YYYY-MM-DD`). PAT-authed and
session-authed requests carry **neither** header — only legacy requests
trigger the stamping.

In addition, every legacy-authed request emits a `warn`-level log line:

```json
{
  "level": 40,
  "event": "legacy_auth_used",
  "userId": 1,
  "apiKeyLabel": "key_alice-laptop",
  "requestId": "…",
  "requestUrl": "/api/v1/tasks",
  "sunset": "2026-12-31"
}
```

Operators can aggregate the `legacy_auth_used` event over a rolling
window to track sunset readiness — a steady decline to zero indicates
clients have all migrated to PAT or session.

**v1.6:** legacy keeps working; clients see the deprecation signals.
**v1.7:** legacy strategy is removed from the chain; pre-flight refuses
to boot if any legacy artefacts remain (see Runbook below).

## v1.7 Sunset Runbook

This runbook is the operator checklist for upgrading from v1.6 (legacy
+ PAT + session) to v1.7 (PAT + session only).

### Pre-flight (run on v1.6 before upgrading)

1. **Backfill identity FKs** for any historical rows still carrying
   only the legacy TEXT identity columns. Idempotent; safe to re-run.

   ```bash
   # Dry-run first — review the per-mapping summary.
   node dist/cli/bin/tasks.js db migrate-identities

   # Apply.
   node dist/cli/bin/tasks.js db migrate-identities --commit
   ```

   Unmatched TEXT values default to the lowest-id `is_legacy=1` user.
   Override per-string with `--alias-map <file>` (JSON object,
   `{"alice@example.com": 42, …}`) or pass `--user-fallback skip` to
   leave NULLs in place for later manual review.

2. **Audit `legacy_auth_used` log volume** over the past 7 days. Any
   non-zero count indicates clients still using `X-API-Key` — they will
   break on v1.7. Migrate them to PAT (`tasks login` → cache PAT, or
   `tasks db mint-token` for headless agents) before proceeding.

3. **Confirm all PATs are minted and distributed.** Each operator /
   service account that needs API access should have a PAT in hand. The
   `mcp-bot` and `slack-bot` service-account rows are seeded
   automatically; their PATs (if any) are operator-minted via
   `tasks db mint-token --user-display-name mcp-bot`.

4. **Take a database backup.**

   ```bash
   node dist/cli/bin/tasks.js backup --out /var/backups/wfb-pre-v1.7.db
   ```

### v1.7 actions (applied by the v1.7 release)

- Drops the legacy TEXT identity columns: `tasks.created_by`,
  `tasks.assignee`, `task_comments.author`. The parallel `*_user_id`
  FK columns become the only identity record.
- Removes `API_KEYS` env support and the legacy strategy from the auth
  chain. Requests carrying only `X-API-Key` will fail with `401`.
- Adds a boot-time pre-flight check that refuses to start if any row
  in `tasks` / `task_comments` has a NULL identity FK that was
  previously populated via the TEXT column. Override with `--force`
  only after acknowledging that those rows will lose their author
  attribution.

The `tasks db migrate-identities` tool is intentionally idempotent so
the pre-flight backfill can be scripted and re-run safely up to (and
including) the v1.7 upgrade window.

