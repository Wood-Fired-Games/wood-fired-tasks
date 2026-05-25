<!--
INTERNAL HISTORICAL ARTIFACT — not user-facing documentation.

This directory records a one-time, maintainer-only project rename
(old private working name → `wood-fired-tasks`) that predates the first
public release. It is preserved for provenance only. References to the old
private name and to internal task/project numbers below are historical and
do NOT describe any current public surface. The project ships exclusively as
`wood-fired-tasks`; there is no old name to migrate from for external users.
-->

# Rename history (internal artifact) → `wood-fired-tasks`

Tracking: **internal project (historical)**. This directory holds the
planning + audit artifacts for the one-time rename. Internal/historical only.

## Scope decision (governs everything here)

The project is **private and never published** (GitHub repo private since
2026-02-13; `wood-fired-bugs` never on npm; `wood-fired-tasks` is free). The
**only impacted user is the maintainer**. Therefore:

- **No public backwards compatibility.** Release as `wood-fired-tasks` with a
  clean break — the public never needs to know the old name. No env/path
  aliases, no deprecation windows, no npm-deprecate, no GitHub-redirect
  guarantees, no anti-impersonation comms.
- The **one** real migration is the maintainer's existing deployed box, handled
  as a **one-off** ([`LOCAL-MIGRATION.md`](LOCAL-MIGRATION.md)), not a repeatable
  process.

This deliberately overrides the compat-heavy framing in the original #287–#298
task descriptions (written before the no-public-users fact was established).

## What's here

| File | Task | Purpose |
|------|------|---------|
| [`AUDIT.md`](AUDIT.md) | #289 | Every old-name occurrence + the clean-rename change map. Re-runnable. |
| [`POSITIONING.md`](POSITIONING.md) | #294 | Why "tasks" not "bugs" — scope narrative for docs & skills. |
| [`IDENTITY-BRIEF.md`](IDENTITY-BRIEF.md) | #287 | Canonical names + first-public-release identity steps. |
| [`LOCAL-MIGRATION.md`](LOCAL-MIGRATION.md) | #293 | One-off runbook to move the maintainer's `/opt` install + config. |

## Sequencing

```
Phase A  (now, this branch — zero rework risk)
  └─ audit + positioning + identity + local-migration runbook (docs only)
Phase B  (after the OSS-prep branch merges to main)
  ├─ one clean mechanical rename sweep, no aliases (#289/#290/#291/#292/#294)
  ├─ git mv deploy unit + env example; rename /opt, user, config-dir defaults
  ├─ regenerate OpenAPI snapshot; rename private GitHub repo in place
  └─ re-run AUDIT.md to catch occurrences the OSS-prep work introduced
Phase C  (maintainer's machine, once)
  ├─ run LOCAL-MIGRATION.md (backup DB, move /opt, rename unit + config dir)
  └─ verification matrix: build, tests, snapshot, smoke, reboot test (#297)
```

**Why Phase B waits for the OSS-prep branch:** a rename touches ~94 files. If it
lands first, the in-flight OSS-prep branch (cut from older `main`) inherits
~94-file conflicts. Merge their branch first, sweep second, then re-audit. This
ordering is independent of the compat decision — it's about not colliding with
the other agent.
