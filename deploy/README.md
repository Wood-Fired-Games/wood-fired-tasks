# deploy/

Production deployment artefacts for Wood Fired Tasks: install/restore/backup
scripts, the systemd unit, an env template, and a sample crontab line.

The scripts are designed to be **operator-portable** — none of them hardcode a
personal username or a non-standard install path. Two environment variables
control the two things that operators commonly need to override.

## Configuration variables

| Variable           | Default                | Purpose                                                                 |
| ------------------ | ---------------------- | ----------------------------------------------------------------------- |
| `WFT_INSTALL_DIR`  | `/opt/wood-fired-tasks` | Root directory for the deployed app, data, backups, and `.env`.         |
| `WFT_SERVICE_USER` | `wood-fired-tasks`      | UNIX account that owns `$WFT_INSTALL_DIR` and runs the systemd service. |

Both default to values that are appropriate for a single-tenant Linux host. You
only need to override them when:

- Your distro packaging policy requires a different install root (e.g.
  `/srv/wood-fired-tasks`, `/var/lib/wood-fired-tasks`), or
- The host already has a service account you want to reuse, or
- You're co-locating multiple instances on one host and need to namespace them.

## Standard install (defaults)

```bash
# 1. Build the app (from the repo root)
npm ci
npm run build

# 2. Run the installer (creates user, copies files, enables systemd unit)
sudo bash deploy/install.sh

# 3. Set real API keys
sudoedit /opt/wood-fired-tasks/.env

# 4. Start it
sudo systemctl start wood-fired-tasks
sudo systemctl status wood-fired-tasks
```

`install.sh` will create the `wood-fired-tasks` system user (locked shell,
`--no-create-home`) if it doesn't already exist.

## Network ordering (required when OIDC is enabled)

The shipped unit orders after `network-online.target` (and pulls it in with
`Wants=`) so the service waits for real connectivity before starting. This
matters because OIDC discovery runs at startup: without it, a cold boot can
start the service before the network is up, discovery fails (`fetch failed`),
and the service exits `78/CONFIG` and crash-loops past its start limit —
looking, alarmingly, like a missing database when it is really just a boot race.

`network-online.target` only actually *waits* if a wait-online service is
enabled. Most hosts already have one; verify with:

```bash
systemctl is-enabled NetworkManager-wait-online.service \
  systemd-networkd-wait-online.service
```

If neither is enabled, enable the one matching your network stack (e.g.
`sudo systemctl enable NetworkManager-wait-online.service`).

If the service is already stuck in `failed` from this race, clear the latch and
start it once connectivity is back:

```bash
sudo systemctl reset-failed wood-fired-tasks && sudo systemctl start wood-fired-tasks
```

See [`docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md) for the full recovery runbook.

## Network exposure (HOST binding)

The shipped env template (`wood-fired-tasks.env.example`) sets
`HOST=127.0.0.1`, and the runtime default is the same. This keeps the server
**loopback-only**: it is reachable only from the host it runs on, so a fresh
deploy is never accidentally exposed on every network interface. This is the
recommended posture for production.

To serve clients on other machines, do **not** simply flip the bind to
`0.0.0.0`. Instead:

- **Front the service with a reverse proxy** (e.g. nginx or Caddy) on the same
  host. The proxy listens on `:443`/`:80`, terminates TLS, and forwards to the
  loopback-bound app at `127.0.0.1:3000`. The app itself stays on loopback —
  nothing else needs to change in `.env`.
- **Restrict access with a firewall.** Allow only the proxy's listening ports
  (and only from trusted networks) via `ufw`, `nftables`, or your cloud
  security groups. The app port (`3000`) should never be open to untrusted
  networks.

Only if you have a specific reason to bind the app directly to the LAN —
**and** you have the reverse proxy and firewall above in place — uncomment the
`HOST=0.0.0.0` example in the env template (or set a specific LAN IP, e.g.
`HOST=10.0.0.5`). Binding `0.0.0.0` without a firewall exposes the task tracker
on every interface, including any public one.

## Custom install path or service user

Export the env vars before invoking `install.sh`. They are propagated through
`sudo -E` so the script sees them:

```bash
export WFT_INSTALL_DIR=/srv/wood-fired-tasks
export WFT_SERVICE_USER=appsvc

sudo -E bash deploy/install.sh
```

When either variable is non-default, `install.sh` writes a systemd drop-in to:

```
/etc/systemd/system/wood-fired-tasks.service.d/override.conf
```

The drop-in overrides `User=`, `Group=`, `WorkingDirectory=`, `EnvironmentFile=`,
`ExecStart=`, and `ReadWritePaths=` to point at your chosen user and path. The
shipped `wood-fired-tasks.service` itself is **not** modified — it stays the
canonical packaged unit and survives upgrades.

To inspect the effective configuration after install:

```bash
systemctl cat wood-fired-tasks
```

## Backups

`backup-sqlite.sh` and `restore-sqlite.sh` honour `WFT_INSTALL_DIR` for the
default DB and backup-directory locations. Override per-invocation by passing
positional args, or globally by exporting the env var:

```bash
# Honour custom install dir
export WFT_INSTALL_DIR=/srv/wood-fired-tasks
./deploy/backup-sqlite.sh

# Or pass explicit paths
./deploy/backup-sqlite.sh /custom/path/tasks.db /custom/path/backups
```

`restore-sqlite.sh` also honours `WFT_SERVICE_USER` for re-chowning the
restored database file.

## Crontab

`deploy/crontab.example` installs into the service user's crontab:

```bash
sudo -u "${WFT_SERVICE_USER:-wood-fired-tasks}" crontab -e
# paste the line from crontab.example
```

## Removing the deployment

```bash
sudo systemctl stop wood-fired-tasks
sudo systemctl disable wood-fired-tasks
sudo rm /etc/systemd/system/wood-fired-tasks.service
sudo rm -rf /etc/systemd/system/wood-fired-tasks.service.d
sudo systemctl daemon-reload

# Optional: remove install dir and service user
sudo rm -rf "${WFT_INSTALL_DIR:-/opt/wood-fired-tasks}"
sudo userdel "${WFT_SERVICE_USER:-wood-fired-tasks}"
```
