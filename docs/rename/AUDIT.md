# Rename Audit — old-name occurrence inventory (#289)

**Snapshot base:** `origin/main` @ `7f75e7d`. Re-run the commands below after the
OSS-prep branch merges (the post-merge audit pass).

**Scope reminder:** private, never-published, single user → **clean break, no
aliases** (see [`README.md`](README.md)). So the classic
"replace / alias / keep-historical / defer" classification collapses: almost
everything is **replace-now**. Only two things need special handling — physical
file `git mv`s and the maintainer's live box (one-off, separate from the sweep).

## Totals

- **94 files**, **515 matches** for `wood-fired-bugs|WOOD_FIRED_BUGS`
  (excludes `package-lock.json`).
- Token families to sweep:
  - `wood-fired-bugs` (kebab) — URLs, package name, service name, install paths,
    config dir, MCP server name, prose.
  - `Wood Fired Bugs` (title-case display) — **9 src files** (Swagger title, CLI
    banners, web HTML) + ~30 docs/deploy files.
  - `WOOD_FIRED_BUGS_*` → `WOOD_FIRED_TASKS_*` — 2 vars: `_API_KEY`, `_URL`
    (installer/docs).
  - `WFB_*` → `WFT_*` — 8 vars (`WFB`=Wood Fired **B**ugs). Code reads:
    `WFB_API_KEY`, `WFB_MCP_ALLOW_BAD_PAT`, `WFB_CREDENTIALS_PATH`
    (`src/mcp/index.ts:54,56`, `src/cli/auth/credentials.ts:108`); deploy ops:
    `WFB_INSTALL_DIR`, `WFB_SERVICE_USER`, `WFB_SERVICE_NAME`, `WFB_API_URL`;
    `WFB_NODE_BIN` is name-neutral.
  - `wood_fired_bugs`, `woodFiredBugs`, `WoodFiredBugs` — **0** (no code
    identifier/type/column uses the name).

### By area

| Area | Files |   | Area | Files |
|------|-------|---|------|-------|
| `src/` | 18 | | `deploy/` | 8 |
| `skills/` | 17 | | `tests/` | 5 |
| `docs/` | 15 | | `scripts/` | 3 |
| `client-package/` | 14 | | `.github/` | 2 |
| (repo root) | 12 | | | |

### Re-run commands

```bash
git grep -EIl 'wood-fired-bugs|WOOD_FIRED_BUGS' -- . ':(exclude)package-lock.json' | wc -l
git grep -lE  'Wood Fired Bugs' -- 'src/**/*.ts' | grep -v __tests__
git grep -hoE 'WFB_[A-Z_]+|WOOD_FIRED_BUGS_[A-Z_]+' -- . ':(exclude)package-lock.json' | sort -u
git grep -nE  "\.config/wood-fired-bugs|wood-fired-bugs/(api-key|credentials)" -- .
git ls-files | grep -E 'wood-fired-bugs'
```

## Change map

### Replace-now (the whole sweep — Phase B, one pass, no aliases)

Everything below is a straight find-and-replace to the `wood-fired-tasks` /
`Wood Fired Tasks` / `WFT_*` / `WOOD_FIRED_TASKS_*` equivalent. No old-name
fallback is kept.

- **Code identity strings** — MCP server name (`src/api/server.ts:95`,
  `src/mcp/server.ts:90`, `src/mcp/remote/index.ts:73`); display name "Wood Fired
  Bugs" in `src/api/plugins/swagger.ts`, `src/api/start.ts`, `src/cli/bin/tasks.ts`,
  `src/cli/bin/tasks-client.ts`, `src/mcp/index.ts`, `src/mcp/remote/index.ts`,
  `src/mcp/remote/rest-client.ts`, `src/cli/auth/credentials.ts`, `src/web/html.ts`.
- **Code env reads** — `WFB_*`→`WFT_*` at the read sites above. Plain rename, no
  dual-read.
- **Hardcoded config dir** — `src/cli/auth/credentials.ts:116`
  `'wood-fired-bugs'` → `'wood-fired-tasks'`. (Existing local creds handled once
  by [`LOCAL-MIGRATION.md`](LOCAL-MIGRATION.md), not by code fallback.)
- **package.json + package-lock.json** — `name`, `repository`, `bugs`,
  `homepage`, lockfile root `name` (lines 2 + 8). CLI `bin` stays `tasks`
  (already neutral). #290.
- **Installers / client-package / .github** — `install.sh`, `install.ps1`,
  `.github/workflows/install-scripts.yml`, `.github/ISSUE_TEMPLATE/config.yml`,
  `client-package/*`, `WOOD_FIRED_BUGS_*` env names, secret paths. #292.
- **docs / skills / slack manifest** — all prose + `docs/SLACK.md`,
  `slack-app-manifest.yml`. Reframe per [`POSITIONING.md`](POSITIONING.md). #294.
- **OpenAPI snapshot** — regenerate `src/api/__tests__/__snapshots__/openapi-snapshot.test.ts.snap`
  after the Swagger title changes. #297.
- **CHANGELOG.md** — replace too. Nothing was ever public, so there is no
  historical record to preserve; the public should never see the old name.

### Special handling 1 — physical file `git mv` (Phase B)

| Path | → |
|------|---|
| `deploy/wood-fired-bugs.service` | `deploy/wood-fired-tasks.service` |
| `deploy/wood-fired-bugs.env.example` | `deploy/wood-fired-tasks.env.example` |

Plus the in-file defaults (`/opt/wood-fired-bugs`, `User=wood-fired-bugs`,
`WFB_INSTALL_DIR`/`WFB_SERVICE_USER` defaults) across all `deploy/*` scripts.

### Special handling 2 — maintainer's live box (Phase C, one-off)

The deployed `/opt/wood-fired-bugs` install + `~/.config/wood-fired-bugs/` are
**runtime state on one machine**, not repo content. Migrated once via
[`LOCAL-MIGRATION.md`](LOCAL-MIGRATION.md). The repo sweep changes the *defaults*
shipped for fresh installs; the runbook moves the *existing* install to match.

## Post-merge re-audit checklist

- [ ] Re-run the count commands; diff against this snapshot.
- [ ] New occurrences from OSS-prep work → fold into the same sweep.
- [ ] `git ls-files | grep wood-fired-bugs` → only the 2 `deploy/` files remain
      pre-`git mv`.
- [ ] OpenAPI snapshot regenerated; tests green.
