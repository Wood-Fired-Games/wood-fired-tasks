# Release Process

This document covers the pre-publication checks that gate every npm release
of `wood-fired-bugs`, plus the open-source launch checklist. Run through this
the first time you publish to npm, and again whenever a major version cuts.

## Continuous gates

These run automatically on every PR and on `main`:

| Gate                  | Workflow                                    | What it enforces                                                      |
| --------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| Tests                 | `.github/workflows/ci.yml` (`test`)         | `npm test` passes; vitest suite green                                 |
| Coverage              | `.github/workflows/ci.yml` (`coverage`)     | Coverage thresholds enforced via `vitest.config.ts`                   |
| Unused deps           | `.github/workflows/ci.yml` (`deps`)         | `knip --dependencies` clean                                           |
| Prod audit            | `.github/workflows/ci.yml` (`audit`)        | `npm audit --omit=dev --audit-level=high` clean                       |
| Install scripts       | `.github/workflows/install-scripts.yml`     | `install.sh` / `install.ps1` smoke tests across OSes                  |
| Mutation testing      | `.github/workflows/mutation.yml`            | Nightly Stryker run (advisory until break threshold reached)          |
| Benchmarks            | `.github/workflows/bench.yml`               | Nightly perf snapshot (advisory only)                                 |
| Secret scan           | `.github/workflows/secret-scan.yml`         | gitleaks full-history scan on PR + push + weekly cron                 |
| Artifact hygiene      | `.github/workflows/secret-scan.yml`         | `npm pack --dry-run` clean + no tracked env/db/pem/key files          |

## Pre-publish smoke test (manual)

Before `npm publish`:

```bash
npm ci
npm test                     # 1300+ tests must pass
npm run lint:deps            # knip clean
npm run pack:check           # inspect the tarball file list
npm run build                # produce dist/
```

`npm run pack:check` is the most important manual step — it surfaces any
file accidentally added to the publish set. The tarball should contain:

- `dist/` (excluding `dist/wood-fired-bugs-client.zip`)
- `LICENSE`
- `README.md`
- `CHANGELOG.md`
- `SECURITY.md`
- `package.json`

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
![CI](https://github.com/Wood-Fired-Games/wood-fired-bugs/actions/workflows/ci.yml/badge.svg)
![Secret Scan](https://github.com/Wood-Fired-Games/wood-fired-bugs/actions/workflows/secret-scan.yml/badge.svg)
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

## Release tagging

After all checklist items above are checked, and assuming you are
publishing version `X.Y.Z`:

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
npm publish
```

The npm `prepublishOnly` chain (if added later) should re-run
`npm test && npm run pack:check` as a defensive last step.
