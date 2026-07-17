# Setup Guide

Complete setup instructions for Wood Fired Tasks in development, production, and Claude Code environments.

This guide opens with the **frictionless npm install** — the recommended path
for most users: one global install, no git clone, no build, no admin rights.
The [Development Setup](#development-setup) and [Production Deployment](#production-deployment)
/ [Self-hosting and upgrades](#self-hosting-and-upgrades) sections below remain
the canonical references for contributors and operators self-hosting a shared
server from a checkout.

## Frictionless install (npm — no clone)

Install the published package globally and let the bundled subcommands do the
wiring. The global install ships everything together — the API server, the
`tasks` CLI, the local and remote MCP bridges, and the `/tasks:*` skills +
subagents — so there is **nothing to clone and nothing to build**.

```bash
# 1. Install the CLI globally. Never needs sudo (see the admin-free guarantee).
npm i -g wood-fired-tasks

# 2. Wire it into Claude Code (idempotent; no manual ~/.claude.json editing).
wood-fired-tasks setup

# 3. Run the API server (migrates the OS app-data DB on start).
wood-fired-tasks serve
```

The same binary is invokable as `wood-fired-tasks` (and, if you prefer the short
form, the package also exposes `tasks`). Every `tasks <command>` example
elsewhere in the docs works verbatim as `wood-fired-tasks <command>`.

### Admin-free guarantee

**No first-class subcommand ever escalates privileges.** `setup`, `serve`,
`self-update`, `docs`, and `service install` (user scope) all hard-refuse to
shell out to `sudo`, `runas`, `pkexec`, or `doas` — the same elevation guard is
implemented in `src/cli/commands/setup.ts` (`fixNpmPrefix`),
`src/cli/commands/self-update.ts` (`eaccesRemediation`),
`src/cli/commands/service.ts` (`defaultRunner`), and `src/cli/commands/docs.ts`
(`openDoc`). The **only** path that elevates is the opt-in system-wide service
(`wood-fired-tasks service install --system`); see
[Background service](#background-service-keep-the-server-running).

If `npm i -g wood-fired-tasks` fails with `EACCES`/`EPERM` because your global
npm prefix is root-owned, **do not use sudo.** Repair the prefix instead:

```bash
# Point npm at a user-writable global prefix (~/.npm-global) — no elevation.
wood-fired-tasks setup --fix-npm-prefix
# Follow the printed guidance (adds ~/.npm-global/bin to PATH), then re-run:
npm i -g wood-fired-tasks
```

`--fix-npm-prefix` runs `npm config set prefix ~/.npm-global` and prints the
`export PATH="$HOME/.npm-global/bin:$PATH"` line to add to your shell profile.
After that, `npm i -g` and `wood-fired-tasks self-update` both work without sudo
forever.

### Deprecation warnings on install (harmless)

`npm i -g wood-fired-tasks` prints a few `npm warn deprecated` lines. They are
**expected, harmless, and come from upstream transitive dependencies** — not
from wood-fired-tasks itself. The install succeeds and `npm audit` is clean.

| Warning | Where it comes from | Status |
| --- | --- | --- |
| `prebuild-install@7.x` | `better-sqlite3` (the SQLite driver) still depends on it, including the latest release | Upstream-owned; nothing to do until better-sqlite3 drops it |
| `lodash.get@4.x`, `lodash.isequal@4.x` | `umzug` (migrations) → `@rushstack/ts-command-line` → `z-schema@5` | Upstream-owned; `z-schema@12` dropped them but forcing that major override under rushstack is deferred (it must not risk the migration path) |

You can safely ignore them. Tracking: project-37 #789.

### `wood-fired-tasks setup` — local Claude Code wiring

`setup` does three things, all idempotent (re-runnable; a file is only rewritten
when its bytes change):

1. **Merges the local stdio MCP server** entry (`wood-fired-tasks`) into
   `~/.claude.json`, pointing at the bundled `dist/mcp/index.js`. The path is
   resolved from the installed package root, so it is correct regardless of the
   directory you run `setup` from.
2. **Copies the `/tasks:*` skill files** into `~/.claude/commands/tasks/`.
3. **Copies the subagent definitions** into `~/.claude/agents/` (these back the
   mandatory verifier in `/tasks:loop` and `/tasks:loop-dag`).

Restart Claude Code afterward and the `/tasks:*` slash commands and MCP tools
are live. The local MCP server opens the SQLite database in-process; it does not
talk to the REST API and needs no API key.

| Flag | Effect |
|------|--------|
| (none) | Local wiring: write the `wood-fired-tasks` stdio MCP entry + copy skills/agents. |
| `--fix-npm-prefix` | Configure a user-writable npm global prefix (`~/.npm-global`) to dodge EACCES on `npm i -g`. Never uses sudo. |
| `--remote <url>` | Write the **remote** MCP bridge entry (`wood-fired-tasks-remote`) pointed at a deployed REST API instead of the local one. Requires `--token`. |
| `--token <pat>` | PAT for `--remote`: written as `WFT_API_KEY` on the remote MCP entry and cached under the OS config dir. |

### `wood-fired-tasks setup --remote` — point at a shared server

To use a shared/remote Wood Fired Tasks server instead of running one locally,
pass `--remote <url>` and `--token <pat>` together:

```bash
wood-fired-tasks setup \
  --remote https://tasks.example.com \
  --token  wft_pat_…this-machine…
```

This writes a **URL-only `wood-fired-tasks-remote`** entry to `~/.claude.json`
(distinct from the local `wood-fired-tasks` entry — the two coexist) whose `env`
carries **only** `WFT_API_URL` (the base URL). The PAT is **never** embedded in
`~/.claude.json` (#810). That entry spawns the remote stdio bridge
(`dist/mcp/remote/index.js`), which proxies every MCP tool call to the REST API
over HTTP, so every machine sees one backlog.

When you pass `--token <pat>`, setup **validates it against `GET /api/v1/me`** and
**persists it to the CLI credentials file** (`~/.config/wood-fired-tasks/credentials`,
mode `0600` on POSIX) — the *same* file `tasks login` writes. The remote bridge
then resolves its bearer token from that credentials file at runtime. There is no
separate PAT "cache" file (the old `remote-token` cache was removed in #858 —
nothing read it, so `setup --remote --token` reported success while leaving both
the CLI and the bridge unauthenticated).

`--token` is **optional**: omit it and `setup --remote <url>` runs the interactive
onboarding — the OIDC **device flow** when the server supports browser login
(https / localhost), otherwise a **manual-PAT** prompt. Supply `--token` (or set
`WFT_API_KEY` for non-TTY/CI callers) for the non-interactive direct path, which
skips the OIDC probe but still performs the `/api/v1/me` validation round-trip.
Mint a per-machine PAT with `tasks db mint-token` (see
[Bootstrap a PAT without a browser](#6-bootstrap-a-pat-without-a-browser-servers-ci-headless-agents))
and revoke it independently to cut off a single client. For the full
Windows/Linux/macOS fleet recipe, see
[Multi-OS client fleet](#multi-os-client-fleet-one-shared-on-prem-server).

### `wood-fired-tasks serve` — run the API server

`serve` boots the REST API as a first-class subcommand, so npm-only users never
touch `npm start` or a checkout:

```bash
wood-fired-tasks serve                 # 127.0.0.1:3000 (loopback only)
wood-fired-tasks serve --port 8080     # override the port
HOST=0.0.0.0 wood-fired-tasks serve    # expose on the LAN
```

It opens the database at `DATABASE_PATH`, which **defaults to the OS app-data
path** (resolved by `src/config/paths.ts`, not a hardcoded `./data`), and runs
**all pending migrations before it begins listening** (migrate-on-start) — so a
request that lands after boot always hits a migrated schema. Launched from any
directory, it migrates and serves the same app-data DB. The bind host comes from
`HOST` (default `127.0.0.1`; set `0.0.0.0` to expose) and the port from `PORT`
unless `--port` overrides it. The unauthenticated `GET /health` route returns
200 once the server is up.

### `wood-fired-tasks self-update` — upgrade in place

```bash
wood-fired-tasks self-update
```

This runs `npm i -g wood-fired-tasks@latest`, then re-syncs the bundled
skills into `~/.claude/commands/tasks/` and the subagent definitions into
`~/.claude/agents/` — the same idempotent copy `setup` performs, so a release
that adds or changes a skill is fully picked up by `self-update` alone (no
`setup` re-run needed). If the install succeeds but the skills sync fails, it
says so and exits non-zero; re-run `wood-fired-tasks setup` to retry the sync.
It **never escalates**: on an EACCES (root-owned global prefix) it prints the
writable-prefix remediation (the same `~/.npm-global` fix as `--fix-npm-prefix`)
and exits non-zero rather than suggesting sudo. The database schema needs no
special handling — it migrates automatically the next time `serve` (or the
background service) boots against the upgraded binary. A best-effort
`update-notifier` nudge surfaces a "newer version available" hint before the
upgrade runs.

> The task-level `tasks update <id>` command is unrelated — that edits a task's
> fields. Use `self-update` to upgrade the CLI itself.

### Background service (keep the server running)

Register `serve` as a background service so it survives logout/reboot —
**admin-free by default**:

```bash
wood-fired-tasks service install    # install + start
wood-fired-tasks service status     # is it running / enabled?
wood-fired-tasks service uninstall  # stop + remove
```

On **Linux** this writes a **user-scoped systemd unit** at
`~/.config/systemd/user/wood-fired-tasks.service` and drives it with
`systemctl --user` — no `sudo`, no system unit, no root. The unit's `ExecStart`
runs the installed CLI's `serve` subcommand with `Restart=on-failure`.
`service status` reports `running`, `enabled`, and `installed` (add the global
`--json` flag for machine-readable output).

**Scope elevation.** A user-scoped service stops when the user's systemd session
ends (no lingering enabled). The **only** way to run system-wide — surviving
across users and starting at boot independent of login — is the opt-in
`wood-fired-tasks service install --system` path, which is the sole subcommand
that requires elevated privileges. Everything else stays in user scope.

> **macOS and Windows.** Service management is currently **Linux-only**. The
> macOS (launchd) and Windows backends are landing in tasks #741 and #742
> respectively; until then `service install` on those platforms exits with a
> clear "not yet implemented" message naming the tracking task. `serve`,
> `setup`, `self-update`, and `docs` work on all three platforms today.

### `wood-fired-tasks docs` — read the bundled guides

The user-facing guides ship inside the npm tarball, so you can read them from
anywhere without a checkout:

```bash
wood-fired-tasks docs list                 # friendly name -> file
wood-fired-tasks docs show setup           # print this guide to stdout
wood-fired-tasks docs path cli             # absolute on-disk path of a guide
wood-fired-tasks docs open usage-patterns  # open with the OS default app (no sudo)
```

Guides are resolved from the package root (where the tarball ships them), not
the current directory, so these work even from inside `node_modules/` after a
global install. The catalog includes `setup`, `usage-patterns`, `cli`, `api`,
`mcp`, `navigation`, `interfaces`, `workflows`, `slack`, `reliability`,
`troubleshooting`, `architecture`, `agent-context`, and `readme`.

## Source Control (SCM) Configuration

The automation lifecycle talks to source control through a **pluggable SCM
adapter** — the `tasks scm <verb>` CLI (see the
[SCM command reference](../README.md#source-control-scm-commands)) — so the same
`/tasks:*` recipes run unchanged over three interchangeable backends:

- **git** — byte-parity with native git (default when a `.git` marker is found).
- **perforce** — changelist-based; change-ids look like `p4:<cl>`.
- **none** — a no-VCS digest backend for unversioned trees (no change-ids).

### Which backend a repo uses (precedence)

The effective backend is resolved once per repo, highest source wins:

1. **`.tasks/scm.json`** in the repo root — the authoritative, committed
   declaration. If the file exists but does not validate, resolution **fails
   hard** (`CONFIG_INVALID`, exit 2) rather than silently falling through.
2. **Project charter `scm` default** — the optional `scm` object on the project
   (set via `update_project`; see [MCP.md](MCP.md#get_project)). A fallback
   **hint only** — it never overrides an on-disk signal.
3. **Auto-detection** — on-disk markers (`.git` / Perforce config), else `none`.

### `.tasks/scm.json`

A committed file at the repo root. `version` must be exactly `1`; unknown keys
are rejected (`.strict()`):

```json
{
  "version": 1,
  "backend": "git",
  "behaviors": {
    "commit": true,
    "isolate": true,
    "publish": false,
    "openReview": false,
    "branchPerRun": false
  },
  "ignore": ["build/", "*.tmp"]
}
```

- **`version`** (required) — schema version, currently `1`.
- **`backend`** (required) — one of `"git"`, `"perforce"`, `"none"`, or
  `"auto"` (defer to auto-detection).
- **`behaviors`** (optional, sparse) — per-verb toggles; any omitted key falls
  back to the backend's default.
- **`ignore`** (optional) — extra path globs excluded from change detection.

With no `.tasks/scm.json` and no charter `scm` default, a repo just auto-detects
its backend — no configuration is required to get git behavior.

## Prerequisites

- **Node.js 22 or higher** — matches the CI matrix (`actions/setup-node` with
  `node-version: '22'`) and is enforced by the `engines` field in
  `package.json`.
- **npm** — comes with Node.js.

The npm-only flow above (`npm i -g wood-fired-tasks` → `setup` → `serve`) needs
**only Node.js + npm** — `setup` merges `~/.claude.json` with native Node JSON
handling, so `jq`/`curl` are **not** required. The `jq` / `curl` prerequisites
below apply only to the **clone-based** `install.sh` installer used by the
development/self-hosting paths.

- **jq** — required by `install.sh` to merge the MCP server entry into
  `~/.claude.json` safely (raw heredocs would mis-quote the API key on
  embedded `"`/`\`/newline). Install with:
  - Debian/Ubuntu: `sudo apt-get install jq`
  - RHEL/CentOS: `sudo yum install jq`
  - Fedora: `sudo dnf install jq`
  - macOS: `brew install jq`
- **curl** — required by `install.sh` to validate that the API server is
  reachable at the configured URL (post-install connectivity check). Almost
  always preinstalled; install with the same package managers if missing.

The Windows installer (`install.ps1`) uses native PowerShell JSON handling
and `Invoke-WebRequest` instead, so it does not require `jq` or `curl`.

## Secrets

[CRITICAL] Treat every value in `.env` as a production-grade secret. The
file holds `SESSION_COOKIE_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and
`SLACK_SIGNING_SECRET` — anything leaked here grants full access to your
task data and Slack workspace. (PATs themselves live in the database, not
`.env`; treat any minted `wft_pat_…` value as an equally sensitive secret.)

**Rules:**

1. **Create `.env` fresh after every `git clone`.** Copy `.env.example`
   and fill in real values locally:

   ```bash
   cp .env.example .env
   # then edit .env with your real tokens
   ```

2. **`.env` is gitignored — never commit it.** The repo's `.gitignore`
   already excludes it; do not override that. Run `git status` before
   every commit and confirm `.env` is not staged.

3. **Never paste secrets into the repository.** Not in `.env.example`,
   not in code comments, not in test fixtures, not in commit messages,
   not in issue descriptions. If a secret lands in tracked content,
   rotate it immediately at the issuer (Slack admin console, API key
   generator, etc.) and scrub the working tree.

4. **Rotation requires a server restart.** Both the API server and the
   Slack subprocess read `.env` on boot only. After changing any value,
   restart with `npm run dev` (development) or your process manager
   (`pm2 restart wood-fired-tasks`, `systemctl restart …`) so the new
   value takes effect.

5. **Use a secret manager in production.** A flat `.env` file is fine
   for local development, but production deployments should source
   secrets from a dedicated manager such as:

   - [1Password CLI](https://developer.1password.com/docs/cli/) — `op run -- npm start`
   - [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/) — fetched at boot or via sidecar
   - [HashiCorp Vault](https://www.vaultproject.io/) — `vault agent` template rendering
   - [Doppler](https://www.doppler.com/) / [Infisical](https://infisical.com/) — drop-in `.env` replacements

   Inject the resolved values as environment variables on the process;
   do not write them to disk on the production host.

6. **Compromised tokens are assumed compromised forever.** If a token
   was ever in cleartext on a workstation that is not under your sole
   physical control (shared dev VM, CI runner, lost laptop), rotate it.
   Do not try to "remember which value was where" — rotate first, audit
   later.

## OIDC (Google) Configuration

OIDC (OpenID Connect) is the auth path for minting tokens. It provides
per-user identity, browser SSO via Google, and PATs (Personal Access Tokens)
minted from a logged-in session. All API authentication is now Bearer PAT only
(`Authorization: Bearer <pat>`); the old `X-API-Key` header is rejected with
401 — see [`SECURITY.md`](../SECURITY.md) → **Authentication Architecture**.

The browser login UI and `/me`-based PAT minting are gated on the `OIDC_*`
env vars; leaving them unset means PATs must be minted out-of-band via
`tasks db mint-token` (see [Bootstrap a PAT without a browser](#6-bootstrap-a-pat-without-a-browser-servers-ci-headless-agents)).

### 1. Create the Google OAuth client

1. Visit the [Google Cloud Console](https://console.cloud.google.com/) and
   pick (or create) the project that will own the OAuth client.
2. **APIs & Services → Credentials → Create Credentials → OAuth client
   ID**.
3. Application type: **Web application**.
4. Authorised JavaScript origins: the public origin of your server,
   e.g. `http://localhost:3000` for local dev or
   `https://bugs.example.com` for production.
5. Authorised redirect URIs: append `/auth/callback` to each origin,
   e.g. `http://localhost:3000/auth/callback`.
6. **Create** — copy the generated Client ID and Client Secret. The
   secret is shown only once.

### 2. Set the OIDC env vars

Add the following to your `.env` (or your secret manager). All four
`OIDC_*` vars are validated as a group — set all of them or none.

```bash
# Identity provider issuer URL. For Google this is fixed.
OIDC_ISSUER_URL=https://accounts.google.com

# From the Google Cloud Console step above.
OIDC_CLIENT_ID=your-client-id.apps.googleusercontent.com
OIDC_CLIENT_SECRET=your-client-secret

# Must exactly match an entry on the "Authorised redirect URIs" list.
OIDC_REDIRECT_URI=http://localhost:3000/auth/callback

# Optional — defaults to "openid email profile". The server requires at
# minimum "openid email" to map the OIDC subject to a local user row.
OIDC_SCOPES=openid email profile

# Optional — defaults to "wft-cli". The RFC 8628 device-flow client_id the
# `tasks` CLI sends during `tasks setup` → Remote. DISTINCT from OIDC_CLIENT_ID
# (the IdP's OAuth client id for the browser SSO leg): the device flow uses a
# logical client id the CLI and server agree on. Leave unset on both sides to
# use the default — the stock CLI then authenticates out of the box. Override
# only if you also set OIDC_DEVICE_CLIENT_ID to a matching value on the client.
OIDC_DEVICE_CLIENT_ID=wft-cli
```

### 3. Generate the session cookie secret

Required whenever OIDC is enabled. The cookie is a sodium sealed-box,
keyed on a 32-byte secret. Generate with:

```bash
openssl rand -base64 32
```

Then set:

```bash
# Must decode to exactly 32 bytes; the server refuses to boot otherwise.
SESSION_COOKIE_SECRET=<output of openssl rand -base64 32>

# Optional — the cookie name. Defaults to wft_session.
SESSION_COOKIE_NAME=wft_session
```

[CRITICAL] Treat `SESSION_COOKIE_SECRET` as a production-grade secret.
Rotating it invalidates every active session immediately — every user
must log in again.

[CRITICAL] The session cookie is marked `secure` only when
`NODE_ENV=production` (`src/api/server.ts` — the secure-session
registration sets `secure: config.NODE_ENV === 'production'`). A `secure`
cookie is never sent by the browser over plain HTTP, so in production the
browser/OIDC login flow **must** run behind HTTPS — even on a LAN.
Terminate TLS at a reverse proxy (or run the server with HTTPS) before
visiting `/auth/login`; otherwise the session cookie is dropped and login
silently loops back to the login page. In `development`/`test` the cookie
is non-`secure`, so plain `http://localhost` works.

### 3a. Device-flow verification origin & trust boundary

The RFC 8628 **device flow** returns a `verification_uri` derived **per-request**
from the address the client connected to (`Host` / `X-Forwarded-{Host,Proto}`;
see `resolveVerificationOrigin`) so a LAN/remote client gets a routable URL not
`localhost`. It is **not** host-header injection — the URI is returned only to
the requesting client, so a spoofed `Host` only misdirects the spoofer; the
server trusts its front-proxy to set `X-Forwarded-*` honestly (the same trust
`TRUST_PROXY` extends to rate-limit client identity). To pin the boundary, set
`DEVICE_FLOW_TRUSTED_HOSTS` (comma-separated hostname allowlist): a `Host` not on
it falls back to the `OIDC_REDIRECT_URI` origin; unset = all.

### 4. (Optional) `LEGACY_AUTH_SUNSET_DATE`

[NOTE] The legacy `X-API-Key` auth path has been **removed** (rejected with 401),
so this var is now inert — still parsed (`YYYY-MM-DD`) for backward
compatibility but with no runtime effect. New deployments can omit it.

### 5. Verify the OIDC flow

1. Restart the server (`npm run dev` locally).
2. In a browser, visit `http://localhost:3000/auth/login`.
3. Complete Google consent and land on `/me` (shows your email, display
   name, and PATs).
4. From `/me` mint a new PAT (value shown **once**, copy it then) or revoke one.

### 6. Bootstrap a PAT without a browser (servers, CI, headless agents)

For deployments where no browser is available, mint the first PAT directly
against the SQLite database (`--user` = numeric id, email, or legacy
display_name; `--name` = required label):

```bash
node dist/cli/bin/tasks.js db mint-token --user you@example.com --name my-laptop
```

The command prints the raw PAT to stdout once. Use it as the
`Authorization: Bearer wft_pat_<…>` value on subsequent requests, or as the
`WFT_API_KEY` env var in MCP/CLI clients (the REST client auto-switches to
`Authorization: Bearer …` for `wft_pat_` values). See [`SECURITY.md`](../SECURITY.md)
→ **Authentication Architecture** for the full chain.

[WARNING] **PATs have NO default expiry.** The `api_tokens.expires_at`
column is nullable (migration `008-identity-tables.ts`) and is written
`NULL` unless you pass `--expires-at`. A token minted without that flag
is valid indefinitely until it is explicitly revoked. Set an expiry at
mint time with an ISO-8601 timestamp:

```bash
# Mint a PAT that auto-expires. --expires-at takes an ISO-8601 instant.
node dist/cli/bin/tasks.js db mint-token \
  --user you@example.com --name ci-runner \
  --expires-at 2027-05-22T00:00:00Z
```

**Rotation & revocation.** Because non-expiring tokens never lapse on
their own, rotate long-lived PATs on a schedule: mint a replacement,
switch the consumer to the new value, then revoke the old one. Revoke a
token from the web UI (`/me` → your token list → revoke), or self-revoke
the token a CLI client is currently using via `tasks logout` (which calls
`DELETE /api/v1/me/tokens/active`). Revocation stamps `revoked_at` and the
token stops authenticating immediately; setting `--expires-at` at mint
time bounds the blast radius if a token is ever leaked and missed during
rotation.

### 7. Migrating from a pre-identity (key-only) deployment

Historical task / comment rows that pre-date v1.6 have NULL identity FKs
(`tasks.created_by_user_id`, `tasks.assignee_user_id`,
`task_comments.author_user_id`) because the legacy TEXT columns were the
only identity record at the time. Backfill the FKs from the TEXT columns
with:

```bash
# Dry-run — prints a per-mapping summary, no writes.
node dist/cli/bin/tasks.js db migrate-identities

# Apply. Idempotent: safe to re-run.
node dist/cli/bin/tasks.js db migrate-identities --commit
```

Unmatched TEXT values default to the lowest-id `is_legacy=1` user.
Override per-string with `--alias-map <file>`; pass
`--user-fallback skip` to leave the FK NULL when no mapping is found.
The CLI is detailed in [`CLI.md`](CLI.md).

[NOTE] Re-running `migrate-identities --commit` is a no-op once every
matchable row has been backfilled — the UPDATE is guarded by
`AND <fk_col> IS NULL`.

### 8. Migrating to v2.0 (the X-API-Key → Bearer-PAT auth cutover)

v2.0 **removes the legacy `X-API-Key` shared-secret auth path**. Every
authenticated request now carries a per-user **Bearer personal access
token (PAT)** instead of a single shared key — `Authorization: Bearer
<pat>` replaces the old `X-API-Key: <key>` header on every REST and remote
MCP call. There is **no compatibility shim**: a request that still sends
only `X-API-Key` is rejected after the cutover.

**Operator migration steps:**

1. **Enable the identity system** if you have not already — stand up OIDC
   (see the [OIDC enablement recipe](#oidc-enablement-recipe-remote-onboarding)
   below) so clients can self-onboard and mint their own PATs, or mint
   PATs administratively for clients that cannot use OIDC.
2. **Re-onboard each client** with `wood-fired-tasks setup --remote <url>`.
   The command probes the server's OIDC state and picks device-flow
   (OIDC ready) or manual-PAT (OIDC disabled/degraded) automatically, then
   caches the resulting Bearer PAT. Clients that were configured with an
   `X-API-Key` / shared key must be re-onboarded — the old key no longer
   authenticates.
3. **Retire the shared key.** Once every client carries a PAT, the old
   `API_KEYS` / shared-secret configuration is unused and can be removed
   from the server environment.

**No data migration is required.** The cutover is an *auth-surface* change
only — it does not touch task, project, comment, or identity tables.
Pre-identity rows that carry `is_legacy=1` are left **inert**: they are not
rewritten, not deleted, and require no action; they continue to read back
exactly as before. (If you want their identity FKs backfilled for
attribution, that is the separate, optional
[§7 migrate-identities](#7-migrating-from-a-pre-identity-key-only-deployment)
flow above — it is unrelated to and not needed for the v2.0 auth cutover.)

## OIDC enablement recipe (remote onboarding)

This is the end-to-end recipe for turning OIDC on for a shared/remote server so
that fleet clients can self-onboard with `wood-fired-tasks setup --remote`. It
ties together the OIDC env vars, the session-cookie secret, and the way
`setup --remote` reacts to the server's OIDC state. Auth stays **Bearer PAT
only** throughout — OIDC is the path that *mints* PATs; every API call still
carries `Authorization: Bearer <pat>`.

### Recipe

1. **Create the Google OAuth client** and copy the Client ID / Secret —
   [§1 above](#1-create-the-google-oauth-client). The authorised redirect URI
   must be `<public-origin>/auth/callback`.
2. **Set the four `OIDC_*` env vars** on the server — see
   [§2 above](#2-set-the-oidc-env-vars). `src/config/env.ts` validates them as a
   group: set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and
   `OIDC_REDIRECT_URI` **all together or not at all** (a partial set fails
   validation on `OIDC_ISSUER_URL`). `OIDC_SCOPES` defaults to
   `openid email profile`.
3. **Generate `SESSION_COOKIE_SECRET`** — required whenever OIDC is enabled
   (see below). `env.ts` enforces `!OIDC_ISSUER_URL || !!SESSION_COOKIE_SECRET`,
   so a server with OIDC set but no cookie secret refuses to boot.
4. **Terminate TLS** in front of the server. The session cookie is `secure` when
   `NODE_ENV=production`, so the browser drops it over plain HTTP and login
   silently loops — see the [OIDC cookie note](#3-generate-the-session-cookie-secret).
5. **Restart the server** and verify the flow via `/auth/login` →
   [§5 above](#5-verify-the-oidc-flow).
6. **Onboard clients** with `wood-fired-tasks setup --remote <url>`; the command
   probes the server's OIDC state and picks device-flow vs manual-PAT
   automatically (see [setup --remote OIDC states](#setup---remote-across-oidc-states-ready--disabled--degraded)).

### Generating `SESSION_COOKIE_SECRET`

`SESSION_COOKIE_SECRET` is the sealed-box key for `@fastify/secure-session`.
libsodium requires **exactly 32 bytes**, and `src/config/env.ts` enforces this
strictly: the value must be **base64-encoded and decode to exactly 32 bytes**,
or the server refuses to boot (`SESSION_COOKIE_SECRET must be base64-encoded 32
bytes`). Generate one with:

```bash
openssl rand -base64 32
```

Then set it (and, optionally, the cookie name) in `.env` or your secret manager:

```bash
# Must decode to exactly 32 bytes — env.ts refuses any other length.
SESSION_COOKIE_SECRET=<output of openssl rand -base64 32>

# Optional — defaults to wft_session.
SESSION_COOKIE_NAME=wft_session
```

[CRITICAL] Treat `SESSION_COOKIE_SECRET` as a production-grade secret. Rotating
it invalidates every active session immediately — every user must log in again.

### `setup --remote` across OIDC states (ready / disabled / degraded)

`wood-fired-tasks setup --remote <url>` probes the server before deciding how to
get a PAT onto the client. It issues `GET <url>/health/detailed` and reads
`oidc.state` (`src/cli/commands/setup.ts` → `probeOidcState`), which mirrors the
server's coarse OIDC state (`src/services/oidc-boot.ts`). It then routes
deterministically via `selectRemoteOnboardingMethod`:

| Server `oidc.state` | Meaning | `setup --remote` onboarding method |
|---------------------|---------|------------------------------------|
| `ready` | OIDC env vars set **and** issuer discovery succeeded | **device-flow** — RFC 8628 browser login (`runDeviceLogin`); the PAT is self-provisioned and written to the credentials file. |
| `disabled` | No `OIDC_*` env vars — browser login is not available | **manual-PAT** — paste a PAT (or pass `--token`); it is validated against `GET /api/v1/me` and persisted to the same credentials file. |
| `degraded` | OIDC is configured but issuer discovery is persistently failing (the server booted in degraded mode rather than crash-looping — see `oidc-boot.ts`) | **manual-PAT** — the device flow would fail, so `setup` informs you and falls back to the manual path. |
| probe failure | `/health/detailed` unreachable, non-2xx, or no `oidc.state` (e.g. an older server) | **manual-PAT** — connectivity escape hatch. |

In every non-`ready` case the resolved PAT lands in the **same credentials
file** the device flow writes, and the `~/.claude.json` remote entry stays
**URL-only** (`WFT_API_URL` with no embedded token) — the remote bridge resolves
its bearer token from the credentials file at runtime, so the secret is never
written into `claude.json`. A manual PAT that fails validation against
`GET /api/v1/me` persists **nothing**: `setup` reports the reason and exits
without a half-configured install. Mint the PAT to paste with
`tasks db mint-token` (next section) or from the web UI (`/me`).

### No-OIDC bootstrap (mint the first PAT directly)

On a server **without OIDC** (`oidc.state: disabled`) there is no browser login,
so the host operator mints the first PAT **directly against the database** with
`tasks db mint-token` and hands it to the manual-PAT path above. The command
requires an existing user row to target — a **seeded service/user account** (for
a fresh deployment this is the lowest-id `is_legacy=1` user created by the
identity backfill, or any user row already present from prior task/comment
activity). `--user` resolves a numeric id, an email (case-insensitive), or a
legacy `display_name`:

```bash
# Mint the bootstrap PAT against the seeded service/user account.
# --user accepts a numeric id, email, or legacy display_name; --name is required.
node dist/cli/bin/tasks.js db mint-token --user 1 --name bootstrap

# Equivalently by email, with a bounded expiry:
node dist/cli/bin/tasks.js db mint-token \
  --user service@example.com --name bootstrap \
  --expires-at 2027-05-22T00:00:00Z
```

The token is printed to stdout **exactly once** (alongside its id, user, and
scopes). Use it as the manual PAT for `setup --remote` on a `disabled`/`degraded`
server, or directly as `Authorization: Bearer wft_pat_<…>` / the `WFT_API_KEY`
env var. See [Bootstrap a PAT without a browser](#6-bootstrap-a-pat-without-a-browser-servers-ci-headless-agents)
for the expiry, rotation, and revocation contract.

## Development Setup

### 1. Clone and Install

```bash
git clone https://github.com/Wood-Fired-Games/wood-fired-tasks.git
cd wood-fired-tasks
npm ci   # fresh, lockfile-exact install (the README Quick Start uses this)
```

### 2. Create Environment File

Create a `.env` file in the project root:

```bash
# API Server Configuration
PORT=3000
# HOST defaults to 127.0.0.1 (loopback only). Uncomment the next line to
# expose the server on the LAN — required only when you actually want
# other machines on your network to reach it.
# HOST=0.0.0.0
LOG_LEVEL=debug
NODE_ENV=development

# Database
DATABASE_PATH=./data/tasks.db

# CLI Configuration (for testing CLI commands)
API_BASE_URL=http://localhost:3000
# A PAT (wft_pat_…). Mint one with `tasks login` or `tasks db mint-token`.
API_KEY=wft_pat_your-dev-token
```

[IMPORTANT] Authentication is Bearer PAT only. The CLI sends `API_KEY` (a
`wft_pat_…` value) as `Authorization: Bearer <pat>`; `tasks login` caches a PAT
to the credentials file and takes precedence over `API_KEY`. There is no static
server-side key list — mint PATs at runtime via the web UI (`/me`),
`tasks login`, or `tasks db mint-token`. See [OIDC](#oidc-google-configuration)
and the README "Security Model".

[NOTE] `DATABASE_PATH` is the canonical name validated by `src/config/env.ts`
(default `./data/tasks.db`) and is honored consistently across every entry
point: the API server (`npm start` → `dist/api/start.js`, and `npm run dev`)
threads it into `createServer` so the process opens the operator-configured
database; `npm run migrate` resolves it the same way (see
`resolveMigrateDbPath` in `src/db/migrate.ts`); and the offline CLI commands
read it directly. The MCP server also accepts the legacy `DB_PATH` as an alias
for backward compatibility with older `~/.claude.json` installs, but new
configurations should use `DATABASE_PATH`. See the
[Environment Variables](#environment-variables) section below for the full list.

### 3. Build the Project

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

### 4. Run Database Migrations

```bash
npm run migrate
```

This creates the SQLite database at `DATABASE_PATH` (default `./data/tasks.db`)
and runs all migrations to set up the schema. `npm run migrate` honors
`DATABASE_PATH` — the same env var the API server and CLI read — so the
migration targets exactly the database the server will open.

### 5. Start Development Server

```bash
npm run dev
```

The API server will start with hot reload enabled. Any changes to TypeScript files will automatically restart the server.

[TIP] The development server uses `pino-pretty` for colored, human-readable logs.

### 6. Pre-publish smoke test

Before cutting a release, run the fresh-clone smoke recipe to prove the
documented first-user flow (the [README Quick Start](../README.md#quick-start))
still works end-to-end from a clean slate:

```bash
npm run smoke
# or directly:
./scripts/smoke/fresh-clone-smoke.sh
```

What it does, in order: **migrate → build → start the API → `npm run cli --
project-create` → `npm run cli -- create` → `npm run cli -- list`** — the exact
subcommands the Quick Start documents, with `--json` to parse the created
project/task ids.

This smoke is **MANUAL, not part of CI** — it is a maintainer's pre-publish
check, kept out of the CI matrix because it boots a real HTTP server and builds
`dist/`. It is hermetic and production-safe:

- It uses a throwaway `mktemp -d` `DATABASE_PATH` and a **non-secret** local PAT
  minted against that temp DB (`tasks db mint-token`), exported as `API_KEY` —
  it never touches the real `./data` directory or any production database.
- It points `WFT_CREDENTIALS_PATH` at the temp dir so a real cached PAT on your
  machine can't shadow the env key (matching a brand-new clone with no prior
  `tasks login`).
- It binds a non-default `PORT` (override with `SMOKE_PORT=…`) so it won't clash
  with a server already running on `:3000`.
- On exit (success or failure) it kills the server and removes the temp dir.

It prints `SMOKE PASS` and exits `0` on success; on any failed step it prints the
failing step and exits non-zero.

## Production Deployment

The `deploy/` scripts split host provisioning from app deployment: operators
run `deploy/install.sh` **once** to create the service user, install dirs,
and systemd unit, then run `deploy/upgrade.sh` **on every release** to
backup, copy `dist/`, migrate, restart, and health-probe. See
[Self-hosting and upgrades](#self-hosting-and-upgrades) for the full
walkthrough (first-time install, in-place upgrades, fork-and-deploy, manual
rollback, migration safety contract). The manual steps below remain valid
for operators not using the scripts.

### 1. Install and Build

```bash
npm install --production
npm run build
```

### 2. Set Production Environment Variables

```bash
export NODE_ENV=production
export PORT=3000
# HOST defaults to 127.0.0.1 (loopback only). Set to 0.0.0.0 to listen on
# all interfaces, or to a specific LAN IP to bind only to that NIC. Do
# this only when the server is intended to be reachable from other hosts;
# in containerised or reverse-proxied deployments, prefer a specific
# interface or rely on the container network instead of 0.0.0.0.
export HOST=0.0.0.0
export LOG_LEVEL=warn
export DATABASE_PATH=/var/lib/wood-fired-tasks/tasks.db
# Authentication is Bearer PAT only — no key list in the environment.
# Mint per-machine PATs at runtime (tasks login / tasks db mint-token).
```

[IMPORTANT] Treat every minted PAT as a production-grade secret — each one provides full access to your task data. Issue one PAT per machine/agent so you can revoke them independently.

[SECURITY] The server binds to `127.0.0.1` (loopback) by default. New deployments
must opt in to LAN exposure by setting `HOST=0.0.0.0` (or a specific LAN IP).
On boot the bound interface is logged at info level so the binding is
visible to operators.

#### Optional hardening flags

| Variable | Default | Effect |
|----------|---------|--------|
| `WFT_STRICT_EVIDENCE` | `false` (off) | When `true`, `update_task` rejects a `verification_evidence` payload that shows the structural tells of fabrication — an empty `verifier_session_id`, one equal to the task assignee or the calling identity, one matching a self-grading pattern (`^orchestrator`/`^self`/`^main-loop`), or placeholder/empty check evidence text. Recommended for any deployment that closes tasks via `/tasks:loop` or `/tasks:loop-dag`. See [`RELIABILITY.md`](RELIABILITY.md). |

```bash
# Opt in to server-side anti-fabrication validation (default off):
export WFT_STRICT_EVIDENCE=true
```

This is one of three defense-in-depth layers; the deterministic SHA-existence
check is a client-side hook (see [`hooks/README.md`](hooks/README.md)) because
the server cannot reach an arbitrary client's git repository. Full rationale,
the motivating incident, and an honest statement of what the guardrails do
**not** guarantee are in [`RELIABILITY.md`](RELIABILITY.md).

### 3. Run Migrations

```bash
npm run migrate
```

### 4. Start the Server

```bash
npm start
```

This runs the compiled JavaScript from `dist/api/start.js`. The server honors
`DATABASE_PATH` — `start.js` threads the validated `config.DATABASE_PATH` into
`createServer`, so it opens the operator-configured database (e.g.
`/var/lib/wood-fired-tasks/tasks.db`) rather than a hard-coded default. `npm run
dev` (development) opens the same `DATABASE_PATH`-resolved database.

[TIP] Use a process manager like PM2 or systemd to keep the server running and restart on failure.

Example with PM2:

```bash
pm2 start npm --name "wood-fired-tasks" -- start
pm2 save
pm2 startup
```

## Self-hosting and upgrades

This section is the operator contract for running Wood Fired Tasks on your
own host with the shipped `deploy/install.sh` and `deploy/upgrade.sh`
scripts. The scripts are the source of truth — every command below maps
to a line in one of them.

Two environment variables control where everything lands; both scripts
honour them and `upgrade.sh` re-execs itself under `sudo` with these
preserved:

| Variable | Default | Used by |
|----------|---------|---------|
| `WFT_INSTALL_DIR` | `/opt/wood-fired-tasks` | `install.sh`, `upgrade.sh` |
| `WFT_SERVICE_NAME` | `wood-fired-tasks` | `upgrade.sh` (systemd unit name) |
| `WFT_SERVICE_USER` | `wood-fired-tasks` | `install.sh` (locked-down system account) |

Prerequisites on the host: Node.js at `/usr/bin/node`, `sqlite3` CLI
(`sudo apt-get install sqlite3`), and `curl` (used by the health probe).

### First-time install

Run `deploy/install.sh` **once** as root (or with `sudo`) to provision the
host. It creates the `wood-fired-tasks` system user, lays out
`$WFT_INSTALL_DIR/{data,backups,dist}`, seeds `.env` from
`deploy/wood-fired-tasks.env.example` if absent, installs the systemd unit
at `/etc/systemd/system/wood-fired-tasks.service`, writes a drop-in override
when you have overridden the install dir or service user, and `enable`s
the service (it does **not** start it — the first deploy starts it). After
this completes, edit `$WFT_INSTALL_DIR/.env` to set the server vars from the
[Environment Variables](#environment-variables) table (OIDC, session cookie
secret, etc.), then move on to the upgrade step. Authentication is Bearer PAT
only — mint PATs at runtime once the server is up, not via `.env`.

```bash
sudo ./deploy/install.sh
sudo $EDITOR /opt/wood-fired-tasks/.env   # set OIDC_*, SESSION_COOKIE_SECRET, etc.
```

### Upgrading an existing install

Run `deploy/upgrade.sh` **on every release** to push a fresh build into
`$WFT_INSTALL_DIR`. The script re-execs itself with `sudo` if invoked
unprivileged (preserving `WFT_INSTALL_DIR` and `WFT_SERVICE_NAME`), so
plain `./deploy/upgrade.sh` works. It refuses to run if `./dist/` is
missing or any file under `./src/` is newer than `./dist/` (build first),
then in order: copies `data/tasks.db` (+ `.db-wal` / `.db-shm` if present)
to `$WFT_INSTALL_DIR/backups/pre-deploy-<UTC>.db[*]`, copies the live
`dist/` to `$WFT_INSTALL_DIR/backups/dist-pre-deploy-<UTC>/`, stops the
service, replaces `$WFT_INSTALL_DIR/dist`, copies `package.json` +
`package-lock.json`, runs `npm ci --omit=dev` in the install dir, re-chowns
the new files to the service user, runs `node dist/db/migrate.js`, starts
the service, and polls `http://localhost:$PORT/health` (port read from
`$WFT_INSTALL_DIR/.env`, defaulting to `3000`) for up to 30 seconds. On
success it prints the DB and dist backup paths; on failure it prints the
exact rollback commands (see [Manual rollback procedure](#manual-rollback-procedure))
and exits non-zero. There is no automatic rollback — migrations make that
unsafe.

```bash
npm ci && npm run build
sudo ./deploy/upgrade.sh
```

Artifacts produced on every run:

- **DB backup:** `${WFT_INSTALL_DIR}/backups/pre-deploy-<TS>.db` (plus
  `.db-wal` / `.db-shm` if those existed). `<TS>` is a UTC timestamp like
  `20260523T193059Z`.
- **dist backup:** `${WFT_INSTALL_DIR}/backups/dist-pre-deploy-<TS>/`
  (a full copy of the previous `dist/`).

Backups are kept indefinitely; prune `$WFT_INSTALL_DIR/backups/` manually
when no longer needed.

### Deploying your fork

If you have forked this repo and want to keep current with upstream
releases while shipping your own changes, the workflow is a standard
upstream-pull plus the same `upgrade.sh` step. From a checkout of your
fork on the deploy host:

```bash
# One-time: register the upstream remote (skip if already set).
git remote add upstream https://github.com/Wood-Fired-Games/wood-fired-tasks.git

# Per release: pull upstream, resolve any conflicts, build, deploy.
git fetch upstream
git pull upstream main
# Resolve conflicts here if git stops; commit the merge.
npm ci && npm run build
sudo ./deploy/upgrade.sh
```

If `upgrade.sh`'s `/health` probe passes, you are done. If it fails, the
script prints the rollback recipe — follow it as written, then inspect
`sudo journalctl -u wood-fired-tasks -n 200` to diagnose.

### Manual rollback procedure

`upgrade.sh` does not roll back automatically. If the post-deploy health
probe fails (or if you notice a regression after the fact), restore from
the artifacts captured at the start of the failed run. Substitute the
real `<TS>` from the upgrade output (e.g. `20260523T193059Z`); the script
also prints these exact commands to stderr on failure.

```bash
sudo systemctl stop wood-fired-tasks
sudo rm -rf /opt/wood-fired-tasks/dist
sudo cp -a /opt/wood-fired-tasks/backups/dist-pre-deploy-<TS> /opt/wood-fired-tasks/dist
sudo cp /opt/wood-fired-tasks/backups/pre-deploy-<TS>.db /opt/wood-fired-tasks/data/tasks.db
[ -f /opt/wood-fired-tasks/backups/pre-deploy-<TS>.db-wal ] && \
  sudo cp /opt/wood-fired-tasks/backups/pre-deploy-<TS>.db-wal /opt/wood-fired-tasks/data/tasks.db-wal
[ -f /opt/wood-fired-tasks/backups/pre-deploy-<TS>.db-shm ] && \
  sudo cp /opt/wood-fired-tasks/backups/pre-deploy-<TS>.db-shm /opt/wood-fired-tasks/data/tasks.db-shm
sudo systemctl start wood-fired-tasks
```

Then check the service: `sudo journalctl -u wood-fired-tasks -n 200`. If
you overrode `WFT_INSTALL_DIR` at install time, substitute that path
everywhere `/opt/wood-fired-tasks` appears above.

### Migration safety contract

`upgrade.sh` runs `node dist/db/migrate.js` between copying the new
artefacts and starting the service. The upgrade path assumes the
migration is **reversible** — i.e. the matching `down` works and is
covered by `migrations-roundtrip.test.ts`. For forward-only migrations,
the rollback recipe above restores `tasks.db` from the pre-deploy backup
**but** schema-only `down` revert via Umzug is not safe; treat the SQLite
backup as the recovery surface. Re-read `docs/RELEASE.md`
[Migration expectations](RELEASE.md#migration-expectations) before
shipping any release that adds a migration — it spells out the
serialized-flow, transactional, backfill-test, and `down`/backup-restore
gates the release contract enforces.

## CLI Installation

From a fresh clone the CLI runs **in-tree** with no global install — this is
the path the [README Quick Start](../README.md#quick-start) uses. A global
`tasks` binary via `npm link` is **optional** and only convenient if you want
to call `tasks` from outside the repo.

### In-tree usage (default — no link, no build required)

From the project directory, invoke the CLI through the npm script. Everything
after `--` is passed verbatim to the CLI:

```bash
npm run cli -- <command> [options]
```

`npm run cli --` prints a two-line npm banner before the CLI output; add
`--silent` to suppress it when you need clean stdout (e.g. piping `--json`):

```bash
npm run cli --silent -- --json project-create --name "My Project"
```

Equivalently, run the entry point directly with `tsx`:

```bash
npx tsx src/cli/bin/tasks.ts <command>
```

### Global installation (optional)

If you want a global `tasks` command runnable from any directory, link the
package once from the project root:

```bash
npm link
```

This creates a global `tasks` command. Every `npm run cli -- <command>`
example in [`CLI.md`](CLI.md) then works as a bare `tasks <command>`.

### Environment Variables for CLI

The CLI needs to know where to find the API server and how to authenticate:

```bash
export API_BASE_URL=http://localhost:3000   # default; the CLI target
export API_KEY=wft_pat_your-token-here       # a PAT (wft_pat_…)
```

Authentication is Bearer PAT only — the CLI sends `API_KEY` (a `wft_pat_…`
value) as `Authorization: Bearer <pat>`. For interactive use prefer
`npm run cli -- login` (OIDC device flow), which caches a PAT to the credentials
file and takes precedence over `API_KEY`; for one-off calls pass `--token
wft_pat_…`. Mint PATs via the web UI (`/me`), `tasks login`, or `tasks db
mint-token`.

[TIP] Add these to your `.bashrc` or `.zshrc` for persistent configuration.

## Claude Code Integration

`wood-fired-tasks setup` wires this package into Claude Code — it merges an MCP
server entry into `~/.claude.json` and copies the `/tasks:*` slash commands into
`~/.claude/commands/tasks/`. The canonical install flow (npm install +
`setup`, with **Local / Service / Remote** modes) is covered under
[Frictionless install (npm — no clone)](#frictionless-install-npm--no-clone).
This section recaps what `setup` writes and how to roll it out across a
multi-OS client fleet.

> The old `./install.sh --mode …` / `.\install.ps1 -Mode …` git-clone installers
> are **retired** — both scripts are now deprecation shims that just delegate to
> `wood-fired-tasks setup`. There is no `--mode`, `--api-key`, or
> `WOOD_FIRED_TASKS_API_KEY` resolution anymore.

### Setup modes

| Mode | Invocation | Server name in `~/.claude.json` | What it does | Token |
|------|-----------|---------------------------------|--------------|-------|
| Local (default) | `wood-fired-tasks setup` | `wood-fired-tasks` | Spawns the stdio MCP server (`dist/mcp/index.js`) that opens the SQLite database in-process. | **Not used** — local MCP only needs `DATABASE_PATH`. |
| Remote | `wood-fired-tasks setup --remote <url> --token wft_pat_…` | `wood-fired-tasks-remote` | Spawns the stdio bridge (`dist/mcp/remote/index.js`) that proxies every tool call to a deployed REST API. | A per-user **PAT**, cached in the CLI credentials file — **never** written into `~/.claude.json` (#810). |
| Service | `wood-fired-tasks setup --service` | — | Installs the API server itself as a user-scoped background service (no `~/.claude.json` change). | — |

Local and Remote write independent entries under different server names, so it
is safe to run `wood-fired-tasks setup` (Local) and later add a remote entry
with `wood-fired-tasks setup --remote <url> --token wft_pat_…` — they coexist.
Running `setup` with **no arguments** on a TTY presents the Local/Service/Remote
menu; `--local` / `--service` / `--remote` pick a path non-interactively. A
**tokenless** `setup --remote <url>` runs the interactive OIDC **device-flow**
(or **manual-PAT** when the server's OIDC is disabled/degraded) onboarding — see
[`setup --remote` across OIDC states](#setup---remote-across-oidc-states-ready--disabled--degraded).

### Multi-OS client fleet (one shared on-prem server)

The common production shape is one self-hosted API server (per
[Self-hosting and upgrades](#self-hosting-and-upgrades)) with a fleet of
Windows, Linux, and macOS workstations all pointing their Claude Code (and/or
the `tasks` CLI) at it in **remote mode**. Each client runs the stdio remote
bridge, which proxies every MCP tool call to the shared REST API — so every
machine sees one backlog.

There are three moving parts: the **server URL** every client must reach, a
**per-client token**, and the **per-client `setup --remote` invocation**.

#### 1. Make the server reachable

- Bind the server to a routable interface (`HOST=0.0.0.0` or a specific LAN IP)
  — see [Set Production Environment Variables](#2-set-production-environment-variables).
  By default it is loopback-only and no other machine can reach it.
- Put it behind a TLS-terminating reverse proxy. This is **required** if you use
  OIDC browser login (the session cookie is `secure` in production and is
  dropped over plain HTTP — see the OIDC cookie note above) and strongly
  recommended regardless, so tokens never cross the network in cleartext.
- The reachable origin (e.g. `https://tasks.example.com`) is the `<url>` every
  client passes to `wood-fired-tasks setup --remote <url>`.

#### 2. Mint one token per client

Issue a **separate PAT per machine** (or per user-machine pair) so you can
revoke one client without disturbing the rest. From the server (or any host
with CLI access to its database):

```bash
# One PAT per client, labelled so you can identify and revoke it precisely.
wood-fired-tasks db mint-token --user alice@example.com --name alice-macbook
wood-fired-tasks db mint-token --user alice@example.com --name alice-winbox
wood-fired-tasks db mint-token --user bob@example.com   --name bob-linux-ws
```

Each command prints the raw `wft_pat_…` once — copy it to that machine and
nowhere else. Bound the blast radius with `--expires-at` and rotate on a
schedule; see
[Bootstrap a PAT without a browser](#6-bootstrap-a-pat-without-a-browser-servers-ci-headless-agents)
and its rotation/revocation notes. A per-machine PAT is the unit of access —
revocable, attributable, and expiry-bounded.

The remote bridge sends the resolved token as `Authorization: Bearer …`, so a
`wft_pat_…` is exactly what each client passes to `setup --remote … --token`.

#### 3. Onboard each client with `setup --remote`

On each client (with the CLI installed via `npm i -g wood-fired-tasks`), point it
at the shared server with that machine's PAT. The command writes a **URL-only**
`wood-fired-tasks-remote` entry to that machine's `~/.claude.json` and caches the
PAT in the CLI credentials file (#810) — the token is never stored in
`claude.json`:

**Linux / macOS / Windows** — same command everywhere:

```bash
wood-fired-tasks setup --remote https://tasks.example.com --token wft_pat_…this-machine…
```

The `--token` path is non-interactive and works offline (no OIDC probe). If the
server has OIDC enabled and you'd rather not paste a PAT, run the tokenless form
`wood-fired-tasks setup --remote https://tasks.example.com` and complete the
browser **device flow** instead. Restart Claude Code afterward.

#### Fleet checklist

| Step | Linux | macOS | Windows |
|------|-------|-------|---------|
| Install the CLI | `npm i -g wood-fired-tasks` | same | same |
| Onboard the client | `wood-fired-tasks setup --remote <url> --token wft_pat_…` | same | same |
| MCP server name written | `wood-fired-tasks-remote` | same | same |

Every client writes the identical `wood-fired-tasks-remote` server name pointing
at the shared `WFT_API_URL`, so a backlog created on one machine is visible from
all the others. To cut off a single client, revoke its PAT (web `/me` → revoke,
or rotate per the PAT notes) — the rest of the fleet is unaffected.

> **CLI fleet, not Claude Code?** The same server serves the `tasks` CLI: set
> `API_BASE_URL=https://tasks.example.com` and authenticate with `tasks login`
> (OIDC device flow) or pass `--token wft_pat_…` per command. See
> [CLI Installation](#cli-installation).

### What `setup` does

1. **Copies skill files** to `~/.claude/commands/tasks/` (every `.md` file in the packaged `skills/tasks/`; currently 19, which includes the typed `/tasks:*` slash commands plus shared includes like `_enums`, `loop-shared`, and the `wsjf-rubric` scoring contract)
2. **Merges the MCP server entry** into `~/.claude.json`:
   - Local: adds/updates the `wood-fired-tasks` entry pointing at `dist/mcp/index.js`
   - Remote: adds/updates the `wood-fired-tasks-remote` entry pointing at `dist/mcp/remote/index.js` (**URL-only** — the PAT lives in the credentials file)
3. **Configures environment** — `DATABASE_PATH` for Local; `WFT_API_URL` for Remote (the PAT is cached in the CLI credentials file, not `~/.claude.json`)

### Resulting MCP Configuration

**Local mode (default)** — no API key is written:

```json
{
  "mcpServers": {
    "wood-fired-tasks": {
      "command": "node",
      "args": ["dist/mcp/index.js"],
      "cwd": "/path/to/wood-fired-tasks",
      "env": {
        "DATABASE_PATH": "./data/tasks.db"
      }
    }
  }
}
```

**Remote mode** — separate server name, **URL-only** (the PAT is cached in the
CLI credentials file, never written here — #810):

```json
{
  "mcpServers": {
    "wood-fired-tasks-remote": {
      "command": "node",
      "args": ["dist/mcp/remote/index.js"],
      "cwd": "/path/to/wood-fired-tasks",
      "env": {
        "WFT_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

The bridge resolves its Bearer token at runtime with precedence: env
`WFT_API_KEY` (an explicit operator override you may add here) → the CLI
credentials file written by `setup --remote`/`tasks login`. A leaked
`claude.json` therefore exposes no token.

[NOTE] Older installs may have `DB_PATH` instead of `DATABASE_PATH`. The MCP
server still accepts that as a deprecated alias, but re-running the installer
or hand-editing to `DATABASE_PATH` is recommended for consistency with
`src/config/env.ts`.

[NOTE] The local MCP server runs as a separate process via stdio. It creates
its own database connection and does NOT call the REST API.

#### Migration: removing an unused API key from older local installs (task #258)

Versions of the installer before task #258 wrote `WOOD_FIRED_TASKS_API_KEY`
into the `wood-fired-tasks` MCP entry even though the **local** MCP server
never reads it (it only consumes `DATABASE_PATH`). The key sat there as
dead weight and as a needless leak surface.

If you previously ran `./install.sh` or `.\install.ps1` and your
`~/.claude.json` looks like this under `mcpServers."wood-fired-tasks".env`:

```json
{
  "WOOD_FIRED_TASKS_API_KEY": "...",
  "DATABASE_PATH": "./data/tasks.db"
}
```

…you can safely **delete the `WOOD_FIRED_TASKS_API_KEY` line** by hand. The
local MCP server will keep working with only `DATABASE_PATH`. Re-running
`wood-fired-tasks setup` also rewrites the entry without the key. If you also
want the remote bridge, run `wood-fired-tasks setup --remote <url> --token
wft_pat_…` to add a separate URL-only `wood-fired-tasks-remote` entry (the PAT
is cached in the credentials file, not in `claude.json`).

### Skill Files

After installation, you can use these slash commands in Claude Code:

| Skill | Command | Description |
|-------|---------|-------------|
| Create Task | /tasks:create-task | Create a new task with project, priority, and assignee |
| Show Task | /tasks:show-task | Show full task details with comments and dependencies |
| My Work | /tasks:my-work | List tasks assigned to current user grouped by status |
| Project Status | /tasks:project-status | Show project overview with task counts and completion |
| Search | /tasks:search | Search tasks by keyword across titles and descriptions |
| Log Bug | /tasks:log-bug | Create a high-priority bug report task |
| Done | /tasks:done | Mark a task as complete |
| Blocked | /tasks:blocked | Mark a task as blocked and record reason |
| Pick Up | /tasks:pick-up | Assign task to current user and set to in_progress |
| Add Comment | /tasks:add-comment | Add a comment to a task |
| New Project | /tasks:new-project | Skippable charter interview capturing the project's value charter (mission, ranked value themes, time pressure, risk posture, out-of-scope) for WSJF Business-Value scoring |

All skills use the MCP tools under the hood for data access. The table above
lists the user-facing slash commands; `skills/tasks/` also ships planning and
WSJF skills (`decompose`, `loop`, `loop-dag`, `wsjf-rubric`, and shared/enum
includes) that are invoked from workflows rather than typed directly — see
[docs/MCP.md](MCP.md) for the WSJF tool surface those skills consume.

## Database

### Technology

- **Driver:** better-sqlite3 (synchronous SQLite library for Node.js)
- **Mode:** WAL (Write-Ahead Logging) for better concurrency
- **Migrations:** Umzug for automatic schema versioning

### Database Path

Set via `DATABASE_PATH` environment variable. Defaults to `./data/tasks.db`.
Honored consistently by the API server (`npm start` / `npm run dev`), the
migration CLI (`npm run migrate`), and the offline CLI commands. The MCP server
also accepts the legacy `DB_PATH` as a deprecated alias for backward
compatibility with older `~/.claude.json` installs.

### Migrations

Fifteen migration files in `src/db/migrations/`:

1. `001-initial-schema.ts` — Creates `projects`, `tasks`, `task_tags`, `dependencies`, `comments` tables.
2. `002-task-hierarchy-and-dependencies.ts` — Task hierarchy (`parent_task_id`) and dependency tracking.
3. `003-comments-and-estimates.ts` — Comments and `estimated_minutes` field.
4. `004-claim-protocol.ts` — Optimistic-lock `version` field, `claimed_at` column, `idempotency_keys` table.
5. `005-backlogged-status.ts` — Adds `backlogged` to the task status CHECK constraint (rebuilds `tasks` table; preserves FTS triggers).
6. `006-slack-channel-subscriptions.ts` — New `slack_channel_subscriptions` table for the Slack notifier (channel × project × event_type).
7. `007-completed-at.ts` — Adds `completed_at` timestamp populated on transition into `done` (backfilled from `updated_at` for existing done rows).
8. `008-identity-tables.ts` — Creates the `users` and `api_tokens` tables (plus their indexes) backing OIDC/PAT identity (v1.6).
9. `009-parallel-fk-columns.ts` — Adds the `*_user_id` FK columns (`tasks.created_by_user_id`, `tasks.assignee_user_id`, `task_comments.author_user_id`) alongside the legacy TEXT identity columns.
10. `010-identity-uniqueness-indexes.ts` — Adds uniqueness indexes for the legacy `display_name` and the seeded `slack-bot` service account.
11. `011-acceptance-criteria.ts` — Adds the `tasks.acceptance_criteria` column.
12. `012-verification-evidence.ts` — Adds the `tasks.verification_evidence` column.
13. `013-wsjf-fields.ts` — Adds the per-task WSJF columns: four CHECK-constrained Fibonacci component columns (`wsjf_value`, `wsjf_time_criticality`, `wsjf_risk_opportunity`, `wsjf_job_size`) plus five JSON metadata columns (`wsjf_evidence`, `wsjf_locked`, `wsjf_source`, `wsjf_classifications`, `wsjf_features`). All nullable; the all-four-or-none invariant is enforced at the DTO boundary.
14. `014-value-charter.ts` — Adds the nullable JSON `projects.value_charter` column (per-project Business-Value reference frame captured by `/tasks:new-project`).
15. `015-wsjf-audit.ts` — Creates the three append-only WSJF audit tables (in FK order): `wsjf_rescore_run` (one row per rescore event), `wsjf_score_history` (one immutable row per score write, storing full classification inputs for replay), and `project_charter_history` (full charter snapshot per interview version), with their supporting indexes.

### Task statuses

Valid statuses (post-005): `open`, `in_progress`, `done`, `closed`, `blocked`, `backlogged`.

`backlogged` is a non-terminal "deferred but not abandoned" state distinct from
`closed` (won't-do / archive). `completed_at` is populated only when a task
enters `done`; it is intentionally not set for `closed`.

Migrations run automatically on server start. To run manually:

```bash
npm run migrate
```

[TIP] Migrations are idempotent and safe to run multiple times.

### Database Access

Each interface creates its own database connection:

- **API Server:** Connection created by `createServer` (invoked from `dist/api/start.js`, opened at the validated `DATABASE_PATH`), shared across all routes
- **CLI:** Connection created per command execution
- **MCP Server:** Connection created on server start, shared across all tool calls

All connections use the same schema and WAL mode.

## Testing

### Run Tests

```bash
npm test
```

Runs the full test suite with Vitest (2640 tests across 204 files).

### Watch Mode

```bash
npm run test:watch
```

Runs tests in watch mode for active development.

### Test Coverage

Tests include:

- Service layer unit tests (TaskService, ProjectService, DependencyService, CommentService)
- API route integration tests (all REST routes, including the WSJF task/project endpoints under `/api/v1/tasks/:id/wsjf`, `/score-history`, and `/api/v1/projects/:id/wsjf-ranking`, `/wsjf-health`, `/rescore`, `/charter-history`, `/rescore-runs`)
- MCP tool tests (all 31 tools, including the four WSJF tools `wsjf_ranking`, `wsjf_history`, `rescore_project`, `wsjf_health` with stdio↔remote parity coverage, and the four Model tools `list_models`, `resolve_model`, `get_model_defaults`, `set_model_defaults`)
- WSJF scoring/ranking tests (deterministic `validateScoreSubmission` gate, blocker-propagated `rankFrontier`, `wsjf-rescore` transaction, and the `wsjf-health` degeneracy linter)
- CLI command tests (including `wsjf-history`, `wsjf-set`, `charter-history`)
- Event system tests (EventBus, SSEManager, events API)
- Claim protocol tests (including 20-agent concurrency)
- Workflow engine tests (auto-complete, auto-unblock, cascade depth)
- Skill file validation tests
- E2E regression tests

[TIP] Tests use in-memory SQLite databases for fast execution and isolation.

## Swagger UI

Interactive API documentation is available at:

```
http://localhost:3000/docs
```

[NOTE] Swagger UI is available in both development and production. Use it to explore endpoints, view schemas, and test API calls with authentication.

The Swagger UI includes:

- All endpoint schemas with request/response examples
- Interactive "Try it out" functionality
- Authentication support (Authorization: Bearer PAT header)
- Full schema definitions from Zod validators

## Environment Variables

The canonical schema lives in [`src/config/env.ts`](../src/config/env.ts) and
is enforced with Zod at server startup. Misconfiguration causes the server to
fail fast with sysexits `EX_CONFIG` (78). The table below documents every
variable the server reads, plus the CLI- and MCP-specific variables.

### Server (read by `src/config/env.ts`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | no | `development` | One of `development`, `production`, `test`. Switches log formatting (pino-pretty in dev) and Swagger gating in production. |
| `PORT` | no | `3000` | HTTP server port. |
| `HOST` | no | `127.0.0.1` | Bind interface. Loopback-only by default (task #188). Set `0.0.0.0` or a LAN IP to expose. The bound interface is logged at info level on boot. |
| `LOG_LEVEL` | no | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `DATABASE_PATH` | no | `./data/tasks.db` | Filesystem path to the SQLite database. The MCP server also accepts the legacy `DB_PATH` as a deprecated alias. |
| `CONNECTION_TIMEOUT` | no | `120000` (ms) | Fastify `connectionTimeout`. |
| `REQUEST_TIMEOUT` | no | `60000` (ms) | Fastify `requestTimeout`. |
| `KEEP_ALIVE_TIMEOUT` | no | `10000` (ms) | Fastify `keepAliveTimeout`. |
| `WAL_CHECKPOINT_INTERVAL_MS` | no | `900000` (15 min) | Interval for the periodic SQLite WAL checkpoint job. |
| `ENABLE_SWAGGER_IN_PRODUCTION` | no | `false` | Opt-in flag to expose `/docs` and `/docs/json` when `NODE_ENV=production`. Gated by the auth plugin when enabled (task #185). |
| `SSE_MAX_CONNECTIONS_PER_KEY` | no | `4` | Per-credential (PAT) cap on concurrent SSE connections. 429 with `Retry-After` when exceeded. |
| `SSE_MAX_CONNECTIONS_PER_IP` | no | `8` | Per-IP cap on concurrent SSE connections. |
| `SSE_MAX_CONNECTIONS` | no | `200` | Global cap on concurrent SSE connections. |
| `DEVICE_FLOW_TRUSTED_HOSTS` | no | — (all hosts honored) | Optional comma-separated allowlist of hostnames the device-flow `verification_uri` may be built from (`host` or `host:port`; port ignored in match). When set, a request whose `Host`/`X-Forwarded-Host` is not on the list falls back to the configured origin. See [§3a](#3a-device-flow-verification-origin--trust-boundary). |
| `SLACK_BOT_TOKEN` | conditional | — | Slack bot token (`xoxb-…`). Required if any Slack var is set; refused alone (see [`docs/SLACK.md`](SLACK.md)). |
| `SLACK_APP_TOKEN` | conditional | — | Slack app-level token (`xapp-…`) for Socket Mode. Must be set together with `SLACK_BOT_TOKEN` or neither. |
| `SLACK_SIGNING_SECRET` | conditional | — | Slack request signing secret. Required when running Slack in HTTP mode; harmless in Socket Mode. |

### Rate limiting (validated in `src/config/env.ts`)

The global limiter keys on the authenticated principal (PAT token id, else user
id), falling back to `request.ip`; the five sensitive auth/device routes get a
tighter per-route budget. `TRUST_PROXY` (default off — see [§3a](#3a-device-flow-verification-origin--trust-boundary))
makes `request.ip` resolve from `X-Forwarded-For`; off, a spoofed header cannot
move a bucket; behind a proxy, enable it or all clients share one IP bucket.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RATE_LIMIT_MAX` | no | `1000` | Global max requests/window. `/health` is allow-listed. |
| `RATE_LIMIT_TIME_WINDOW` | no | `1 minute` | Global window string. |
| `RATE_LIMIT_AUTH_MAX` | no | `10` | Per-route max for login, callback, device/code, device/verify. |
| `RATE_LIMIT_AUTH_TIME_WINDOW` | no | `1 minute` | Window for the per-route auth limits (incl. device/token). |
| `RATE_LIMIT_DEVICE_TOKEN_MAX` | no | `30` | Per-route max for `/auth/device/token` (CLI polls it — looser). |
| `TRUST_PROXY` | no | `false` | `false`/unset = ignore forwarded headers; `true` = trust all hops; integer = trust N hops; `ip,cidr,…` = trust only those proxy IPs/CIDRs. |

### Model catalog (read directly in `src/index.ts`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | no | — | Anthropic API key for the model-catalog service's runtime model discovery (`GET https://api.anthropic.com/v1/models`), which backs `GET /api/v1/models` and the `list_models`/`resolve_model` MCP tools. When unset (or the Models API is unreachable) the catalog serves a static fallback with `stale: true` — the Configurable Task Models feature keeps working, just against the bundled model list. The key is only ever sent to the Anthropic API; it is never echoed in responses or logs. |

### CLI (read by `src/cli/config/env.ts` and individual commands)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_BASE_URL` | no | `http://localhost:3000` | Base URL for the REST API the CLI talks to. |
| `API_KEY` | yes (unless logged in) | — | A PAT (`wft_pat_…`) sent as `Authorization: Bearer <pat>`. A cached PAT from `tasks login` takes precedence; `--token` overrides both. |
| `DATABASE_PATH` | no | `./data/tasks.db` | Used by the offline CLI commands (`backup`, `doctor`, `stats`, `db-check`, `completed`) that open the SQLite database directly. |
| `NO_COLOR` | no | unset | When set (any value), suppresses ANSI colors in CLI output. |

### MCP server (read by `src/mcp/index.ts` and `src/mcp/server.ts`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_PATH` | no | `./data/tasks.db` | Path to the SQLite database opened on stdio startup. Canonical name. |
| `DB_PATH` | no | — | **Deprecated alias** for `DATABASE_PATH`. Read only when `DATABASE_PATH` is unset. Kept for backward compatibility with older `~/.claude.json` installs produced by pre-task-#217 versions of `install.sh` / `install.ps1`. |
| `API_URL` | no | `http://localhost:3000/api/v1` | Only used by the optional remote MCP transport (`src/mcp/server.ts`). |

### Remote MCP bridge (read by `src/mcp/remote/index.ts`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WFT_API_URL` | yes (remote) | — | Base URL of the REST API the remote bridge (`dist/mcp/remote/index.js`) proxies every tool call to. Written into the `wood-fired-tasks-remote` MCP entry by `wood-fired-tasks setup --remote <url>`. |
| `WFT_API_KEY` | no | — | **Optional** operator override for the bridge's Bearer token. Normally unset: the bridge reads the per-user PAT from the CLI credentials file written by `setup --remote`/`tasks login` (#810). When set, this env value takes precedence. |

> The legacy `install.sh` / `install.ps1` git-clone installers are **retired**
> (deprecation shims that delegate to `wood-fired-tasks setup`) and read **no**
> environment variables. `WOOD_FIRED_TASKS_API_KEY`, `WOOD_FIRED_TASKS_URL`,
> `--api-key`, and the `~/.config/wood-fired-tasks/api-key` cache no longer
> exist — use `wood-fired-tasks setup`.

[TIP] In production, source these from a secret manager (1Password CLI, AWS
Secrets Manager, Vault, Doppler, Infisical) — see the "Secrets" section at
the top of this guide.

## Slack Integration

See [`docs/SLACK.md`](SLACK.md) for the full Slack integration guide: app
manifest, required scopes, env vars, slash command reference (`/tasks …`),
channel subscription model, and notifier behaviour. Slack is **optional** —
the service runs without it; the three Slack env vars are validated as a
group (all three or none).

## Troubleshooting

### API returns 401 Unauthorized

Check that:
1. Your request includes an `Authorization: Bearer <pat>` header
2. The PAT value (`wft_pat_…`) is valid and has not been revoked or expired
3. You are not sending the removed `X-API-Key` header — it is rejected with 401

### CLI commands fail with connection error

Check that:
1. API server is running (`npm start` or `npm run dev`)
2. `API_BASE_URL` environment variable is set correctly
3. You are authenticated — either a cached PAT from `tasks login`, an `API_KEY`
   set to a `wft_pat_…` value, or a `--token wft_pat_…` flag

### MCP tools not working in Claude Code

Check that:
1. The installer completed successfully
2. `~/.claude.json` contains the wood-fired-tasks MCP server configuration
3. The `DATABASE_PATH` (or legacy `DB_PATH`) in the MCP config points to a valid database
4. The `command` path points to the compiled MCP server (`dist/mcp/index.js`)

[TIP] Restart Claude Code after running the installer for changes to take effect.

### Database errors

If you see database errors, try:

1. Delete the database file and run migrations again:
   ```bash
   rm ./data/tasks.db
   npm run migrate
   ```

2. Check file permissions on the database file and `data/` directory

3. Ensure only one process is writing to the database at a time

## Next Steps

- Read [API.md](API.md) for complete API reference
- Read [CLI.md](CLI.md) for complete CLI reference
- Read [MCP.md](MCP.md) for MCP tools and skill files reference
- Read [SLACK.md](SLACK.md) for the optional Slack integration (slash commands, notifier, channel subscriptions)
- Check [README.md](../README.md) for architecture overview
