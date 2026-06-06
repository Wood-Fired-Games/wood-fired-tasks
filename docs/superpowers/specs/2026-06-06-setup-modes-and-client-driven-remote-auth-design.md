# Design: interactive `setup` modes + client-driven remote auth (v2.0)

**Date:** 2026-06-06
**Status:** Approved (brainstorming)
**Target release:** v2.0.0 (major — see Phase 0 breaking change)

## Problem

Two friction points in onboarding `wood-fired-tasks`:

1. **`setup` is mode-blind.** Bare `wood-fired-tasks setup` silently does a *local*
   install. There is no guided way to choose between a local on-demand server,
   an always-on background service, or connecting to a remote server.

2. **Remote onboarding requires manual PAT hand-off.** `setup --remote <url>`
   demands a pre-minted `--token`. Today the host operator must run
   `tasks db mint-token`, copy the secret, and transmit it to the new client by
   hand. This is tedious and error-prone.

The second point is mostly already solvable: the **OAuth 2.0 device
authorization grant (RFC 8628) is fully implemented** — `tasks login`
(`src/cli/commands/login.ts`) drives `requestDeviceCode` + `pollForToken`
(`src/cli/auth/device-flow.ts`) against the server's `/auth/device/*` routes,
and on success writes a PAT to the credentials file. A fresh client can already
self-provision a PAT with zero host minting — **when the server has OIDC
configured**. The gap is that `setup --remote` does not use it, and the two
token stores below do not talk to each other.

### The two-token-store split (root cause)

| Path | Writes token to | Read by |
|---|---|---|
| `tasks login` (device flow) | credentials TOML (`$XDG_CONFIG_HOME/wood-fired-tasks/credentials`) | the **CLI** (`tasks list`, …) |
| `setup --remote --token <pat>` | `WFT_API_KEY` env in `~/.claude.json` | the **remote MCP bridge** |

The remote MCP bridge (`src/mcp/remote/index.ts` → `resolveRemoteConfig`) reads
**only** its env vars; it never sees the credentials file `tasks login` wrote.
So device-flow login and the MCP bridge are disconnected.

## Goals

- Guided, interactive `setup` that offers Local / Service / Remote, while
  staying fully scriptable and backward-compatible for non-interactive use.
- Remote onboarding that self-provisions a PAT via the existing device flow —
  no manual host minting when OIDC is configured.
- A single token store shared by `tasks login` and the remote MCP bridge, so
  re-login rotates the bridge's token transparently and the secret no longer
  lives in `~/.claude.json`.
- Retire the deprecated X-API-Key legacy auth path, which simplifies the token
  model this design depends on.
- Ship one `tasks statusline` command (absorbing project 29) that shows the
  linked project's open/done-closed counts **and** an "update available" hint
  with an in-session update path — shared cache, one opt-in wiring, update
  check on by default and easily disabled.

## Non-goals

- No new network enrollment surface (e.g. one-time enrollment codes). For
  servers without OIDC, the fallback is manual PAT paste (host mints via
  `tasks db mint-token` against a seeded user/service account).
- No destructive DB migration. The `is_legacy` column/rows remain but become
  inert once the legacy auth strategy is removed.
- No change to the OIDC handshake, device-flow protocol, or credentials file
  format themselves — they are reused as-is.

---

## Phase 0 — Sunset the legacy X-API-Key auth path

The legacy path is already deprecated with a stated sunset of **2026-12-31**.
Removing it now is a prerequisite that collapses the token model to a single
type (`wft_pat_` PATs), which every later phase relies on.

### Server changes
- Remove the legacy strategy from the auth chain
  (`src/api/plugins/auth/strategies/legacy.ts`, wired in
  `src/api/plugins/auth/index.ts`). Chain becomes **PAT → session → 401**.
- Remove `API_KEYS` parsing/validation (`src/config/env.ts`) and the register-time
  hash precompute in the auth plugin.
- Remove the legacy-user seeding branch in `src/services/identity-seeder.ts`.
  Keep the unconditional service-account seeding (`slack-bot`, `mcp-bot`).
- Remove the RFC 8594 `Deprecation`/`Sunset` response-header logic and the
  `event: 'legacy_auth_used'` warn path.
- Keep the `is_legacy` users column and any existing rows (inert). No migration
  that drops data.

### Client changes
- `src/mcp/remote/rest-client.ts`: drop the `Bearer`-vs-`X-API-Key` branch
  (currently `rest-client.ts:177-180`). **Always** send
  `Authorization: Bearer <pat>`.
- `src/cli/auth/credentials.ts`: remove the legacy `API_KEY` env-var precedence
  in the auth resolution order.
- Remove the `--api-key` / X-API-Key user-facing surface and docs.

### Bootstrap after removal (documented, no new code)
- **OIDC on:** first device-flow login auto-creates/maps the user by `oidc_sub`.
- **OIDC off:** the host mints the first PAT against an already-seeded user or
  service account: `tasks db mint-token --user <id> --name <label>`. Document
  this in `docs/SETUP.md`.

### Migration & versioning
See the dedicated **Migration to v2.0** section below. Key point for Phase 0:
the legacy removal is **code-only** — `is_legacy` rows stay inert, so v2.0 needs
**no destructive DB migration**. The break is in *auth acceptance*, not data.

### Phase 0 acceptance
- The auth chain rejects any X-API-Key request with the standard 401.
- A server boots with no `API_KEYS` env and seeds only service accounts.
- The remote bridge sends Bearer for every request; a non-PAT key is no longer
  accepted by the server.
- build + lint + full test suite green (legacy strategy tests removed/replaced;
  no orphan references to `API_KEYS`/X-API-Key remain).

---

## Phase 1 — Interactive `setup` modes

### Mode resolution
`setup` gains three explicit, scriptable flags: `--local`, `--service`,
`--remote <url>`. Resolution order:

1. An explicit mode flag is present → use it, no prompt (scriptable; CI-safe).
2. No mode flag **and** `stdout`/`stdin` is an interactive TTY → present a
   3-item menu (Local / Service / Remote).
3. No mode flag **and** non-TTY (pipe / CI / `--json`) → **Local** (preserves
   today's exact behavior).

> Naming: the flag is `--service`, not `--system`, to avoid colliding with the
> existing `service install --system` *elevated* scope. The setup "Service"
> mode installs the **user-scoped, admin-free** service.

### New unit: `src/cli/util/prompt.ts`
A thin interactive-prompt helper over Node's built-in `readline` (no new
dependency). Exposes a small injectable seam:

- `selectFromMenu(question, choices, opts?): Promise<choiceValue>` — numbered
  single-select.
- `promptLine(question, opts?): Promise<string>` — free text (used for remote
  URL).
- `promptSecret(question): Promise<string>` — no-echo input (used for the
  manual PAT paste fallback).

The seam takes an injected `input`/`output` (default `process.stdin`/`stderr`)
so tests drive it with scripted input and assert prompts without a real TTY.
All prompt chrome goes to **stderr** (keeps stdout clean for `--json`/pipelines,
matching `login.ts`).

### Mode: Local
Unchanged — current `runSetup` (merge local stdio MCP entry + copy
skills/agents).

### Mode: Service
`runSetup` (local) **plus** install the always-on background service by reusing
the existing user-scoped backend in `src/cli/commands/service.ts`
(systemd `--user` / launchd LaunchAgent / schtasks ONLOGON — all admin-free).
No new service code; `setup --service` orchestrates `runSetup(local)` then the
existing install + enable path, then a status confirmation line.

### Mode: Remote
See Phase 2 (device-flow integration). `setup --remote <url>` belongs to the
same code path; it is described separately only because the auth wiring is the
substantive part.

### Phase 1 acceptance
- `setup --local`, `setup --service`, `setup --remote <url>` each run their mode
  without prompting.
- Bare `setup` on a TTY shows the menu and dispatches the chosen mode.
- Bare `setup` non-TTY (and `--json`) performs a Local install with no prompt
  (existing CI smoke unaffected).
- `setup --service` leaves an enabled user-scoped service; `service status`
  reports it active.
- Prompt unit tests cover menu selection, free-text, and secret input via the
  injected seam.

---

## Phase 2 — Client-driven remote auth + token-store unification

### Refactor for reuse
Extract the device-flow body currently inline in `loginCommand.action`
(`src/cli/commands/login.ts`) into a reusable
`runDeviceLogin(opts): Promise<DeviceLoginResult>` in `src/cli/auth/`. Both
`tasks login` and `setup --remote` call it. `loginCommand` becomes a thin
wrapper that maps CLI flags → `runDeviceLogin` and renders text/JSON output.

### `setup --remote <url>` flow
1. **Probe `GET /health/detailed`** to read the server's `oidc` state
   (`disabled | ready | degraded`) and branch deterministically — rather than
   attempting the device flow and catching a 501:
   - `ready`  → device-flow path (step 2).
   - `disabled` → manual-PAT path (step 3) with a clear "this server has no
     browser login" message; do not attempt the device flow.
   - `degraded` → OIDC is configured but IdP discovery is currently failing;
     inform the user, offer manual PAT now or retry later. Do not silently
     attempt the device flow (it would fail).
   - probe unreachable / non-2xx → surface a connectivity error naming the URL;
     offer manual PAT (`--token`) as the escape hatch.
2. **Device-flow login** (`ready`) via `runDeviceLogin({ baseUrl: url })`:
   browser opens, user approves, server mints `cli-<host>-<date>`, the CLI
   receives the PAT → `writeCredentials({ active: { token, server: url, … } })`.
   Zero host minting.
3. **Manual PAT** (`disabled`/`degraded`/operator choice):
   - TTY → `promptSecret("Paste a personal access token:")`.
   - non-TTY → require `--token <pat>` (error with guidance if absent).
   - The pasted token is stored via `writeCredentials` (same store).
4. Write the remote MCP entry into `~/.claude.json` carrying **only**
   `WFT_API_URL` (no baked secret). The bridge resolves the token from the
   credentials file (below).

### Token-store unification (core change)
Extend `resolveRemoteConfig` in `src/mcp/remote/index.ts` to resolve with this
precedence:

1. `WFT_API_URL` / `WFT_API_KEY` env vars (back-compat with already-baked
   `claude.json` entries; PAT values only post-Phase-0).
2. Else the credentials TOML `active.{server, token}` (what `tasks login` /
   `setup --remote` write), read via `src/cli/auth/credentials.ts`.
3. Else fail fast with the existing readable "not configured / run
   `tasks login`" error.

Effects:
- One source of truth. `tasks login` re-rotation transparently updates the
  bridge's token on next spawn — no `claude.json` edit.
- The secret no longer needs to live in `claude.json` for new remote setups.
- The credentials read enforces the existing 0600 perms check.

### Backward compatibility
- `setup --remote <url> --token <pat>` still works — it now stores to the
  credentials file; existing env-baked `claude.json` entries are still honored
  by the bridge via precedence #1 (as long as the value is a PAT).

### Security
- The auth path is the already-shipped RFC 8628 device grant: the PAT is never
  printed to stdout/stderr, the credentials file is 0600 with atomic write, and
  the server-supplied `verification_uri` is opened with `shell:false`.
- No new network surface (per the no-enrollment-code decision).
- Net reduction in secret sprawl: the PAT moves out of `claude.json` into the
  0600 credentials file for new remote setups.

### Phase 2 acceptance
- On an OIDC server, `setup --remote <url>` completes with no `--token`: it runs
  the device flow, writes credentials, and writes a `claude.json` remote entry
  containing only `WFT_API_URL`.
- On a non-OIDC server, `setup --remote <url>` falls back to manual PAT
  (prompt on TTY / `--token` otherwise) and stores it identically.
- The remote MCP bridge starts with **only** `WFT_API_URL` set, resolving the
  token from the credentials file; it still starts when `WFT_API_KEY` is set in
  env (back-compat).
- Re-running `tasks login` rotates the token the bridge uses without editing
  `claude.json`.
- Tests use the existing mock device-flow server
  (`src/cli/__tests__/helpers/device-flow-server.ts`) for the OIDC-on path and a
  stubbed 501 for the OIDC-off path.

---

## Phase 3 — Server-side OIDC enablement & `tasks doctor`

Client-driven remote onboarding *requires* the server to have OIDC enabled.
OIDC stays an **env-config** concern (no setup command mutates server config),
but v2.0 makes that state legible and verifiable.

### Server OIDC recipe (docs + boot log)
- Document the all-or-nothing env set in `docs/SETUP.md`:
  `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`,
  plus `SESSION_COOKIE_SECRET` (with a generation one-liner, e.g.
  `openssl rand -hex 32`). Note the discovery-retry vars and the `degraded`
  state semantics.
- `serve` logs the resolved OIDC state on boot (`disabled | ready | degraded`)
  so an operator sees immediately whether browser login / device flow is
  available, without curling `/health/detailed`.

### New unit: `tasks doctor`
A diagnostic command that reports actionable readiness in both contexts and is
the migration safety net:

- **Server context** (run on/against the server, or with `--server <url>`):
  - Are all OIDC_* vars set together? Is `SESSION_COOKIE_SECRET` present?
  - Read `/health/detailed` → report `oidc: ready/disabled/degraded`; for
    `degraded`, surface the discovery error so the operator can fix the IdP/URL.
  - Warn explicitly if device flow will `501` (OIDC disabled) — i.e.
    client-driven onboarding won't work until OIDC is configured.
- **Client/migration context:**
  - Detect a **legacy-shaped credential**: a `WFT_API_KEY` (env or baked in a
    `claude.json` remote entry) that does **not** start with `wft_pat_`, or an
    `API_KEYS` env present on a v2.0 server. Print exact remediation
    (`setup --remote <url>` / `tasks login` / re-mint a PAT).
  - Confirm the credentials file exists, is `0600`, and its token is a PAT.
  - Confirm the configured remote is reachable and the token authenticates
    (a probe request).

`tasks doctor` is read-only (no writes/mutations) and exits non-zero when a
blocking problem is found, so it can gate CI / pre-upgrade checks.

### Phase 3 acceptance
- `serve` boot log states the OIDC state on every start.
- `tasks doctor` against an OIDC-ready server reports `ready` and exits 0;
  against an OIDC-off server it reports `disabled` + the device-flow warning.
- `tasks doctor` detects a non-PAT `WFT_API_KEY` (env or `claude.json`) and an
  `API_KEYS` env, printing the documented remediation, and exits non-zero.
- Tests cover each `oidc` state via stubbed `/health/detailed`, and the
  legacy-credential detector via env/`claude.json` fixtures.

---

## Phase 4 — Status line: linked-project counts + update-available hint

This phase **absorbs project 29 ("Claude Code Tasks Status Line", tasks
591–601)** and the update-available hint into **one** `tasks statusline`
command. The Claude Code status line is a single command, so wood-fired-tasks
ships one cohesive line — never two competing status-line commands or caches.

### One command, two independent segments
`tasks statusline` reads Claude Code's stdin JSON and prints a single composed
line, modeled on GSD's cache→segment→slash-command pattern:

```
[ projectName  3 open / 12 done ]   ⬆ /tasks:update
        └── linked-project counts ──┘   └── update hint ──┘
```

Each segment degrades **independently** and the command always exits 0:
- unlinked project → no counts segment;
- up-to-date or disabled → no update segment;
- offline / malformed cache → that segment is omitted, never an error.

### Shared cache infrastructure (project 29 §591–592, reused by both)
- **Cache-path util (task 591):** `getCacheDir()` / `getCountCachePath(key)` and
  a sibling `getUpdateCheckPath()`, precedence `$WFT_CACHE_PATH` >
  `$XDG_CACHE_HOME/wood-fired-tasks` > `~/.cache/wood-fired-tasks`. Vendor-neutral.
- **TTL cache module (task 592):** atomic `.tmp`+`renameSync` writes, fresh/
  stale/missing reads, corrupt-file → missing (never throws). Backs **both** the
  count cache and the update-check cache.

### Linked-project counts segment (project 29 §593–596)
- **Resolver (593):** cwd→project — `.planning/config.json`
  `integrations.bugs_mirror.project_id` → `.wft/project` marker → API repo-name
  fallback → `unlinked`.
- **Count fetcher (594):** two `listTasksPaginated({project_id, status, limit:1})`
  calls (open; done/closed), reading `total`; typed failure, never throws.
- **`tasks link-project` (595):** writes the `.wft/project` marker (atomic,
  idempotent, `--json`).
- **Formatter (596):** the composed-segment renderer (counts **+** update hint),
  honoring `NO_COLOR`/`--no-color` and `COLUMNS`.

### Update-available hint segment (new — the Phase 4 addition)
- **Check engine (new `src/cli/util/update-check.ts`):** reuse `update-notifier`
  (already a dep via `self-update.ts`); its `updateNotifier({pkg}).update` gives
  `{current, latest, type}` from an async, daily-TTL'd, persisted check. The
  writer runs at a non-blocking moment (MCP boot / CLI invocation) and writes
  the update-check cache via the §592 module. Best-effort: offline/errors leave
  the prior cache untouched; skipped entirely when disabled.
- **Render:** the formatter appends `⬆ /tasks:update` (ANSI yellow) when an
  update is available **and** the feature is not disabled; pure cache read, no
  per-render network.
- **Action path (new):** a `/tasks:update` slash command (shipped into
  `~/.claude/commands/tasks/` via the existing `copySkills`) runs
  `tasks self-update`.

### Wiring + registration (project 29 §598, §600; new setup offer)
- **Register (598):** add `statuslineCommand` + `linkProjectCommand` in
  `bin/tasks.ts` (preserve the `isMain` auto-parse guard).
- **`setup` opt-in wiring (new):** `setup` offers to wire `tasks statusline`
  into `settings.json` `statusLine`. Non-clobbering: if a `statusLine` already
  exists (e.g. the user's `statusline-minimal.js`, GSD's), setup prints the
  one-line snippet to embed instead of overwriting; if none exists, it may write
  one on consent. One wiring covers **both** segments.
- **Docs (600) + agent-context (601):** document `tasks statusline`,
  `tasks link-project`, the settings.json snippet + fallback script,
  `/tasks:update`, and the disable controls; update the agent-context manifest.

### Disable (easy, layered — applies to the update segment + its check)
- config flag in the config dir (`update_check = false`),
- env var `WFT_NO_UPDATE_CHECK=1` (CI / ad-hoc),
- `setup` opt-out (re-running setup toggles it).

The counts segment has no "disable" beyond simply not linking a project (or not
wiring the status line at all).

### Phase 4 acceptance
- `tasks statusline` prints the linked-project counts segment when a project
  resolves and the update hint when an update is available; each is omitted
  independently; the command never errors and always exits 0.
- No REST call on render when the count cache is fresh; no network for the
  update segment on render (cache read only).
- `tasks link-project` writes/updates the `.wft/project` marker idempotently.
- `update_check=false` **or** `WFT_NO_UPDATE_CHECK=1` → no update segment and no
  background update check.
- `setup` offers wiring; with an existing `statusLine` it prints the snippet and
  does not clobber; with none it may write one on consent.
- `npm run agent-context:check` passes after the manifest/docs update.

---

## Migration to v2.0

Two things migrate — the schema (trivial) and auth (the real work).

### Schema — automatic, no destructive change
- `serve` runs all pending Umzug migrations **before** listening
  (`src/index.ts:128`, `serve.ts`). Restarting the upgraded server migrates the
  app-data DB automatically.
- The legacy sunset is **code-only**: `is_legacy` rows remain (inert). v2.0 adds
  **no destructive migration**; existing data is forward-compatible.

### Auth cutover — the actual migration
The moment a v2.0 server boots, X-API-Key is rejected. Sequence to avoid
lockout:

1. **Before upgrading the server**, ensure every client/integration holds a PAT:
   - interactive users: `tasks login` (OIDC) or `setup --remote <url>`;
   - service/automation: `tasks db mint-token --user <id> --name <label>` and
     update the consumer's `WFT_API_KEY` to the `wft_pat_…` value.
2. **Run `tasks doctor`** on clients/servers to surface any remaining
   legacy-shaped credentials and get exact remediation.
3. **Upgrade the server**: `npm i -g wood-fired-tasks@2` (or `tasks self-update`)
   → restart the service → migrate-on-serve runs.

### Client upgrade
- `tasks self-update` bumps the client to 2.x.
- A baked `WFT_API_KEY` that is already a `wft_pat_…` keeps working (bridge env
  precedence #1). A legacy-key value breaks → re-run **`setup --remote <url>`**
  (idempotent): it replaces the baked-key entry with a URL-only entry and stores
  a fresh PAT in the credentials file. This is the canonical client migration
  command.

### Runway
- **Straight to v2.0** (no interim v1.x hard-warning release). The
  `tasks doctor` legacy-credential detector + the existing `legacy_auth_used`
  warning + the `CHANGELOG`/`docs/SETUP.md` migration note are the guidance for
  stragglers. A hard 401 after upgrade is made actionable by `doctor`.
- `CHANGELOG.md` / `docs/SETUP.md` note: *"X-API-Key authentication has been
  removed. Re-login with `tasks login` (OIDC), re-run `setup --remote`, or
  re-mint a PAT; update any baked `WFT_API_KEY` to a `wft_pat_…` token. Run
  `tasks doctor` to check."*

---

## Components summary

| Unit | Change | Purpose |
|---|---|---|
| `src/api/plugins/auth/*`, `src/config/env.ts`, `src/services/identity-seeder.ts` | **edit (Phase 0)** | Remove legacy strategy, `API_KEYS`, legacy seeding, sunset headers |
| `src/mcp/remote/rest-client.ts` | **edit (Phase 0)** | Bearer-only |
| `src/cli/auth/credentials.ts` | **edit (Phase 0/2)** | Drop legacy `API_KEY` precedence; reused for bridge token read |
| `src/cli/util/prompt.ts` | **new (Phase 1)** | TTY prompt seam (menu / line / secret) |
| `src/cli/commands/setup.ts` | **edit (Phase 1/2)** | Mode resolution + menu + service/remote orchestration |
| `src/cli/auth/runDeviceLogin` | **new/extract (Phase 2)** | Shared device-flow core for `login` + `setup` |
| `src/cli/commands/login.ts` | **edit (Phase 2)** | Call the extracted core |
| `src/mcp/remote/index.ts` (`resolveRemoteConfig`) | **edit (Phase 2)** | Credentials-file fallback |
| `setup --remote` health probe | **new (Phase 2)** | `GET /health/detailed` → branch on `oidc` state |
| `src/cli/commands/doctor.ts` | **new (Phase 3)** | OIDC readiness + legacy-credential detector (read-only) |
| `src/cli/commands/serve.ts` | **edit (Phase 3)** | Log resolved OIDC state on boot |
| cache-path util + TTL cache (proj 29 §591/§592) | **new (Phase 4)** | Shared cache infra for count cache **and** update-check cache |
| resolver + count fetcher + `link-project` (proj 29 §593–595) | **new (Phase 4)** | cwd→project, open/done-closed counts, `.wft/project` marker |
| `formatStatuslineSegment` (proj 29 §596) | **new (Phase 4)** | Composed segment: counts + update hint; color/COLUMNS-aware |
| `src/cli/commands/statusline.ts` (proj 29 §597) | **new (Phase 4)** | One `tasks statusline`: stdin→resolve→counts+update hint; exit 0 |
| `src/cli/util/update-check.ts` | **new (Phase 4)** | Cached `update-notifier` check → update-check cache (fail-silent) |
| `skills/tasks/update.md` (`/tasks:update`) | **new (Phase 4)** | In-session update slash command → `self-update` |
| `bin/tasks.ts` register (proj 29 §598) | **edit (Phase 4)** | Register `statusline` + `link-project` (isMain guard intact) |
| `setup.ts` (statusline wiring) | **edit (Phase 4)** | Opt-in offer to wire `tasks statusline`; opt-out; non-clobbering |
| `docs/CLI.md` + agent-context (proj 29 §600/§601) | **edit (Phase 4)** | statusline/link-project docs, snippet, `/tasks:update`, disable; manifest |
| `src/cli/commands/service.ts` | **reuse** | User-scoped service install for Service mode |
| `docs/SETUP.md`, `CHANGELOG.md` | **edit** | OIDC server recipe + v2.0 migration note + no-OIDC bootstrap + update-hint docs |

## Testing strategy

- **Phase 0:** auth-chain tests assert X-API-Key → 401; seeder test asserts
  service-accounts-only with no `API_KEYS`; rest-client test asserts Bearer for
  all keys; grep-guard that no `API_KEYS`/X-API-Key references remain.
- **Phase 1:** prompt seam unit tests (menu/line/secret via injected IO); setup
  mode-resolution tests (each flag; TTY menu dispatch with injected prompt;
  non-TTY → Local); service-mode orchestration asserts the install path is
  invoked.
- **Phase 2:** `/health/detailed` probe branch (stubbed `ready`/`disabled`/
  `degraded`/unreachable → correct path); device-flow integration via the
  existing mock server (OIDC-on → credentials written + URL-only `claude.json`
  entry); manual-paste fallback; `resolveRemoteConfig` precedence
  (env → file → fail); re-login rotation reflected by the bridge.
- **Phase 3:** `tasks doctor` per `oidc` state (stubbed `/health/detailed`);
  legacy-credential detector via env + `claude.json` fixtures (non-PAT
  `WFT_API_KEY`, `API_KEYS` present) asserts remediation text + non-zero exit;
  `serve` boot-log states OIDC state.
- **Phase 4:** cache-path precedence (§591) + TTL fresh/stale/missing/corrupt
  (§592); resolver per source + unlinked (§593); count fetcher status filters +
  summed totals (§594); `link-project` marker write (§595); formatter composed
  render — counts and update hint, colored/no-color/COLUMNS, each segment
  independently omitted (§596); `tasks statusline` subprocess test (§599:
  linked segment, blank-when-unlinked, fresh-cache no-API, server-down graceful,
  all exit 0); update-check writer via mocked `update-notifier` (writes on
  available; skips when disabled-by-flag/env); update segment shown/omitted on
  flag+env; setup wiring (no `statusLine` → write on consent; existing →
  snippet, no clobber); `agent-context:check` green.
- All phases: `npm run build` + `npm run lint` + full `vitest` suite green.

## Open risks

- **Upgrade breakage** for any remaining X-API-Key users — mitigated by the v2.0
  major bump, the `tasks doctor` legacy-credential detector, and an explicit
  migration note. (Confirm no first-party deployment still relies on X-API-Key
  before release — `tasks doctor` against each is the check.)
- **Bridge spawned in a context without the credentials file** (e.g. a service
  account running as a different user) — env precedence #1 remains the escape
  hatch; documented.
