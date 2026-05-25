# Release Process

This document covers the pre-publication checks that gate every npm release
of `wood-fired-tasks`, plus the open-source launch checklist. Run through this
the first time you publish to npm, and again whenever a major version cuts.

See [`docs/CODE_QUALITY_ROADMAP.md`](./CODE_QUALITY_ROADMAP.md) for the full
code-quality contract and gate definitions; the "Ongoing Review Checklist"
section there is the canonical per-PR review prompts, and the PR template's
"Quality" and "Migration changes" sections mirror those gates for every PR.

## Continuous gates

These run automatically on every PR and on `main`:

| Gate                  | Workflow                                    | What it enforces                                                      |
| --------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| Tests                 | `.github/workflows/ci.yml` (`test`)         | `npm test` passes; vitest suite green                                 |
| Coverage              | `.github/workflows/ci.yml` (`coverage`)     | Coverage thresholds enforced via `vitest.config.ts`                   |
| Build                 | `.github/workflows/ci.yml` (`build`)        | `npm run build` (tsc) clean — declaration output regressions caught   |
| Lint                  | `.github/workflows/ci.yml` (`lint`)         | `npm run lint` (Biome check) clean                                    |
| Unused deps           | `.github/workflows/ci.yml` (`deps`)         | `knip --dependencies` clean                                           |
| Boundaries            | `.github/workflows/ci.yml` (`depcruise`)    | `npm run depcruise` — import boundaries + cycles clean                |
| Prod audit            | `.github/workflows/ci.yml` (`audit`)        | `npm audit --omit=dev --audit-level=high` clean (dev-dep audit advisory) |
| Install scripts       | `.github/workflows/install-scripts.yml`     | `install.sh` / `install.ps1` smoke tests across OSes                  |
| Mutation testing      | `.github/workflows/mutation.yml`            | Nightly Stryker run (advisory until break threshold reached)          |
| Benchmarks            | `.github/workflows/bench.yml`               | Nightly perf snapshot (advisory only)                                 |
| Secret scan           | `.github/workflows/secret-scan.yml`         | gitleaks full-history scan on PR + push + weekly cron                 |
| Artifact hygiene      | `.github/workflows/secret-scan.yml`         | `npm pack --dry-run` clean + no tracked env/db/pem/key files          |

## Required status checks (branch protection)

The `main` branch is protected (configured via the GitHub branch-protection
API; see wood-fired-tasks task #340). The merge button is disabled until
every check below reports success. Admin override is allowed by policy
(`enforce_admins: false`), but normal contributors cannot merge over a
failing required check.

| Required check                       | Source workflow + job                                                  |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `test`                               | `.github/workflows/ci.yml` (`test`)                                    |
| `coverage`                           | `.github/workflows/ci.yml` (`coverage`)                                |
| `build`                              | `.github/workflows/ci.yml` (`build`)                                   |
| `lint`                               | `.github/workflows/ci.yml` (`lint`)                                    |
| `deps`                               | `.github/workflows/ci.yml` (`deps`)                                    |
| `depcruise`                          | `.github/workflows/ci.yml` (`depcruise`)                               |
| `audit`                              | `.github/workflows/ci.yml` (`audit`)                                   |
| `agent-context`                      | `.github/workflows/ci.yml` (`agent-context`)                           |
| `cli-smoke-link`                     | `.github/workflows/install-scripts.yml` (#335 — version/help/no-args)  |
| `cli-surface-coverage-link (node 22)`| `.github/workflows/install-scripts.yml` (#337 — per-command --help)    |
| `cli-tarball-install`                | `.github/workflows/install-scripts.yml` (#338 — `npm pack` install)    |
| `cli-e2e`                            | `.github/workflows/install-scripts.yml` (#339 — REST round-trip)       |

`required_pull_request_reviews` is intentionally null — review enforcement
happens via CODEOWNERS + repository policy, not via the branch-protection
review-count check.

`strict: true` (require branches up to date before merging) is on so a PR
re-runs the gates against the latest `main`.

The `install-scripts.yml` workflow no longer uses a `paths:` filter
(removed in #340) so every PR triggers every required check. Otherwise a
required check that never fires (because the workflow was skipped by the
filter) would permanently block merges.

If you need to add or remove a required check, update both this table AND
the branch-protection rule via `gh api -X PUT
repos/.../branches/main/protection`. Keeping the two in sync is the
operator's responsibility — there is no automated drift detector yet.

## Pre-publish smoke test (manual)

Before `npm publish`:

```bash
npm ci
npm run quality              # Full local gate (build, test, lint,
                             # lint:deps, depcruise, prod audit)
npm run pack:check           # inspect the tarball file list
```

`npm publish` triggers the `prepublishOnly` hook automatically, which
re-runs the minimum release-safe subset (build, test, lint:deps, prod
audit, pack:check) — so the manual pre-publish smoke test above is
belt-and-braces. Lint is skipped from `prepublishOnly` because it is a
quality signal, not a release blocker. `format:check` is not a gate
today (Biome formatter is disabled in `biome.json`); see
`docs/CODE_QUALITY_ROADMAP.md` Phase 6 for the follow-up.

`npm run pack:check` is the most important manual step — it surfaces any
file accidentally added to the publish set. The tarball should contain:

- `dist/` (excluding `dist/**/__tests__/**`, `dist/**/*.test.*`,
  `dist/**/*.property.test.*`, and `dist/wood-fired-tasks-client.zip`)
- `LICENSE`
- `README.md`
- `CHANGELOG.md`
- `SECURITY.md`
- `AGENTS.md`
- `CLAUDE.md`
- `llms.txt`
- `docs/AGENT_CONTEXT.md`
- `package.json` (always included by npm)

If you see `src/`, `data/`, `.env*`, `.planning/`, test files, or anything
unexpected, fix the `files` whitelist in `package.json` before publishing.

## Migration expectations

These are release-time gates for any release that includes a new `src/db/migrations/` file. They mirror the PR-template checklist but are stated as the operator-facing contract; cross-reference Phase 5 of `docs/CODE_QUALITY_ROADMAP.md`.

- **Serialized flow.** All migrations run through Umzug with `BEGIN EXCLUSIVE`. New migrations must be registered there — never call ad-hoc `db.exec` from product code.
- **Transactionality.** Every `up` and `down` body wraps schema and data changes in `db.transaction(...)`. Pragma toggles around table rebuilds (e.g. `foreign_keys = OFF`) live inside the same transaction so a failure rolls them back.
- **Backfills.** Any backfill (`UPDATE`, `INSERT INTO ... SELECT`, `DEFAULT` on `NOT NULL` add-column) MUST be covered by a targeted test under `src/db/__tests__/migration-NNN.test.ts` that seeds pre-migration data, applies the migration, and asserts the post-state. Schema-only migrations are covered by the generic `migrations-roundtrip.test.ts` snapshot and need no per-file test.
- **Down migrations.** Default expectation is a working `down` that restores the prior schema/data contract — verified by `migrations-roundtrip.test.ts`. Forward-only migrations are allowed for one-way data transforms only; they must:
  1. Throw or no-op from `down` with a clear message, AND
  2. Call this out in the commit body, AND
  3. Add a one-line entry in this section explaining why the migration is forward-only and what operator action is required for rollback.
- **Backup / restore.** Any migration that rewrites a table (e.g. migration 005), drops a column, or executes a non-trivial backfill needs an operator note here describing the recovery procedure (typically: stop the service, restore the SQLite file from the latest backup, redeploy the previous artefact).
- **Row mapping.** New repository methods that touch nullable, date, or tag columns must funnel reads through `mapRow` / `mapRows` in `src/repositories/row-mapper.ts` (added in task #266). Direct `stmt.get(...) as RowType` casts outside that helper should be reviewed as exceptions.

Current forward-only migrations: _none._

Current backup/restore-sensitive migrations:
- **005-backlogged-status** — rebuilds the `tasks` table (rename-swap pattern). Rollback before a confirmed bug means restoring the SQLite file from the pre-deploy backup; the `down` migration is safe but rewrites the table a second time.
- **007-completed-at** — backfills `completed_at` from `updated_at` for `status='done'` rows. The backfill is irreversible in the sense that the prior NULL state is lost, but the `down` migration drops the column entirely, so rollback restores schema parity.

## Pre-Open-Source Launch Checklist

This checklist is the gate that must be clean before the repo's first
public release. Run through every item; check off as you go. Re-run for
every major version that re-opens publication eligibility (e.g. licence
swap, repo transfer, ownership change).

### Documentation / Metadata

- [ ] `LICENSE` is MIT and references the current copyright holder
- [ ] `package.json` `license` is `MIT`, has `author`, `keywords`,
      `repository`, `bugs`, `homepage`, and `files`
- [ ] `README.md` install + quickstart blocks copy-paste cleanly
- [ ] `CHANGELOG.md` `[Unreleased]` section reflects HEAD
- [ ] `SECURITY.md` supported-version table lists the current latest tag
- [ ] `CODE_OF_CONDUCT.md` and `CONTRIBUTING.md` are present and current

### Artifact hygiene

- [ ] `npm run pack:check` shows no `src/`, no `.env*`, no `data/*.db`,
      no `.planning/`, no test files
- [ ] `.env`, `.env.local`, and other local-only env files are gitignored
- [ ] `data/*.db` files are gitignored
- [ ] `.planning/`, `.claude/`, `.codex/`, `.agents/` are gitignored
- [ ] CI artifact-hygiene job (`.github/workflows/secret-scan.yml`)
      green on `main`

### Secret hygiene

- [ ] Secret-scan CI (gitleaks) green on `main` — see badge below
- [ ] Manual scan of git history with
      `gitleaks detect --source . --report-format json --no-banner`
      produces zero findings (or all findings remediated / whitelisted in
      `.gitleaks.toml`)
- [ ] No tracked secrets, API keys, internal LAN IPs, or personal
      information in the repo or its git history
- [ ] `.gitleaks.toml` allowlist entries are all justified with a
      task-ID reference comment

### Tests

- [ ] `npm test` green on `main`, including the MCP tool-count drift
      test (task #260)
- [ ] Mutation testing (`stryker`) above break threshold on the last
      nightly run
- [ ] No `test.skip` / `xit` / `it.only` markers in committed test files

## Badges

Once the repo is public, surface these on `README.md`:

```markdown
![CI](https://github.com/Wood-Fired-Games/wood-fired-tasks/actions/workflows/ci.yml/badge.svg)
![Secret Scan](https://github.com/Wood-Fired-Games/wood-fired-tasks/actions/workflows/secret-scan.yml/badge.svg)
```

## Manual gitleaks scan (one-shot)

To re-run the full-history scan locally without waiting for CI:

```bash
# Native binary (recommended; install via Homebrew / asdf / GH release)
gitleaks detect --source . --no-banner \
  --report-format json --report-path .gitleaks-report.json

# Or via Docker if gitleaks is not installed locally
docker run --rm -v "$(pwd):/scan" zricethezav/gitleaks:latest \
  detect --source=/scan --no-banner \
  --report-format json --report-path /scan/.gitleaks-report.json
```

Inspect `.gitleaks-report.json` for findings. Add justified false
positives to `.gitleaks.toml`; remediate real findings before publish.
The `.gitleaks-report.json` artifact is git-ignored (see `.gitignore`).

## Versioning and tag convention

There are two version identifiers in play, and they use **different
segment counts on purpose**. This section is the canonical reconciliation
so they never silently diverge again (the divergence that triggered this
doc: `package.json` sat at `1.0.0` while git tags had already advanced to
the `v1.x` line).

### npm package version — 3-segment SemVer

`package.json` `version` is full [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html):
`MAJOR.MINOR.PATCH`, e.g. **`1.11.0`**. All three segments are always
present. This is the version npm publishes and the version
`CHANGELOG.md` documents.

### git tag — 2-segment `vMAJOR.MINOR`

Release tags are annotated tags of the form **`vMAJOR.MINOR`**, e.g.
`v1.11`. They are *not* 3-segment. The current tag history is:

```
v1.0  v1.1  v1.2  v1.3  v1.4  v1.5
v1.6  v1.7  v1.8  v1.9  v1.10 v1.11
```

CHANGELOG release headings mirror this 2-segment form (e.g.
`## [v1.11] - 2026-05-21`).

### Reconciliation rule (keep these in sync)

> **git tag `vX.Y` corresponds to `package.json` version `X.Y.Z`** — the
> tag drops the PATCH segment, the package version always keeps it.
> Concretely, tag `v1.11` is cut from a tree whose `package.json` reads
> `1.11.0` (or a later `1.11.Z` patch). The MAJOR and MINOR of the tag
> MUST equal the MAJOR and MINOR of `package.json` at the tagged commit.

Practical consequences:

- Before tagging, confirm `package.json` `version` MAJOR.MINOR matches the
  tag you are about to cut:
  `node -p "require('./package.json').version"` → must be `X.Y.Z`
  before you run `git tag vX.Y`.
- PATCH releases (`X.Y.1`, `X.Y.2`, …) bump `package.json` but reuse /
  move forward under the same `vX.Y` tag line; if you need a distinct git
  marker for a patch, append the patch segment (`vX.Y.Z`) — but the
  default house style is 2-segment `vX.Y` to match the existing history.
- Never bump one without the other. A tag whose MAJOR.MINOR does not
  match `package.json` is the divergence this section exists to prevent.

## Release tagging

After all checklist items above are checked, and assuming you are
publishing `package.json` version `X.Y.Z` (3-segment SemVer):

```bash
# 1. Verify the package version is what you intend to release.
node -p "require('./package.json').version"   # e.g. 1.11.0

# 2. Cut the 2-segment annotated tag (MAJOR.MINOR of the version above).
git tag -a vX.Y -m "Release vX.Y"              # e.g. git tag -a v1.11 -m "Release v1.11"
git push origin vX.Y

# 3. Publish the 3-segment npm version.
npm publish
```

The npm `prepublishOnly` chain (if added later) should re-run
`npm test && npm run pack:check` as a defensive last step.
