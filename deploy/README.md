# deploy/

Production deployment artefacts for Wood Fired Bugs: install/restore/backup
scripts, the systemd unit, an env template, and a sample crontab line.

The scripts are designed to be **operator-portable** — none of them hardcode a
personal username or a non-standard install path. Two environment variables
control the two things that operators commonly need to override.

## Configuration variables

| Variable           | Default                | Purpose                                                                 |
| ------------------ | ---------------------- | ----------------------------------------------------------------------- |
| `WFB_INSTALL_DIR`  | `/opt/wood-fired-bugs` | Root directory for the deployed app, data, backups, and `.env`.         |
| `WFB_SERVICE_USER` | `wood-fired-bugs`      | UNIX account that owns `$WFB_INSTALL_DIR` and runs the systemd service. |

Both default to values that are appropriate for a single-tenant Linux host. You
only need to override them when:

- Your distro packaging policy requires a different install root (e.g.
  `/srv/wood-fired-bugs`, `/var/lib/wood-fired-bugs`), or
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
sudoedit /opt/wood-fired-bugs/.env

# 4. Start it
sudo systemctl start wood-fired-bugs
sudo systemctl status wood-fired-bugs
```

`install.sh` will create the `wood-fired-bugs` system user (locked shell,
`--no-create-home`) if it doesn't already exist.

## Custom install path or service user

Export the env vars before invoking `install.sh`. They are propagated through
`sudo -E` so the script sees them:

```bash
export WFB_INSTALL_DIR=/srv/wood-fired-bugs
export WFB_SERVICE_USER=appsvc

sudo -E bash deploy/install.sh
```

When either variable is non-default, `install.sh` writes a systemd drop-in to:

```
/etc/systemd/system/wood-fired-bugs.service.d/override.conf
```

The drop-in overrides `User=`, `Group=`, `WorkingDirectory=`, `EnvironmentFile=`,
`ExecStart=`, and `ReadWritePaths=` to point at your chosen user and path. The
shipped `wood-fired-bugs.service` itself is **not** modified — it stays the
canonical packaged unit and survives upgrades.

To inspect the effective configuration after install:

```bash
systemctl cat wood-fired-bugs
```

## Backups

`backup-sqlite.sh` and `restore-sqlite.sh` honour `WFB_INSTALL_DIR` for the
default DB and backup-directory locations. Override per-invocation by passing
positional args, or globally by exporting the env var:

```bash
# Honour custom install dir
export WFB_INSTALL_DIR=/srv/wood-fired-bugs
./deploy/backup-sqlite.sh

# Or pass explicit paths
./deploy/backup-sqlite.sh /custom/path/tasks.db /custom/path/backups
```

`restore-sqlite.sh` also honours `WFB_SERVICE_USER` for re-chowning the
restored database file.

## Crontab

`deploy/crontab.example` installs into the service user's crontab:

```bash
sudo -u "${WFB_SERVICE_USER:-wood-fired-bugs}" crontab -e
# paste the line from crontab.example
```

## Removing the deployment

```bash
sudo systemctl stop wood-fired-bugs
sudo systemctl disable wood-fired-bugs
sudo rm /etc/systemd/system/wood-fired-bugs.service
sudo rm -rf /etc/systemd/system/wood-fired-bugs.service.d
sudo systemctl daemon-reload

# Optional: remove install dir and service user
sudo rm -rf "${WFB_INSTALL_DIR:-/opt/wood-fired-bugs}"
sudo userdel "${WFB_SERVICE_USER:-wood-fired-bugs}"
```
