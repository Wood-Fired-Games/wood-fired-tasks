# Releasing wood-fired-tasks — verified runbook

<!-- Point-in-time verification report for WFT #2369. Every statement below
     was checked on 2026-11-23 against main at e029aee (v2.9.0), the live npm
     registry, the GitHub API and the Ubuntu-Desktop install. -->

| | |
| --- | --- |
| Tracker | WFT #2369 |
| Verified | 2026-11-23, `main` at `e029aee` (tag `v2.9.0`) |
| Relation to `docs/RELEASE.md` | That file already exists and is **left unchanged**. This is a new, separate document. Where the two disagree, section 7 lists the difference and the evidence. Once accepted, the corrections belong in `docs/RELEASE.md`. |

How each fact was checked: the workflow and script files in this repository;
`npm view wood-fired-tasks`; `gh api` for branch protection, runs and
releases; and `systemctl status`, `tasks --version`, `/health` on the host.
Nothing was published, tagged, restarted or written to the live database.

## 1. What a release is

One npm package, `wood-fired-tasks`, on `https://registry.npmjs.org`. It
carries everything:

| Inside the tarball | How it reaches a user |
| --- | --- |
| CLI — bins `wood-fired-tasks`, `wft`, `tasks` | `npm i -g wood-fired-tasks` |
| REST server (`dist/api/start.js`), stdio MCP (`dist/mcp/index.js`), remote MCP bridge (`dist/mcp/remote/index.js`) | same package |
| `wft-router` — fourth bin, from the private sub-package `packages/wft-router` | same package. It reports its own version (`2.0.0` today), not the package version. |
| Skills and agents (`dist/skills/`) | copied into `~/.claude` or the Codex skills directory by `wood-fired-tasks setup` and `self-update` |

There is no other channel:

- **No plugin marketplace** entry exists in the repository.
- **No container image is published.** CI job `oci-build` builds
  `packages/wft-router/Containerfile` with `push: false`.
- **`install.sh` / `install.ps1`** at the repository root are deprecation
  stubs that point at `npm i -g wood-fired-tasks && wood-fired-tasks setup`.
- **GitHub Releases** are created by hand (section 2, step 7). No workflow
  creates them, and `v2.5.0` has a tag and an npm version but no release.

## 2. The release path

| # | Step | Who can do it |
| --- | --- | --- |
| 1 | Branch `chore/release-vX.Y.Z` from current `main`. | Bot |
| 2 | Bump: `npm version X.Y.Z --no-git-tag-version` (edits `package.json` and `package-lock.json`). | Bot |
| 3 | `CHANGELOG.md`: move `[Unreleased]` content under `## [X.Y.Z] - YYYY-MM-DD`, grouped `Added` / `Changed` / `Fixed` / `Security`, with `Upgrade notes` first when an operator must act. `SECURITY.md`: update the supported-versions table. Then `npm run agent-context:gen`, because `SECURITY.md` is hashed in `.agent-context.json`. | Bot |
| 4 | Pull request. All 12 required checks must pass (section 3). Merge with a merge commit. | Bot opens; merge needs push rights on `main` |
| 5 | Tag the merge commit and push the tag: `git tag vX.Y.Z <merge-sha> && git push origin vX.Y.Z`. | **Needs GitHub push rights** |
| 6 | The tag push starts `.github/workflows/publish.yml`, which publishes to npm (section 4). Confirm with `npm view wood-fired-tasks version`; the registry can lag a minute or two. | Automatic |
| 7 | `gh release create vX.Y.Z --latest --title vX.Y.Z --notes "<changelog section>"`. | **Needs GitHub push rights** |
| 8 | Upgrade the Ubuntu-Desktop install (section 5). | **Needs sudo** for the server |

The v2.9.0 release-prep commit (`e8fb6d8`) touched exactly five files:
`package.json`, `package-lock.json`, `CHANGELOG.md`, `SECURITY.md`,
`.agent-context.json`. That is the normal footprint.

Version rule: the tag is `v` + the `version` field in `package.json` at the
tagged commit, three segments. **Nothing enforces this.** The workflow
publishes whatever `package.json` says, whatever the tag is called.

## 3. CI gates

Branch protection on `main`, read from the GitHub API:

- `strict: true` — the branch must be up to date with `main`.
- `enforce_admins: true` — administrators cannot bypass the checks.
- No required reviews.
- No rulesets and no tag protection: anyone with push rights can create or
  move a `v*` tag.

The 12 required checks:

| Check | Workflow |
| --- | --- |
| `test`, `coverage`, `deps`, `depcruise`, `lint`, `build`, `audit`, `agent-context` | `.github/workflows/ci.yml` |
| `cli-smoke-link`, `cli-surface-coverage-link (node 22)`, `cli-tarball-install`, `cli-e2e` | `.github/workflows/install-scripts.yml` |

Other jobs run on every pull request but are not required: `complexity`,
`vendor-neutrality`, `pack-smoke`, `oci-build`, `host-manifests`, the
shellcheck and installer smoke jobs, `global-install-smoke`, and the
`gitleaks` and artifact-hygiene jobs in `secret-scan.yml`. Mutation testing
and benchmarks are nightly.

Every CI `npm ci` runs as `npx --yes npm@11.21.1 ci`, because older npm
compiles `better-sqlite3` from source (npm/cli#9837).

**The `audit` gate goes red by itself.** It runs
`npm audit --omit=dev --audit-level=high` against the live advisory database,
so a new advisory in a production dependency fails every open pull request
and, through `prepublishOnly`, every publish, with no change in this
repository. This is the state on 2026-11-23: `body-parser` 2.3.0, pulled in
by `@modelcontextprotocol/sdk` through `express`, has high-severity advisory
GHSA-27r3-jxmh-p828. `main` last ran CI on 2026-10-21 and was green then.
The remedy is a lockfile update (`npm audit fix`, which moves `body-parser`
to a patched release inside the range `express` already allows) in its own
pull request. No release can be published until that is merged.

## 4. npm publish

`.github/workflows/publish.yml`:

| Property | Value |
| --- | --- |
| Trigger | Push of a tag matching `v*`, or manual `workflow_dispatch` |
| Runner | `ubuntu-latest`, Node 22, then `npm install -g npm@11` (npm 12.0.0 breaks provenance) |
| Steps | `npm ci`, then `npm publish` |
| Gate inside publish | `prepublishOnly`: build, test, `lint:deps`, `npm audit --omit=dev --audit-level=high`, `pack:check` |
| Credential | **None stored.** The job has `id-token: write`; npm exchanges the GitHub OIDC token for a short-lived publish credential (Trusted Publishing). There is no `NPM_TOKEN` secret. |
| Provenance | Attached automatically. `npm view wood-fired-tasks@2.9.0 dist.attestations` returns an SLSA v1 provenance record. |

Who holds what:

- The **trusted-publisher binding** lives in the package settings on
  npmjs.com (organisation `Wood-Fired-Games`, repository `wood-fired-tasks`,
  workflow `publish.yml`). It can only be seen or changed by the npm
  maintainer, `stuartjeff`, the sole maintainer listed by `npm view`. It was
  not inspected directly; the four successful runs (v2.6.0 – v2.9.0) show it
  works.
- The only thing a releaser needs is the right to **push a tag** to the
  GitHub repository.

Hazards:

- **A manual `workflow_dispatch` publishes the selected ref** at its
  `package.json` version, with no tag check.
- **A failed publish after the tag is pushed** is fixed by merging the fix to
  `main`, then deleting and re-creating the tag at the new `main` head so the
  fixed workflow runs. This is safe only while that version is not on npm; a
  published version can never be re-used.
- Tags to date are lightweight, not annotated.

## 5. Upgrading the Ubuntu-Desktop install

### 5.1 What is installed, as observed

| Surface | Where it runs from | Version | Updated by |
| --- | --- | --- | --- |
| REST server | systemd system unit `wood-fired-tasks`, `ExecStart=/home/stuart/.nvm/versions/node/v22.22.0/bin/node /opt/wood-fired-tasks/dist/api/start.js`, `User=stuart`, `EnvironmentFile=/opt/wood-fired-tasks/.env`, listening on `localhost:3000` | 2.8.0 | `deploy/upgrade.sh` from a built checkout |
| Database | `/opt/wood-fired-tasks/data/tasks.db` (SQLite, WAL) | — | migrations, run by `upgrade.sh` and again at server start |
| Remote MCP (`wft-mcp`) | `~/.local/bin/wft-mcp`, a launcher that runs `/opt/wood-fired-tasks/dist/mcp/remote/index.js` | follows the server files | the server upgrade; each running agent session keeps the old code until it reconnects |
| CLI (`tasks`, `wft`, `wood-fired-tasks`) | global npm install under prefix `~/.local` | 2.8.0 | `tasks self-update` |
| `wft-router` | systemd **user** unit `wft-router`, `ExecStart=/usr/bin/node ~/.local/lib/node_modules/wood-fired-tasks/packages/wft-router/dist/bin/wft-router.js` | follows the CLI files | the CLI upgrade, then `systemctl --user restart wft-router` |
| Skills and agents | `~/.claude/commands/tasks/`, `~/.claude/agents/` | follows the CLI | `tasks self-update` re-copies them |

The installed unit is not the one in `deploy/wood-fired-tasks.service`: it
runs as `stuart` with the nvm Node, and has a drop-in `override.conf` adding
`After=network-online.target`. `/opt/wood-fired-tasks` is owned by `stuart`.

### 5.2 CLI, router and skills — no sudo

```bash
tasks self-update                      # npm i -g wood-fired-tasks@latest, then re-sync skills and agents
tasks --version                        # expect the new version
systemctl --user restart wft-router    # the daemon keeps old code in memory until restarted
systemctl --user status wft-router --no-pager
```

`npm i -g` installs from the registry and uses the prebuilt `better-sqlite3`
binary; CI job `global-install-smoke` covers this path on three operating
systems.

### 5.3 Server and database — needs sudo

`deploy/upgrade.sh` is the only supported path. It is run from a source
checkout whose `dist/` is freshly built.

```bash
cd ~/wood-fired-tasks
git fetch --tags && git checkout vX.Y.Z
npx --yes npm@11.21.1 ci               # same npm as CI
npm run build
WFT_NODE_BIN=/home/stuart/.nvm/versions/node/v22.22.0/bin/node bash deploy/upgrade.sh
```

What the script does, in order:

1. Refuses to run if `dist/` is missing or older than `src/`.
2. Copies `data/tasks.db`, `-wal` and `-shm` to
   `/opt/wood-fired-tasks/backups/pre-deploy-<UTC>.db*`, and the current
   `dist/` to `backups/dist-pre-deploy-<UTC>/`.
3. `systemctl stop wood-fired-tasks`.
4. Replaces `dist/`, `package.json`, `package-lock.json` and `scripts/`.
5. `npm ci --omit=dev` in `/opt/wood-fired-tasks`, using the npm next to
   `WFT_NODE_BIN`.
6. `node dist/db/migrate.js`. Migrations run under `BEGIN EXCLUSIVE` and are
   recorded in `_migrations`.
7. `systemctl start wood-fired-tasks`, then polls `http://localhost:3000/health`
   for 30 seconds.
8. On failure it prints the rollback commands and exits non-zero. It does
   **not** roll back by itself.

`WFT_NODE_BIN` must be the Node the service runs under, so that the native
`better-sqlite3` binding matches.

The script re-executes itself under `sudo`. `sudo` on this host asks for a
password (`sudo -n true` fails), so **a human must run this step in a real
terminal**.

### 5.4 Verification

```bash
curl -s localhost:3000/health                # "version":"X.Y.Z"
systemctl status wood-fired-tasks --no-pager # active (running), start time just now
tasks --json project-list | head             # data still served
```

Then compare the fingerprint from `/health/detailed` or MCP `check_health`
(`projects`, `maxTaskId`, `latestActivity`) with the values noted before the
upgrade; project count and highest task id must match. Reconnect
the MCP server in each agent session and call `check_health`: a session that
still reports the old version has not reconnected.

### 5.5 Rollback

The script prints these with the real timestamp filled in:

```bash
sudo systemctl stop wood-fired-tasks
sudo rm -rf /opt/wood-fired-tasks/dist
sudo cp -a /opt/wood-fired-tasks/backups/dist-pre-deploy-<UTC> /opt/wood-fired-tasks/dist
sudo cp /opt/wood-fired-tasks/backups/pre-deploy-<UTC>.db /opt/wood-fired-tasks/data/tasks.db
# and the .db-wal / .db-shm copies if they exist
sudo systemctl start wood-fired-tasks
```

The recipe restores `dist/` and the database but **not** `node_modules`,
`package.json` or `package-lock.json`. If the failed release changed a
dependency, also restore those two files from the previous tag and run
`npm ci --omit=dev` before starting. Restoring the database discards anything
written after the backup. CLI rollback is `npm i -g wood-fired-tasks@<previous>`.

### 5.6 Backups — gaps found

- There is **no scheduled backup** of the live database. `deploy/crontab.example`
  is not installed in the `stuart` crontab, `/opt/wood-fired-tasks/deploy/`
  does not exist, and `deploy/backup-sqlite.sh` cannot run here because the
  `sqlite3` command is not installed. The newest backup is the pre-deploy copy
  from 2026-10-21. (Root's crontab could not be read.)
- The pre-deploy copy is taken with `cp` **before** the service is stopped, so
  it is a copy of a database that may be mid-write.
- Pre-deploy copies are root-owned, mode 600, and never pruned: 97 entries,
  353 MB.
- `tasks backup` reads the database chosen by `resolveDbPath()`. Without
  `DATABASE_PATH` that is `~/.local/share/wood-fired-tasks/tasks.db`, not the
  server's database (the same cause as WFT #2370).

## 6. Why the install says 2.8.0 while the repository is at 2.9.0

Both releases were cut on 2026-10-21:

| Time (UTC) | Event |
| --- | --- |
| 10:09 | `v2.8.0` published to npm |
| 14:53 | `/opt` upgraded to 2.8.0 (`backups/pre-deploy-20261021T145334Z.db`) |
| 15:08 | Global CLI installed at 2.8.0 (file time of its `package.json`) |
| 21:44 | `v2.9.0` published to npm; GitHub release created 21:45 |

Nothing was run on the host after 21:44. Publishing to npm never touches an
existing install: the server only changes when `deploy/upgrade.sh` is run, and
the CLI only when `self-update` or `npm i -g` is run. Nothing is broken; the
two upgrade steps for 2.9.0 were simply never done.

To bring the install current:

1. **CLI, router, skills** (no sudo): the three commands in 5.2. Check first
   that `/usr/bin/node --version` is at least 22.14.0, which 2.9.0 requires;
   it is 22.23.3 today.
2. **Server** (sudo, human): the commands in 5.3 with `vX.Y.Z` = `v2.9.0`.
   `~/wood-fired-tasks` is already on `main` at `v2.9.0`. 2.9.0 has no new
   migration, so the migrate step will report nothing pending.
3. Verify as in 5.4, then reconnect MCP in the running agent sessions.

One thing is untested for this particular upgrade. 2.9.0 moves to
`better-sqlite3` 13, and step 5 of `upgrade.sh` runs `npm ci` with the npm
bundled with Node 22.22.0, which is 10.9.4. The changelog says npm older than
11.21.1 compiles `better-sqlite3` from source on `npm ci`. The host has `gcc`,
`make` and `python3`, so the compile should succeed, but it happens while the
service is stopped and has not been done here before. Have the rollback
commands ready, or first install npm 11.21.1 into that Node.

## 7. Where `docs/RELEASE.md` is out of date

| `docs/RELEASE.md` says | Verified |
| --- | --- |
| `enforce_admins: false`, admin override allowed | `enforce_admins` is `true` |
| Tags are annotated (`git tag -a`) | `v2.8.0` and `v2.9.0` are lightweight |
| The workflow "derives the published version from the tag" | It publishes the `package.json` version; the tag is only the trigger |
| CHANGELOG headings look like `## [v2.4.0]` | Since 2.5.0 they are `## [2.5.0]`, no `v` |
| The tarball list ends at `docs/AGENT_CONTEXT.md` | `files` in `package.json` also ships 14 more docs, `scripts/postinstall.cjs` and the `wft-router` package |
| Nothing on GitHub Releases, the `/opt` upgrade, the CLI upgrade or rollback | Sections 2, 5 and 6 here |

## 8. Steps that need a human or a credential the bot does not hold

| Step | Why |
| --- | --- |
| Merging the release pull request | Push rights on `main`. The `gh` login on this host is Stuart's personal account. |
| Pushing the `vX.Y.Z` tag | Same. This is the act that publishes to npm, and it cannot be undone. |
| Creating the GitHub release | Same. |
| Anything on npmjs.com: the trusted-publisher binding, adding a maintainer, deprecating or unpublishing a version | The npm account `stuartjeff`, with its password and second factor. |
| A manual `npm publish` if the workflow is unusable | Same npm account. |
| Changing branch protection or required checks | GitHub repository admin. |
| `deploy/upgrade.sh`, and any `systemctl stop/start/restart wood-fired-tasks` | `sudo` password, in a real terminal. |
| Database restore during a rollback | `sudo`, plus the judgement call about discarding writes made since the backup. |
| Editing `/opt/wood-fired-tasks/.env` | Holds the server's secrets (mode 600); it was not read for this report. |

What the bot can do alone: steps 1 – 4 of section 2 up to the merge, watching
the publish run, `npm view`, everything in 5.2, and all of the verification in
5.4.

For the producer bot to own releases end to end, Stuart would need to decide
on three grants: a GitHub identity for the bot with push rights for tags and
merges; passwordless `sudo` limited to `systemctl stop|start wood-fired-tasks`
(the files under `/opt` are owned by `stuart`, so the file steps of
`upgrade.sh` do not themselves need root, though the script as written
re-executes wholly under `sudo`); and a scheduled, verified database backup
so that an unattended upgrade has something recent to fall back to.
