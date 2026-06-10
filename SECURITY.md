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
| `v2.1.1` (latest) | :white_check_mark: |
| `v1.0` – `v2.0.6` | :x:                |

"Latest" tracks whichever tag is most recent on GitHub; at the time of
writing that is `v2.1.1`. If you are reading this on an older checkout,
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

- Authentication bypass on any endpoint — reaching a `/api/v1` route
  without a valid PAT or session credential, or bypassing
  the SSE auth path. (Note: there is no separate authorization layer to
  bypass — see "Authentication Is Not Authorization" below. Any valid
  credential is already full-access.)
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
- Anything that allows **unauthenticated** mutation of tasks, projects,
  comments, dependencies, or Slack channel subscriptions — i.e. mutating
  state without presenting any valid credential, or escalating
  read-only access to write access on either MCP transport. (Mutation by
  an *authenticated* identity is by design — every credential is
  full-access; see "Authentication Is Not Authorization".)

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
- Sets the `secure` attribute **only when `NODE_ENV=production`**
  (`src/api/server.ts` — `secure: config.NODE_ENV === 'production'`).
- Has **no DB-side sessions table** — the cookie is self-contained.
  Rotating `SESSION_COOKIE_SECRET` invalidates every active session
  immediately because the existing cookies can no longer be decrypted.

> **Run production behind HTTPS — even on a LAN.** Because the cookie is
> flagged `secure` whenever `NODE_ENV=production`, a production server
> reached over plain `http://` will have its `Set-Cookie` dropped by the
> browser, silently breaking the OIDC login flow (the session never
> persists, so the callback loops back to `/auth/login`). This applies to
> internal / LAN deployments too: terminate TLS in front of the service
> (reverse proxy or a self-signed cert the clients trust) before exposing
> the browser login. The matching `secure=false` in non-production exists
> only so local `http://localhost` development works — do not run a
> public or shared instance with `NODE_ENV` unset.

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

Authentication identifies the caller; it does **not** scope what the
caller may do. Wood Fired Tasks has **no RBAC, no ACL, and no tenant /
project isolation.** Every authenticated identity — whether it arrived
via PAT or OIDC session — is effectively an
admin: it can read, write, and delete **every** task, project, comment,
dependency, and Slack subscription across **every** project in the
database. The `--scopes` minted onto a PAT are advisory metadata only and
are **not enforced** by any endpoint.

The consequence: any valid credential is a full-access credential. If you
need per-user, per-team, or per-tenant isolation, you must enforce it
**outside** this service — front it with an authenticating reverse proxy
that performs its own per-tenant authorization. Treat the loss or leak of
any single PAT or API key as a full-database compromise and revoke/rotate
accordingly. Scoped, role-based permissions are tracked as future work;
until they land, the model above is the whole authorization story.

