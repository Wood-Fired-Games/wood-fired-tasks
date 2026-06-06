# Single-command distribution for wood-fired-tasks — design spec

**Status:** Approved design, ready for `/tasks:decompose`
**Project:** wood-fired-tasks tasks project **#36** — "Frictionless Distribution (npm single-command)"
**Date:** 2026-06-05
**Owner:** Repository maintainers
**Decompose target:** run `/tasks:decompose docs/superpowers/specs/2026-06-05-single-command-distribution-design.md 36` to materialize the task DAG into project 36.

---

## 1. Goal

A user — or an agent (Claude Code / Codex) acting as that user — can install, configure,
update, and run **everything** wood-fired-tasks offers (CLI, API server, MCP server, and
the Claude Code skills) from **one npm command, with no git clone and no admin
privileges**, working identically on Windows, Linux, and macOS. An optional flag points
all client surfaces at a shared remote server instead of running locally.

The target experience:

```
# Server host
npm i -g wood-fired-tasks   →  wood-fired-tasks serve          # auto-migrates; DB in OS app-data

# Any agent/client machine (Win/Linux/Mac, identical, no admin)
npm i -g wood-fired-tasks   →  wood-fired-tasks setup --remote https://tasks.example.com --token wft_pat_…

# Local all-in-one
npm i -g wood-fired-tasks   →  wood-fired-tasks setup && wood-fired-tasks serve

# Update anywhere, one command
wood-fired-tasks update

# Guaranteed zero-install / zero-admin bootstrap
npx wood-fired-tasks setup --remote …
```

## 2. Success criteria (measurable, goal-backward)

1. From a machine with **only Node ≥22 and the published package** (no repo clone), `npm i -g
   wood-fired-tasks` then `wood-fired-tasks setup` results in working `/tasks:*` slash commands
   and MCP tools in Claude Code — verified by an automated global-install smoke test run from a
   directory **outside** the repo.
2. `wood-fired-tasks setup --remote <url> --token <pat>` writes a correct
   `wood-fired-tasks-remote` entry to `~/.claude.json` and copies the skills, on all three OSes.
3. `wood-fired-tasks serve` boots the API, auto-runs migrations into an **OS-app-data** database
   path (no cwd dependence), and answers `/health` 200 — when launched from any working directory.
4. The entire install → setup → update → serve → user-scoped autostart path completes with **no
   `sudo` and no elevation prompt**. Elevation is requested **only** by `service install --system`.
5. `npx wood-fired-tasks <cmd>` resolves a bin (the package-name bin alias exists).
6. Skills ship **inside the npm tarball** from a single canonical source; `client-package/` and
   its zip builder are gone; `npm pack --dry-run` + `publint` show the skills present and no test
   files / sourcemaps / stray artifacts.
7. `wood-fired-tasks update` upgrades the global install and the next `serve` migrates the schema;
   the update never corrupts a running server (Windows file-lock safe).
8. All new behavior is covered by tests, including a **win/mac/linux CI matrix** exercising
   `setup` and `serve` from the packed tarball.

## 3. Locked decisions

- **Distribution-only.** The real-time board GUI is **out of scope** for this work — its own
  later spec. This plan must not build UI, and need not add UI-serving hooks.
- **Single unified package.** One `wood-fired-tasks` package serves every role (server host,
  remote client, CLI, MCP, skills). The separate `client-package/` thin-client + zip builder are
  **retired/deleted**.
- **Admin-free by default.** Install / setup / update / serve / autostart all work with zero
  privilege. Only `service install --system` needs elevation.
- **No side-effecting `postinstall`.** Setup is an explicit command (`wood-fired-tasks setup`),
  because `--ignore-scripts` and pnpm v10 skip postinstall and it is a discouraged supply-chain
  pattern. `postinstall` may at most print a one-line "run `wood-fired-tasks setup`" notice.
- **Bins:** keep `tasks`; add `wood-fired-tasks` (canonical, required for `npx wood-fired-tasks`)
  and a short `wft` alias. All resolve to the same Commander program.
- **Native dep:** keep `better-sqlite3` now (prebuilds cover Win/Mac/Linux incl. arm64/musl on
  Node 22–26); isolate DB access behind one seam so a later swap to Node's built-in `node:sqlite`
  (removing the native dep) is a one-module change. The swap itself is out of scope here.
- **Shell installers:** `install.sh` / `install.ps1` become **thin deprecation shims** that call
  `wood-fired-tasks setup` and warn; scheduled for removal one minor later.

## 4. Current state (what exists vs. what's missing)

Verified against the repo:

- `package.json` `files` ships `dist/` + `packages/wft-router/dist/` + docs, but **omits
  `skills/`** — this is the root reason users must clone today (`install.sh` copies skills from
  the cloned `skills/tasks/`).
- Bins are only `tasks` → `dist/cli/bin/tasks.js` and `wft-router`. **No `wood-fired-tasks` bin**,
  so `npx wood-fired-tasks` cannot resolve.
- **No `serve` / `mcp` / `setup` / `update` / `service` subcommands.** The API server is reachable
  only via `npm start` (`node dist/api/start.js`) and the MCP server via `npm run mcp:start`,
  both assuming a clone.
- Install logic lives in **bash (`install.sh`) and PowerShell (`install.ps1`)** — not shipped in
  the package, and a third copy of setup logic lives under `client-package/` (`setup.sh/.ps1/.bat`)
  → a known **dual-source drift trap** for the skills.
- `DATABASE_PATH` defaults to **`./data/tasks.db` (cwd-relative)** in `src/config/env.ts`; there is
  **no OS-app-data logic** (no `env-paths`, no XDG/APPDATA/~Library handling).
- The **remote MCP bridge** (`src/mcp/remote/index.ts`) is **pure HTTP** — it does not import
  `better-sqlite3`.
- Migrations already run automatically on server start (Umzug), and `~/.claude.json` MCP entry
  shapes (`wood-fired-tasks`, `wood-fired-tasks-remote`) are established — both reused as-is.

## 5. Components / work breakdown

Each item is a self-contained unit with its own acceptance criteria. Dependency hints (→) are
provided so decompose can build a DAG; they are guidance, not hard constraints.

### C1. Packaging foundation (bins + files + engines)
- Add `wood-fired-tasks` and `wft` bins (both → the existing CLI entry).
- Add the canonical skills output dir and any new asset dirs to `files`; confirm they are **not**
  caught by the `!dist/**/__tests__` / `*.test.*` excludes.
- Tighten `engines.node` guidance toward even-LTS; emit a runtime warning on odd/current Node.
- **Acceptance:** `npm pack --dry-run` lists the new bins' targets and the skills; `npx
  wood-fired-tasks --help` works from the packed tarball; `publint` clean.

### C2. Package-relative asset resolver
- One module that resolves bundled assets (skills, migrations, env example, service-unit
  templates) via `new URL(..., import.meta.url)` + `fileURLToPath` — never `process.cwd()`.
- All package-relative reads in `serve`/`mcp`/`setup`/migrations route through it.
- **Acceptance:** running the global bin from `/tmp` (outside the repo) resolves every asset; a
  unit test asserts resolution independent of cwd. → depends on C1.

### C3. OS-app-data path resolver
- Central module using `env-paths('wood-fired-tasks')` for the default DB path (data dir) and the
  PAT/config cache (config dir); preserve the `DATABASE_PATH` env override; create dirs with
  `mkdir -p`. `~/.claude` paths derive from `os.homedir()`, not env-paths.
- Default the server/MCP/offline-CLI DB path to the data dir when `DATABASE_PATH` is unset.
- **Acceptance:** with no env set, `serve` opens a DB under the OS data dir on each platform;
  `DATABASE_PATH` still overrides; unit tests cover all three OS branches. → depends on C2.

### C4. DB access seam
- Ensure all `better-sqlite3` usage is funneled through one module/interface so a future
  `node:sqlite` swap is localized. (Audit + light refactor only; no behavior change.)
- **Acceptance:** a single import site for the driver; a documented seam; tests still green.

### C5. CLI lifecycle commands — `serve` and `mcp`
- `serve`: start the API server foreground; migrate-on-start; resolve DB from C3; `--port/--host/--db`.
- `mcp`: start the local stdio MCP server (debug/manual path; Claude Code itself spawns it via the
  config `setup` writes).
- **Acceptance:** `wood-fired-tasks serve` from any cwd boots + `/health` 200 + migrates into the
  app-data DB; `wood-fired-tasks mcp` speaks stdio MCP. → depends on C2, C3.

### C6. Skill packaging (single canonical source)
- Build step pre-processes the single source `skills/tasks/*.md` (strip dev-only relative links,
  as the old client-package step did) into a shipped dir (e.g. `dist/skills/tasks/`); include in
  `files`. Carry over the agents/ skills if present.
- **Acceptance:** the processed skills are in the tarball, link-clean; one source of truth; a test
  asserts parity between source and shipped set. → depends on C1.

### C7. `setup` command (the installer, cross-platform Node)
- Replace `install.sh`/`install.ps1`/`client-package` setup with one Node implementation:
  - Modes: **local** (default) writes the `wood-fired-tasks` MCP entry; **`--remote <url>
    [--token <pat>]`** writes `wood-fired-tasks-remote` with `WFT_API_URL`/`WFT_API_KEY`.
  - **Atomic, idempotent merge** into `~/.claude.json`: read+parse (missing ⇒ `{}`), deep-merge
    only our keys, write to a temp file in the same dir, `fs.rename` over original, keep `.bak`;
    retry on Windows `EPERM`.
  - Copy skills from the shipped dir (C6) into `~/.claude/commands/tasks/` (+ agents).
  - Cache the PAT to the OS config dir (C3) with tight perms (0600 / user-only ACL).
  - `--fix-npm-prefix` helper: configure a user-writable npm global prefix (admin-free), for hosts
    whose Node global prefix is root-owned.
- **Acceptance:** idempotent re-run = no dupes; local and `--remote` both produce correct
  `~/.claude.json` + skills on all three OSes; never writes outside `$HOME`; covered by unit tests
  (merge/missing/concurrent/EPERM) and the cross-OS smoke. → depends on C2, C3, C6.

### C8. `update` command
- `wood-fired-tasks update`: spawn `npm i -g wood-fired-tasks@latest`, then **exit** (never
  self-update from inside a running `serve`; Windows lock-safe); print a "restart `serve`" hint;
  schema migrates on next `serve` (already migrate-on-start via C5).
- On `EACCES` (root-owned global prefix): emit user-prefix / `npx` / version-manager remediation;
  **never** suggest `sudo`.
- Optional: `update-notifier` nudge in the CLI, respecting `CI` / `NO_UPDATE_NOTIFIER`.
- **Acceptance:** `update` upgrades in a user-space global prefix without elevation; EACCES path
  prints the no-sudo remediation; nudge silent in CI. → depends on C5.

### C9. `service` command (admin-free by default, `--system` opt-in)
- `service install|uninstall|status`. **User-scoped default (no admin):** systemd `--user` unit
  (+ `loginctl enable-linger` where policy allows, else start-at-login) on Linux; `launchd`
  LaunchAgent in `~/Library/LaunchAgents` on macOS; per-user Scheduled-Task-at-logon (or Startup
  shortcut) on Windows. `--system` opt-in generates the privileged variant (system systemd unit /
  Windows Service) and runs it only with explicit `--yes` + elevation, else prints the command.
- Unit/plist/task templates resolved via C2.
- **Acceptance:** `service install` (no flag) sets up reboot/login autostart with **no elevation**
  on each OS; `--system` is the only elevation path; generated artifacts validated by unit tests
  per OS. → depends on C5, C2.

### C10. Retire `client-package/` + zip builder
- Delete `client-package/` and `scripts/build-client-package.sh`; remove the
  `!dist/wood-fired-tasks-client.zip` files-exclude; convert `install.sh`/`install.ps1` to thin
  shims that call `wood-fired-tasks setup` and print a deprecation notice; CHANGELOG note.
- **Acceptance:** repo builds and packs without the client-package artifacts; the shims forward to
  `setup`; no remaining references to the deleted paths (grep clean). → depends on C7.

### C11. Cross-platform CI smoke matrix
- Repurpose the existing `install-scripts` workflow into a **win/mac/linux** job that: `npm pack`
  → install the tarball into a temp prefix → run `wood-fired-tasks` from outside the repo →
  `setup` into a temp `HOME` (assert merged `~/.claude.json` + skills + idempotent re-run) →
  `serve` boots + `/health` + migrates into a temp app-data dir → `setup --remote` writes the
  remote entry. Add a local `npm run smoke:global` mirroring it.
- **Acceptance:** the matrix is green on all three runners and gates the release. → depends on C5,
  C7 (and ideally C9 user-scoped path).

### C12. Documentation rewrite
- Rewrite README "Quick Start" + `docs/SETUP.md` (Claude Code Integration, Multi-OS client fleet,
  Self-hosting) for the **no-clone** flow: `npm i -g` / `npx`, `setup [--remote]`, `serve`,
  `update`, `service install`, and the admin-free guarantee (with the EACCES/no-sudo remediation
  and the `npx` fallback). Update `docs/USAGE_PATTERNS.md` install references. Keep the advanced
  `deploy/` operator path documented.
- **Acceptance:** docs describe only the no-clone path as primary; `npm run agent-context:check`
  passes (budgets adjusted as needed); every documented command exists. → depends on C5, C7, C8, C9.

## 6. Backward-compat & migration

- The clone-based dev flow (`npm start`, `npm run dev`, `npm run cli`) keeps working unchanged.
- `~/.claude.json` entry **shapes are unchanged**, so existing installs keep working and `setup` is
  idempotent over them.
- `install.sh` / `install.ps1` survive one minor as shims (C10); `client-package/` is removed now
  (internal tooling, not a published surface).
- No database schema change is required by this work beyond the existing migrate-on-start.

## 7. Testing strategy

- **Unit:** asset resolver (cwd-independence), env-paths defaults per OS, atomic JSON merge
  (missing/existing/concurrent/EPERM), skill copy+transform & source/ship parity, `update` EACCES
  branch, per-OS service-unit generation.
- **Integration / smoke:** the packed-tarball global-install smoke (C11) on a cross-OS matrix —
  the headline regression guard for "works from a fresh machine."
- Keep the existing suite green (`npm run quality`).

## 8. Risks & mitigations

- **Windows self-update file-lock** → `update` spawns npm then exits; never updates a running `serve`.
- **Concurrent `~/.claude.json` write** while Claude Code is open → temp-file + atomic `rename`,
  EPERM retry, `.bak`.
- **Root-owned global prefix (EACCES)** → no-sudo remediation + `--fix-npm-prefix` + `npx` path.
- **Native dep on odd/current Node** → even-LTS engines guidance, clear error + `npm rebuild` hint;
  DB seam (C4) keeps the `node:sqlite` exit open.
- **Tarball bloat / wrong contents** → `npm pack --dry-run` + `publint` gate in CI.
- **enable-linger requires privilege on some distros** → fall back to start-at-login and say so.

## 9. Out of scope (explicit)

- The real-time board GUI and any `dist/ui` / static-serving work.
- The actual migration from `better-sqlite3` to `node:sqlite` (only the seam is in scope).
- Per-project RBAC / multi-tenant auth (unchanged; see SECURITY.md).
- Publishing/release mechanics changes beyond what the CI smoke matrix requires.

## 10. Suggested decompose shape

Natural DAG roots: **C1** (packaging foundation) and **C2** (asset resolver). **C3→C5** form the
runtime spine; **C6→C7** the install spine; **C8/C9** hang off C5; **C10** off C7; **C11** off
C5+C7; **C12** off the command set. Expect ~14–20 leaf tasks. This is DAG-topology work — drain
with `/tasks:loop-dag` after decompose.

## Addendum A — Documentation accessibility for npm-only users (2026-06-05)

**Gap found (reviewing materialized tasks 729–747).** The plan ships the *skills* in the tarball
(task 735) and rewrites doc *content* for the no-clone flow (task 747), but it does **not** make
the repo's illustrative guides reachable by someone who only ran `npm install`. The `files`
allowlist ships only `README.md` + a few root policy docs + `docs/AGENT_CONTEXT.md`, and there is
no command to surface bundled docs — so `docs/USAGE_PATTERNS.md`, `SETUP.md`, `CLI.md`, `API.md`,
`MCP.md`, `WORKFLOWS.md`, `INTERFACES.md`, `NAVIGATION.md`, etc. are invisible to an npm-only /
remote-client install. The gap is entirely uncovered by the existing tasks.

**Fix — 3 added tasks (project 36, tagged `decomp-73f4915c…` + `docs-access`):**

- **DA1 — Ship curated user-facing docs in the tarball.** Add the user-facing guide set to
  `package.json` `files`: `docs/{README,NAVIGATION,SETUP,CLI,API,MCP,INTERFACES,USAGE_PATTERNS,
  WORKFLOWS,SLACK,RELIABILITY,TROUBLESHOOTING,ARCHITECTURE}.md`. Exclude internal/dev/design docs
  (REPO_MAP, AGENT_READINESS_AUDIT, CODE_QUALITY_ROADMAP, `*-design.md`, retrospectives/,
  superpowers/, hooks/, loop-run-*). Sequenced after the other `files`-editing tasks (729, 735)
  to avoid `package.json` merge conflicts.
- **DA2 — `wood-fired-tasks docs` CLI subcommand.** `docs list` (enumerate bundled guides),
  `docs show <name>` (print to stdout), `docs path [<name>]` (print on-disk path), `docs open
  <name>` (open in the default viewer/browser — cross-platform, admin-free). Resolves bundled
  docs via the `import.meta.url` asset resolver (task 730) so it works from a global install and
  for remote-only clients with no server running.
- **DA3 — Assert docs accessibility in pack-hygiene + smoke.** Extend the tarball-hygiene
  assertions (task 744) to require the curated guides present and internal docs absent, and
  extend `smoke:global` (745) + the cross-OS CI matrix (746) to assert `wood-fired-tasks docs
  list` and `docs show usage-patterns` work from the installed package outside the repo.

The no-clone docs rewrite (task 747) gains a dependency on DA2 so it documents the `docs`
command. **Out of scope** (consistent with the GUI deferral): serving a docs index from the
running server or any web docs UI — the CLI `docs` command is the offline access path.

## Addendum B — Installer-parity coverage gaps (2026-06-05)

**Audit (tasks 729–750 vs the plan + the live `install.sh`/`install.ps1`).** Cross-walk: every
component C1–C12 and DA1–DA3 and all five success criteria map to ≥1 task. Comparing the new
`setup`/packaging tasks against what the shell installers actually do surfaced two material gaps
plus minor ones:

- **G1 (material) — subagent definitions not shipped/installed.** `install.sh` also copies
  `skills/agents/*.md` (`tasks-verifier`, `integration-auditor`, excluding README) into
  `~/.claude/agents/`; these back the **mandatory verifier in `/tasks:loop[-dag]`**. Tasks 735
  (ship) and 737 (setup-copy) only handle `skills/tasks`, so npm-only users would lose the
  subagents and the loops' verification step.
- **G2 (material) — setup's MCP entry must resolve to the installed package.** The shell
  installers write a `dist/mcp/index.js` command that assumes a clone/cwd; the Node `setup` must
  write an entry whose command/args resolve to the globally-installed package entrypoint
  (absolute, via the asset resolver, or the `wood-fired-tasks mcp` bin) or Claude Code cannot
  spawn it.
- **Minor:** runtime warning on non-even-LTS / current Node (C1 — only `engines>=22` is in 729);
  `0600` / user-only-ACL perms on `~/.claude.json` + the cached PAT secret (install.sh does this);
  the optional one-line postinstall "run setup" notice; optional `setup --remote` reachability check.

**Fix — 2 added tasks (project 36, tagged `decomp-73f4915c…` + `installer-parity`):**
- **GB1 — Ship + install `skills/agents/` subagent definitions.** Build-process `skills/agents/*.md`
  into the tarball and have `setup` install them to `~/.claude/agents/` (idempotent, resolver-based),
  with a smoke assertion. Depends on the asset resolver (730), skill build (735), setup (737).
- **GB2 — Installer-parity hardening.** setup's MCP entry resolves to the installed package; tighten
  `~/.claude.json` + PAT-secret perms (0600 / user-only ACL); warn on odd/current Node; one-line
  postinstall notice (no side effects); optional `--remote` reachability check. Depends on 729, 737, 738.
