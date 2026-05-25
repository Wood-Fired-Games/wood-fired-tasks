<!--
INTERNAL HISTORICAL ARTIFACT — not user-facing documentation.
Records a one-time, maintainer-only migration of a single existing deployment
during a rename that predates the first public release. The old private name
and internal task numbers below are historical provenance only and do NOT
describe any current public surface. The project ships exclusively as
`wood-fired-tasks`; external users have no old install to migrate from.
-->

# One-off Local Migration (internal, historical)

A **single, manual** migration of the maintainer's existing deployment from the
old name to the new one. This is **not** a repeatable/parameterized process and
ships **no** backwards-compat code — it's run once, by hand, after the rename
sweep (Phase B) is on `main` and the new artifacts are built.

There is exactly one impacted machine. No other installs exist.

## What's being moved

- systemd service `wood-fired-bugs.service` → `wood-fired-tasks.service`
- install dir `/opt/wood-fired-bugs` → `/opt/wood-fired-tasks` (incl. `data/`,
  `backups/`, `.env`)
- service user `wood-fired-bugs` → keep or rename (see note)
- maintainer config `~/.config/wood-fired-bugs/` → `~/.config/wood-fired-tasks/`
- the OIDC `network-online.target` drop-in (must be re-created on the new unit)

The SQLite DB filename is already neutral (`tasks.db`) and its **contents are
untouched** — this is a file/identity move, not a data migration.

## Runbook

Pre-req: new code on `main`, built (`npm ci && npm run build`); maintenance
window (it's just this box, but the service goes down briefly).

```bash
# 1. Stop + back up FIRST (no --force anywhere; keep an off-box copy)
sudo systemctl stop wood-fired-bugs
sudo cp -a /opt/wood-fired-bugs/data/tasks.db* ~/wfb-migration-backup/   # + off-box

# 2. Disable old unit
sudo systemctl disable wood-fired-bugs

# 3. Move the install dir (data + backups ride along intact)
sudo mv /opt/wood-fired-bugs /opt/wood-fired-tasks

# 4. Install the renamed unit (from deploy/wood-fired-tasks.service) with all
#    paths pointing at /opt/wood-fired-tasks, then re-create the OIDC drop-in:
#      [Unit] After=network-online.target  Wants=network-online.target
sudo systemctl daemon-reload

# 5. Move the maintainer config dir
mv ~/.config/wood-fired-bugs ~/.config/wood-fired-tasks

# 6. Start + health-gate
sudo systemctl enable --now wood-fired-tasks
curl -fsS http://localhost:$PORT/health    # expect healthy

# 7. Reboot test — the OIDC fragility is boot-time only
sudo reboot   # then confirm wood-fired-tasks comes up clean (not 78/CONFIG)
```

### Service-user note

Renaming the POSIX user forces a recursive `chown` of the data dir. Since this
is a one-off on a single box, **simplest is to keep the existing
`wood-fired-bugs` user** and only move dir + unit + config. Rename the user only
if you specifically want it gone; if so, `chown -R newuser /opt/wood-fired-tasks`
after step 3.

## Rollback (also one-off)

1. `sudo systemctl disable --now wood-fired-tasks`
2. `sudo mv /opt/wood-fired-tasks /opt/wood-fired-bugs`
3. `mv ~/.config/wood-fired-tasks ~/.config/wood-fired-bugs`
4. `sudo systemctl enable --now wood-fired-bugs`
5. Restore `tasks.db*` from the backup only if the data dir was disturbed.

Because every step is a move (no DB rewrite), rollback is the reverse move +
unit swap — fast and lossless as long as the backup from step 1 exists.

## Checklist

- [ ] DB backed up (local + off-box), verified restorable.
- [ ] New unit file paths all `/opt/wood-fired-tasks`.
- [ ] OIDC `network-online.target` drop-in present on the new unit.
- [ ] Config dir moved; `tasks` CLI still authenticates.
- [ ] Health probe green; reboot test passes (no 78/CONFIG).
- [ ] Decision recorded: kept old service user, or renamed.
