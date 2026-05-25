# Troubleshooting & Recovery

Owner: Repository maintainers

Operator-facing runbook for the failure modes most likely to look alarming on a
self-hosted deployment. Format: **symptom → cause → fix**. The golden rule for
all of them: **diagnose before you "restore" — most apparent data loss is a
misconfiguration, and restoring a backup over a healthy database is what
actually destroys data.**

See also [`deploy/README.md`](../deploy/README.md) (install / backup / restore
scripts and the systemd unit) and [`MCP.md`](MCP.md) (MCP server wiring).

## 1. The service won't start after a reboot (`exit 78/CONFIG`)

**Symptom.** After a host reboot the dashboard/API is unreachable and the unit
is `failed`:

```bash
systemctl status wood-fired-bugs   # Active: failed (Result: exit-code) ... status=78/CONFIG
journalctl -u wood-fired-bugs -b | grep -i oidc
# ... oidc.discovery_failed ... issuer=https://accounts.google.com ... "fetch failed"
```

**Cause.** When OIDC (SSO) is enabled, the service performs IdP discovery at
startup and treats failure as fatal (`exit 78` = `EX_CONFIG`). If the unit
starts before the network is actually up, discovery fails and systemd
crash-loops it past the start limit, latching `failed`. This is a
**boot-ordering race, not a database problem** — the data is untouched.

**Fix (immediate).** Once connectivity is back, clear the latch and start:

```bash
sudo systemctl reset-failed wood-fired-bugs && sudo systemctl start wood-fired-bugs
```

**Fix (durable).** Make the unit wait for real connectivity. The shipped unit
already orders after `network-online.target`; if you customized it, add a
drop-in — see [`deploy/README.md`](../deploy/README.md) ("Network ordering").
`network-online.target` only actually waits if
`NetworkManager-wait-online.service` (or `systemd-networkd-wait-online.service`)
is enabled:

```bash
systemctl is-enabled NetworkManager-wait-online.service systemd-networkd-wait-online.service
```

## 2. The dashboard or MCP shows missing, stale, or zero tasks

**Symptom.** Tasks/projects you know exist appear gone, counts look old, or an
agent's MCP client reports an empty or short list — but you never deleted
anything.

**Cause.** A surface is pointed at the **wrong database file**. The most common
trigger: the **local** MCP variant (`dist/mcp/index.js` + `DATABASE_PATH`) opens
a SQLite file *directly* and silently serves whatever is there — often a stale
dev copy (e.g. a `./data/tasks.db` inside a checkout) while the service owns the
real production DB elsewhere. Nothing warns you. **This is almost never data
loss.**

**Fix.**

1. Find the DB each surface uses (section 3).
2. Point the MCP client at the **remote (REST) variant** so it shares the one
   database the service owns — see [`MCP.md`](MCP.md) ("Recommended setup").
   The local direct-SQLite variant is the footgun; prefer remote for anything
   shared, so the service stays the single writer.
3. Reconnect (or restart) the MCP client and re-check.

## 3. Confirm which database you're on — and back up / restore safely

**Identify the live DB.**

- The service reads `DATABASE_PATH` (or legacy `DB_PATH`) from its
  `EnvironmentFile` (`/opt/wood-fired-bugs/.env` by default). `systemctl cat
  wood-fired-bugs` shows the effective config.
- Ask the running service what it opened: the authenticated `GET /health/detailed`
  (send your `X-API-Key`) reports the resolved DB path plus a fingerprint (project
  count, max task id, latest activity), and the MCP `check_health` tool surfaces the
  same. Compare that fingerprint to what you expect *before* concluding anything is
  lost. (The public `GET /health` stays intentionally minimal — task #185.)
- A quick read-only peek (does **not** modify the file):

```bash
sqlite3 "file:/opt/wood-fired-bugs/data/tasks.db?mode=ro" \
  "SELECT count(*) FROM projects; SELECT max(id) FROM tasks;"
```

> [!WARNING]
> **Do not restore a backup until you have confirmed the live DB is actually
> damaged or empty.** A "stale-looking" DB is usually a wrong-path or
> wrong-MCP-variant problem (section 2), and the real data is intact elsewhere.
> Restoring an older/smaller backup over a healthy database is what destroys the
> missing work. Verify fingerprints first; restore only as a last resort, and
> copy the current file aside before you do.

**Back up / restore.** Use the scripts documented in
[`deploy/README.md`](../deploy/README.md): `deploy/backup-sqlite.sh` (safe online
backup) and `deploy/restore-sqlite.sh` (restores into the service-owned path and
re-chowns). Stop the service before restoring.

---

For setup and environment variables see [`SETUP.md`](SETUP.md); for the agent
entry point see [`../AGENTS.md`](../AGENTS.md).
