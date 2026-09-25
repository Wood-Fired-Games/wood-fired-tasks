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
| `v2.7.0` (latest) | :white_check_mark: |
| `v1.0` – `v2.6.0` | :x:                |

"Latest" tracks whichever tag is most recent on GitHub; at the time of
writing that is `v2.7.0`. If you are reading this on an older checkout,
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
  (`npm run mcp:start` / `npm run mcp:dev` / installed Claude Code stdio
  target) and the **remote HTTP** server (`npm run mcp:remote`), including
  its tool implementations and prompt/resource handlers.
- The `tasks` CLI under `src/cli/` — command parsers, HTTP client, and the
  small set of offline subcommands that touch SQLite directly
  (`backup`, `doctor`, `stats`, `db-check`, `completed`).
- The Slack integration under `src/slack/` and
  `src/services/slack.service.ts`. The Bolt app runs **in-process** inside
  the API server in **Socket Mode** (`socketMode: true`) — an *outbound*
  WebSocket that Slack authenticates with `SLACK_APP_TOKEN` +
  `SLACK_BOT_TOKEN`. There is **no inbound Slack HTTP endpoint** in this
  codebase, and therefore no request-signature check to bypass. The
  reachable surface is: the outbound WebSocket and its tokens; the `/tasks`
  slash-command handlers (`src/slack/commands/tasks-command.ts`); the
  Slack-user → local-identity mapping (`src/slack/user-identity.ts`); the
  channel-subscription store
  (`src/slack/repositories/channel-subscription.repository.ts`); and the
  EventBus → Slack notifier path (`src/slack/notifier.ts`).
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

- Authentication bypass on any endpoint — reaching a `/api/v1` route
  without a valid PAT or session credential, or bypassing
  the SSE auth path.
- Authorization bypass — a PAT reaching a route or stdio MCP tool above
  its scope tier, or a project-bound PAT touching another project (see
  "Authentication Is Not Authorization" below).
- Tampering with, or silently suppressing, the `audit_events` trail.
- Secrets exposure (API keys, `.env` leakage, log scrubbing gaps in pino
  redaction, disclosure of `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` — the two
  Slack credentials this service actually holds).
- SQL injection or FTS5 injection in task/comment/project queries
  (better-sqlite3 prepared statements, search filters, sort/order
  parameters).
- Server-Side Request Forgery (SSRF) in any outbound HTTP call.
- Prompt-injection vectors via MCP tool descriptions, task fields,
  comment bodies, or resource contents that cause an MCP client to
  take unintended action.
- Slack-path issues that survive Socket Mode: a `/tasks` subcommand that
  mutates or discloses data on behalf of the wrong actor (the
  Slack-user → local-user mapping falls back to the `slack-bot` service
  account when a Slack `user_id` has no `users` row), or a channel
  subscription that causes the notifier to push task content to a channel
  that should not receive it. A change that swaps Socket Mode for an HTTP
  receiver **without** Bolt signature verification is also in scope —
  `src/slack/__tests__/signing-verification.test.ts` guards that
  regression.
- Anything that allows **unauthenticated** mutation of tasks, projects,
  comments, dependencies, or Slack channel subscriptions — i.e. mutating
  state without presenting any valid credential, or escalating
  read-only access to write access on either MCP transport. (Mutation by
  an *authenticated*, sufficiently-scoped identity is by design; see
  "Authentication Is Not Authorization".)

Thank you for helping keep wood-fired-tasks and its users safe.

## Authentication Architecture

As of v2.0, the REST API supports two authentication strategies, tried
in order by a Fastify chain plugin (`src/api/plugins/auth/index.ts`). The
first strategy that produces a valid `request.user` wins; the request
proceeds with that user's id stamped onto every write (`created_by_user_id`,
`assignee_user_id`, `author_user_id`) and surfaced in the per-request audit
log (`user_id`, `token_id`, `auth_method`).

| Order | Strategy | Credential | Wire format |
|-------|----------|------------|-------------|
| 1 | **PAT (Personal Access Token)** | A token row in `api_tokens` | `Authorization: Bearer wft_pat_<…>` |
| 2 | **Session** | An OIDC-derived sealed-box session cookie | `Cookie: wft_session=<…>` |

PAT is the recommended machine credential; session is the recommended
user credential. (The legacy `X-API-Key` shared-secret strategy was
**removed in v2.0** — see [Legacy `X-API-Key` Status — Removed in v2.0](#legacy-x-api-key-status--removed-in-v20) below.)

### PAT lifecycle

PATs are minted from a logged-in `/me` web session **or** offline via the
CLI (`tasks db mint-token --user <id|email|displayName> --name <label>`,
see [`docs/CLI.md`](docs/CLI.md)). The raw token value is shown **once at
mint time** — the database only stores a SHA-256 hash, so a lost PAT
cannot be recovered (only re-minted).

**PATs have no default expiry.** The `api_tokens.expires_at` column is
nullable and is left `NULL` unless you explicitly pass
`--expires-at <ISO-8601>` at mint time (e.g.
`tasks db mint-token --user alice@example.com --name ci-runner --expires-at 2027-05-22T00:00:00Z`).
A token with a NULL `expires_at` is valid until it is revoked. Because a
non-expiring credential never rotates itself, operators are responsible
for hygiene:

- **Rotate** by minting a replacement PAT (with a fresh `--expires-at`),
  deploying it, then revoking the old one — one PAT per machine/agent so a
  rotation never disturbs unrelated clients.
- **Revoke** explicitly via the `/me` UI, the `DELETE /me/tokens/:id`
  endpoint, or `tasks logout` (revokes the active PAT and removes the
  local credentials file). Revoked PATs are rejected immediately on the
  next request — there is no cache.
- **Set an expiry** on every new PAT (`--expires-at`) so credentials age
  out even if a manual revocation is forgotten. The expiry is enforced by
  the PAT auth strategy: once `expires_at` is in the past the token fails
  with `reasonCode: expired`.

**Scopes and project binding are enforced** — see
[Authentication Is Not Authorization](#authentication-is-not-authorization).
`--scopes` accepts only `read`, `write`, `admin`.

**At rest.** The SQLite database (which holds the PAT hashes and the audit
trail) and its `-wal`/`-shm` sidecars are tightened to mode `0600` when
opened (POSIX), as are `~/.claude.json` and the `.tmp`/`.bak` files
`tasks setup` writes beside it (which can hold a live `WFT_API_KEY`). Installs that predate this can check for drift
with `tasks doctor` (the `Perms` check prints a `chmod 600` per offender).

The PAT prefix (`wft_pat_`) is part of the wire format. The remote MCP
server and the CLI HTTP client read the PAT from their respective env var
(`WFT_API_KEY` for MCP, `API_KEY` for CLI) and send it as
`Authorization: Bearer <pat>`.

### Session lifecycle

OIDC sign-in (`/auth/login` → Google → `/auth/callback`) creates a
sealed-box-encrypted cookie containing the user id and a small set of
claims. The cookie:

- Uses `SESSION_COOKIE_SECRET` (32 bytes, generated via
  `openssl rand -base64 32`) as the sodium sealed-box key.
- Has `maxAge=8h`, `httpOnly=true`, and `sameSite=lax`.
- Sets the `secure` attribute in **production posture** — explicit
  `NODE_ENV=production` **or `NODE_ENV` unset** (`src/api/server.ts` —
  `secure: config.isProductionPosture`). Only an explicit
  `NODE_ENV=development|test` drops it.
- Has **no DB-side sessions table** — the cookie is self-contained.
  Rotating `SESSION_COOKIE_SECRET` invalidates every active session
  immediately because the existing cookies can no longer be decrypted.

> **Run production behind HTTPS — even on a LAN.** Because the cookie is
> flagged `secure` in production posture (including `NODE_ENV` unset), a server
> reached over plain `http://` will have its `Set-Cookie` dropped by the
> browser, silently breaking the OIDC login flow (the session never
> persists, so the callback loops back to `/auth/login`). This applies to
> internal / LAN deployments too: terminate TLS in front of the service
> (reverse proxy or a self-signed cert the clients trust) before exposing
> the browser login. The matching `secure=false` under an explicit
> `NODE_ENV=development|test` exists only so local `http://localhost`
> development works — and such a server refuses to boot (exit 78) unless
> `HOST` is a loopback address.

The OIDC flow itself uses **PKCE + state** to prevent CSRF / replay
against the callback endpoint, and validates the issuer + audience
against `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` before binding the local
session.

### Per-request audit

Every authenticated request emits a structured pino log line carrying:

- `user_id` — the local `users.id` (NULL for service accounts like
  `mcp-bot` / `slack-bot` only when the bot row is missing; the seed
  guarantees they exist).
- `token_id` — the `api_tokens.id` when strategy=PAT; NULL
  otherwise.
- `auth_method` — one of `pat`, `session`.

Failures emit a counterpart `tag: auth.failure` line with a coarse
`reasonCode` (`missing_credential`, `unknown_token`, `revoked_token`, …)
so secret values never appear in logs. The `auth-audit` helper enforces
this — it is the **only** sanctioned way for the auth plugin to
log into the request.

### Audit trail

Separately from the log lines above, state changes are recorded in the
`audit_events` table (migrations 018/019):

- **Producers.** One row per authenticated, state-changing REST request
  (GET/HEAD are exempt; refused attempts such as a scope `403` are
  recorded with their status), and one row per mutating stdio MCP tool
  call. Rows carry actor, `api_tokens` row id (never token material),
  action (route pattern or `MCP <tool>`), resource, request id, and
  status/auth-method/params metadata — never request bodies or headers.
  A failed audit write never changes the response but is logged at
  ERROR (`audit.append_failed`).
- **Append-only.** `BEFORE UPDATE`/`BEFORE DELETE` triggers abort any
  modification through the schema.
- **Tamper-evident.** Each row stores a SHA-256 `row_hash` over its
  content plus the previous row's hash (`prev_hash`), so an out-of-band
  edit, insert, or deletion against the SQLite file breaks the chain at a
  detectable point.
- **Read access.** `GET /api/v1/audit-events` (admin scope, not available
  to project-bound tokens) with exactly one bounded filter mode — by
  actor, by resource, or by time window; see
  [`docs/API.md`](docs/API.md#get-apiv1audit-events).

## Legacy `X-API-Key` Status — Removed in v2.0

The legacy `X-API-Key` shared-secret strategy was **removed entirely in
v2.0.** The auth chain (`src/api/plugins/auth/index.ts`) now walks only
PAT → session; a request carrying only an `X-API-Key` header gets **401**.
There is no "auth-disabled" mode and no shared-secret fallback.

`API_KEYS` is **no longer an auth method and is no longer a required env
var** — it is not in the Zod config schema (`src/config/env.ts`). If set,
it is read only as an optional seed for inert legacy `users` rows
(`is_legacy=1`) so historical identities still render; those rows carry
**no usable credential** and cannot authenticate a request.

Every deployment must now authenticate with a per-user **PAT** (one per
machine/agent, individually revocable) or an **OIDC session**. The
`tasks db migrate-identities` tool (idempotent; backfills identity FKs
for historical rows that carry only the legacy TEXT identity columns) is
the supported step to fold pre-identity data forward; it is safe to run
at any time.

## CORS

The REST API **does not register a CORS plugin** — there is no
`@fastify/cors` (or equivalent) registration anywhere in `src/api/`, and
`cors` is not a project dependency. This is intentional: the API is built
for server-to-server and agent traffic (PAT in the `Authorization: Bearer` header),
plus a same-origin browser surface (`/auth/*`, `/me`, `/login`) that does
not need cross-origin access. With no `Access-Control-Allow-Origin`
header emitted, browsers block cross-origin reads of API responses by
default.

> **Never add `origin: true` (reflect-any-origin) CORS.** The OIDC
> session is a **credentialed cookie** (`Cookie: wft_session=…`).
> Combining a reflect-any-origin CORS policy
> (`origin: true` / `Access-Control-Allow-Origin: <reflected>`) with
> `Access-Control-Allow-Credentials: true` would let any website the
> victim visits make authenticated, cookie-bearing requests to the API on
> the victim's behalf — a cross-site request forgery / data-exfiltration
> hole. If you must enable CORS, set an explicit, hard-coded allow-list of
> trusted origins; do not reflect the request origin while credentials are
> allowed.

## Authentication Is Not Authorization

Authentication identifies the caller. Authorization is limited to what a
**PAT** declares about itself; there is still **no per-user RBAC, no ACL,
and no tenant isolation between users.**

- **Scope tiers (enforced).** A PAT carries scopes from the closed
  taxonomy `read < write < admin` (`src/schemas/pat-scope.schema.ts`).
  Every authenticated REST route declares a required tier (a drift-guard
  test fails if one does not); reads need `read`, mutations `write`,
  and the token surface and `GET /api/v1/audit-events` need `admin`. An
  out-of-scope request gets **403 `insufficient_scope`**. The stdio MCP
  server enforces the same tiers on its mutating tools against the PAT in
  `WFT_API_KEY` (`src/mcp/scope-gate.ts`; deletes and
  `set_model_defaults` need `admin`).
- **Project binding (optional, enforced).** A PAT minted via
  `POST /api/v1/me/tokens` with a `projectId` (migration 020) may only
  touch that project — including through task-id routes — and is refused
  (**403 `project_scope_denied`**) on anything it cannot be proven to
  stay within. Deleting the project deletes the token. The stdio MCP
  surface does not apply project binding.
- **Full-tier cases.** OIDC session-cookie requests, PATs with an empty
  scope list (all tokens minted before scopes were enforced, and any
  minted without `--scopes`), and the stdio MCP `mcp-bot` fallback carry
  no scope restriction. Such a credential can read, write, and delete
  **every** task, project, comment, dependency, and Slack subscription
  across **every** project.

The consequence: mint least-privilege PATs (e.g. `read` for dashboards,
project-bound `write` for agents) and treat the leak of any full-tier
credential as a full-database compromise. If you need per-user,
per-team, or per-tenant isolation, enforce it **outside** this service —
front it with an authenticating reverse proxy that performs its own
authorization.

