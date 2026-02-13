# Phase 5: Production Deployment - Research

**Researched:** 2026-02-13
**Domain:** systemd service management, network binding, structured logging, SQLite backups
**Confidence:** HIGH

## Summary

Deploying a Node.js Fastify application on Ubuntu with systemd requires attention to four key areas: service lifecycle management, network binding, structured logging, and data protection. The standard approach uses systemd for process supervision with restart policies, binds Fastify to LAN interfaces via the listen() API, outputs JSON logs to stdout for journald capture, and implements automated SQLite backups using the built-in .backup command or VACUUM INTO.

The critical insight for this phase is that systemd handles most complexity (process supervision, logging, auto-start) through declarative configuration, while the application must implement graceful shutdown handlers to respect SIGTERM signals. For SQLite backups in WAL mode, the .backup command via CLI is transaction-safe and simpler than file-system copying which risks corruption.

**Primary recommendation:** Use systemd with Type=simple, Restart=on-failure, and proper StartLimit configuration. Output Pino JSON logs to stdout (journald captures automatically). Bind Fastify to 0.0.0.0 for LAN access with ufw firewall rules. Schedule daily SQLite backups via cron using sqlite3 .backup command.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| systemd | Built-in Ubuntu | Process supervision, auto-start, restart on failure | Native Linux init system, integrates with journald |
| Pino | Latest | Fast structured JSON logging | 5x faster than Winston, JSON output for journald |
| sqlite3 CLI | Built-in | Safe database backups via .backup command | Transaction-safe, uses SQLite Online Backup API |
| cron | Built-in Ubuntu | Schedule automated daily backups | Standard Unix job scheduler |
| ufw | Built-in Ubuntu | Firewall management for LAN access | Simple frontend to iptables |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| better-sqlite3 | Latest | Native backup API in Node.js | If implementing backup in Node.js instead of shell script |
| pino-http | Latest | Fastify request logging | Automatic HTTP request/response logging |
| journalctl | Built-in | Query systemd logs | Debugging, monitoring service logs |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| systemd | PM2, Docker | systemd is native, no extra dependencies, integrates with OS lifecycle |
| Pino stdout | pino-journald transport | No journald transport exists; stdout works perfectly with journald |
| .backup command | VACUUM INTO | VACUUM optimizes database but slower; .backup is simpler for hot backups |
| cron | systemd timers | systemd timers more complex, cron simpler for basic scheduling |

**Installation:**
```bash
# Pino already available in Node.js project
npm install pino pino-http

# System tools (already installed on Ubuntu)
sudo apt-get update
sudo apt-get install sqlite3 cron
```

## Architecture Patterns

### Recommended Project Structure
```
/opt/wood-fired-bugs/           # Application root
├── dist/                        # Compiled JavaScript
│   └── server.js               # Fastify server entry point
├── data/                        # SQLite database location
│   └── bugs.db                 # Main database
├── backups/                     # Backup destination
│   └── bugs-YYYY-MM-DD.db      # Dated backups
├── .env                         # Environment variables (NODE_ENV, PORT, DB_PATH)
├── package.json
└── node_modules/

/etc/systemd/system/
└── wood-fired-bugs.service      # systemd service unit

/home/user/scripts/
└── backup-sqlite.sh             # Backup script for cron
```

### Pattern 1: systemd Service Configuration
**What:** Declarative service unit file defining how systemd manages the Node.js process
**When to use:** All production deployments requiring auto-start and restart on failure
**Example:**
```ini
# Source: https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
# https://devtoolbox.dedyn.io/blog/systemd-complete-guide

[Unit]
Description=Wood-Fired Bugs REST API
Documentation=https://github.com/user/wood-fired-bugs
After=network.target

[Service]
Type=simple
User=stuart
Group=stuart
WorkingDirectory=/opt/wood-fired-bugs
EnvironmentFile=/opt/wood-fired-bugs/.env
ExecStart=/usr/bin/node /opt/wood-fired-bugs/dist/server.js
Restart=on-failure
RestartSec=5s
StartLimitBurst=3
StartLimitIntervalSec=20s
TimeoutStopSec=10s

# Security hardening
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
ReadWritePaths=/opt/wood-fired-bugs/data /opt/wood-fired-bugs/backups

# Graceful shutdown
KillMode=mixed
KillSignal=SIGTERM

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=wood-fired-bugs

[Install]
WantedBy=multi-user.target
```

### Pattern 2: Fastify LAN Binding
**What:** Configure Fastify to listen on all IPv4 interfaces for LAN access
**When to use:** Service needs to be accessible from other machines on local network
**Example:**
```typescript
// Source: https://fastify.dev/docs/latest/Reference/Server/
import Fastify from 'fastify';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // JSON output goes to stdout, captured by journald
});

const fastify = Fastify({ logger });

const start = async () => {
  try {
    // Bind to all IPv4 interfaces for LAN access
    // Default 127.0.0.1 would only allow localhost
    await fastify.listen({
      port: Number(process.env.PORT) || 3000,
      host: '0.0.0.0', // Listen on all interfaces
    });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
```

### Pattern 3: Graceful Shutdown Handler
**What:** Listen for SIGTERM and cleanly close server before exit
**When to use:** Always - required for systemd compatibility and zero-downtime restarts
**Example:**
```typescript
// Source: https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view
// https://nodevibe.substack.com/p/dont-just-pull-the-plug-the-art-of

const gracefulShutdown = async (signal: string) => {
  fastify.log.info(`Received ${signal}, starting graceful shutdown`);

  // Stop accepting new connections
  await fastify.close();

  fastify.log.info('Fastify server closed');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

### Pattern 4: SQLite Backup Script
**What:** Shell script using sqlite3 .backup command for transaction-safe backups
**When to use:** Daily automated backups via cron
**Example:**
```bash
#!/bin/bash
# Source: https://www.sqlite.org/backup.html
# https://litestream.io/alternatives/cron/

DB_PATH="/opt/wood-fired-bugs/data/bugs.db"
BACKUP_DIR="/opt/wood-fired-bugs/backups"
TIMESTAMP=$(date +%Y-%m-%d)
BACKUP_FILE="${BACKUP_DIR}/bugs-${TIMESTAMP}.db"

# Create backup using .backup command (transaction-safe)
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Compress backup (SQLite compresses well)
gzip "$BACKUP_FILE"

# Verify backup integrity
gunzip -c "${BACKUP_FILE}.gz" | sqlite3 :memory: "PRAGMA integrity_check;" > /dev/null

if [ $? -eq 0 ]; then
  echo "Backup successful: ${BACKUP_FILE}.gz"

  # Delete backups older than 30 days
  find "$BACKUP_DIR" -name "bugs-*.db.gz" -mtime +30 -delete
else
  echo "Backup verification failed!"
  exit 1
fi
```

**Cron schedule (daily at 2 AM):**
```bash
# crontab -e
0 2 * * * /home/stuart/scripts/backup-sqlite.sh >> /var/log/wood-fired-bugs-backup.log 2>&1
```

### Pattern 5: UFW Firewall Configuration
**What:** Allow LAN access to service port while blocking external access
**When to use:** Service should only be accessible from local network
**Example:**
```bash
# Source: https://www.digitalocean.com/community/tutorials/ufw-essentials-common-firewall-rules-and-commands
# https://help.ubuntu.com/community/UFW

# Enable UFW
sudo ufw enable

# Allow from LAN subnet only (example: 192.168.1.0/24)
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp

# Or allow on specific interface only
sudo ufw allow in on eth0 to any port 3000 proto tcp

# Verify rules
sudo ufw status numbered
```

### Anti-Patterns to Avoid
- **Running as root:** Always use a dedicated user with minimal permissions
- **Type=forking with Node.js:** Use Type=simple - Node.js doesn't fork by default
- **Copying SQLite files with cp:** Not transaction-safe, risks corruption in WAL mode
- **Binding to 127.0.0.1 for LAN:** Only localhost can access; use 0.0.0.0 for LAN
- **Ignoring SIGTERM:** Application won't shut down gracefully, systemd sends SIGKILL
- **StartLimitIntervalSec in [Service]:** Must be in [Unit] section or silently ignored

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Process supervision | Custom Node.js process manager | systemd | Battle-tested, integrates with OS, handles dependencies, auto-restart |
| Log rotation | Custom file rotation logic | journald built-in rotation | Automatic size limits, compression, queryable via journalctl |
| SQLite backup | File copy with locking logic | sqlite3 .backup command | Uses Online Backup API, transaction-safe, handles WAL mode |
| Graceful restart | Custom PID/lock files | systemd + SIGTERM handler | systemd sends signals, handles timeouts, forces SIGKILL if needed |
| Auto-start on boot | rc.local or init.d scripts | systemd WantedBy=multi-user.target | Modern standard, dependency management, proper ordering |

**Key insight:** systemd eliminates most deployment complexity through declarative configuration. Don't replicate systemd features in application code - use signal handlers and let systemd manage the lifecycle.

## Common Pitfalls

### Pitfall 1: StartLimitIntervalSec Silently Ignored
**What goes wrong:** Service fails to restart after hitting rate limit, even though StartLimitIntervalSec is configured
**Why it happens:** StartLimitIntervalSec and StartLimitBurst must be in [Unit] section, not [Service]. systemd silently ignores them in wrong section
**How to avoid:** Always place StartLimitBurst and StartLimitIntervalSec in [Unit] section. Verify with `systemd-analyze verify service-name.service`
**Warning signs:** Service stops restarting after 5 failures (default limit) despite custom limits configured

### Pitfall 2: SQLite Corruption from File Copy in WAL Mode
**What goes wrong:** Backup created by copying .db file is corrupt or missing recent transactions
**Why it happens:** In WAL mode, data exists in both .db and .db-wal files. Copying only .db misses uncommitted changes. Copying during checkpoint creates inconsistent snapshot
**How to avoid:** Always use sqlite3 .backup command or VACUUM INTO, which use the Online Backup API and handle WAL mode correctly
**Warning signs:** Restored backup fails integrity check, missing recent data, "database disk image is malformed" errors

### Pitfall 3: Insufficient TimeoutStopSec for Cleanup
**What goes wrong:** systemd sends SIGKILL before application finishes graceful shutdown, leaving connections open or data unsaved
**Why it happens:** Default TimeoutStopSec is 90s but may be insufficient for long-running operations. Application doesn't track shutdown time
**How to avoid:** Set TimeoutStopSec to reasonable value (10-30s for most apps). Implement shutdown timeout in application. Log shutdown progress
**Warning signs:** "Killing process with signal SIGKILL" in logs, connections not closed cleanly, database in inconsistent state after restart

### Pitfall 4: WorkingDirectory Doesn't Exist
**What goes wrong:** systemd shows "Status 200/CHDIR" error, service fails to start
**Why it happens:** WorkingDirectory path is wrong, doesn't exist, or has wrong permissions
**How to avoid:** Create directory before enabling service. Use absolute paths. Verify ownership matches User directive
**Warning signs:** systemctl status shows "code=exited, status=200/CHDIR"

### Pitfall 5: ExecStart Path Wrong
**What goes wrong:** systemd shows "Status 203/EXEC" error, service fails to start
**Why it happens:** Node.js binary path wrong (e.g., using nvm but systemd doesn't load shell profile), script not executable, shebang missing
**How to avoid:** Use absolute path to node binary (`which node`). Verify file exists and is executable. Test ExecStart command manually as service user
**Warning signs:** systemctl status shows "code=exited, status=203/EXEC"

### Pitfall 6: Environment Variables Not Loaded
**What goes wrong:** Application can't find configuration, uses wrong defaults, crashes on startup
**Why it happens:** EnvironmentFile path wrong, file format incorrect (needs VAR=VALUE, no export), permissions prevent reading
**How to avoid:** Use EnvironmentFile=/absolute/path/to/.env. Format as VAR=VALUE (no quotes, no export). Verify file readable by service user
**Warning signs:** Application logs show undefined environment variables, default values used instead of production config

### Pitfall 7: Pino JSON Not Visible in journalctl
**What goes wrong:** Logs appear in journalctl but not as structured fields, can't filter by JSON properties
**Why it happens:** journald doesn't parse JSON from stdout by default - it stores the entire line as MESSAGE field
**How to avoid:** This is expected behavior. Use journalctl -o json-pretty for JSON output. Use MESSAGE field for grep. For structured field search, use dedicated log aggregator or journald native fields
**Warning signs:** journalctl shows JSON strings instead of parsed fields (this is normal - not actually a problem)

### Pitfall 8: Restart=always Instead of on-failure
**What goes wrong:** Service restarts even when stopped intentionally with systemctl stop, creates systemd race conditions
**Why it happens:** Restart=always means restart on ANY exit, including manual stops
**How to avoid:** Use Restart=on-failure for services that should only restart on crashes. Use Restart=always only for services that must never stop
**Warning signs:** systemctl stop triggers restart, service can't be stopped without systemctl disable

### Pitfall 9: Binding to 0.0.0.0 Without Firewall
**What goes wrong:** Service exposed to internet if machine has public IP, security vulnerability
**Why it happens:** 0.0.0.0 binds to all interfaces including public ones. Developers assume "LAN only" but don't configure firewall
**How to avoid:** Always configure ufw to restrict access by subnet or interface. Verify with netstat/ss that port isn't publicly exposed. Consider binding to specific LAN IP instead of 0.0.0.0
**Warning signs:** Port scanner shows service accessible from internet, unexpected external traffic in logs

## Code Examples

Verified patterns from official sources:

### Complete Fastify Server with Graceful Shutdown
```typescript
// Source: https://fastify.dev/docs/latest/Reference/Server/
// https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view

import Fastify from 'fastify';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Pino outputs JSON to stdout by default
  // systemd captures stdout to journald automatically
});

const fastify = Fastify({
  logger,
  trustProxy: true, // For LAN deployments behind reverse proxy
});

// Register routes
fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Graceful shutdown handler
const gracefulShutdown = async (signal: string) => {
  fastify.log.info({ signal }, 'Received shutdown signal');

  try {
    // Stop accepting new connections
    await fastify.close();
    fastify.log.info('Server closed successfully');
    process.exit(0);
  } catch (err) {
    fastify.log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  fastify.log.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  fastify.log.fatal({ reason, promise }, 'Unhandled rejection');
  process.exit(1);
});

// Start server
const start = async () => {
  try {
    await fastify.listen({
      port: Number(process.env.PORT) || 3000,
      host: process.env.HOST || '0.0.0.0',
    });
  } catch (err) {
    fastify.log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
};

start();
```

### systemd Service Management Commands
```bash
# Source: https://www.freedesktop.org/software/systemd/man/latest/systemctl.html

# Install service
sudo cp wood-fired-bugs.service /etc/systemd/system/
sudo systemctl daemon-reload

# Enable auto-start on boot
sudo systemctl enable wood-fired-bugs

# Start service
sudo systemctl start wood-fired-bugs

# Check status
sudo systemctl status wood-fired-bugs

# View logs (last 50 lines, follow)
sudo journalctl -u wood-fired-bugs -n 50 -f

# View logs with timestamp
sudo journalctl -u wood-fired-bugs --since "1 hour ago"

# View logs as JSON
sudo journalctl -u wood-fired-bugs -o json-pretty

# Restart service
sudo systemctl restart wood-fired-bugs

# Stop service
sudo systemctl stop wood-fired-bugs

# Verify unit file syntax
systemd-analyze verify /etc/systemd/system/wood-fired-bugs.service

# Check security score
systemd-analyze security wood-fired-bugs.service
```

### SQLite Backup with Better-sqlite3 (Alternative to CLI)
```typescript
// Source: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
// Alternative to shell script if implementing backup in Node.js

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function backupDatabase(sourcePath: string, backupDir: string) {
  const timestamp = new Date().toISOString().split('T')[0];
  const backupPath = `${backupDir}/bugs-${timestamp}.db`;

  try {
    const db = new Database(sourcePath, { readonly: true });

    // Use backup() method - wraps sqlite3_backup_init/step/finish
    await db.backup(backupPath);
    db.close();

    // Compress backup
    await execAsync(`gzip -f "${backupPath}"`);

    // Verify integrity
    const testDb = new Database(`${backupPath}.gz`, { readonly: true });
    const result = testDb.pragma('integrity_check');
    testDb.close();

    if (result[0].integrity_check !== 'ok') {
      throw new Error('Backup integrity check failed');
    }

    console.log(`Backup successful: ${backupPath}.gz`);

    // Clean old backups (older than 30 days)
    await cleanOldBackups(backupDir, 30);

  } catch (error) {
    console.error('Backup failed:', error);
    throw error;
  }
}

async function cleanOldBackups(backupDir: string, daysToKeep: number) {
  const files = await fs.readdir(backupDir);
  const now = Date.now();
  const maxAge = daysToKeep * 24 * 60 * 60 * 1000;

  for (const file of files) {
    if (!file.match(/^bugs-\d{4}-\d{2}-\d{2}\.db\.gz$/)) continue;

    const filePath = `${backupDir}/${file}`;
    const stats = await fs.stat(filePath);
    const age = now - stats.mtime.getTime();

    if (age > maxAge) {
      await fs.unlink(filePath);
      console.log(`Deleted old backup: ${file}`);
    }
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| PM2 for Node.js | systemd native | ~2015 | systemd is standard init system, no extra dependencies, better OS integration |
| Custom log files + logrotate | Pino to stdout + journald | ~2020 | Simpler, journald handles rotation/compression, queryable with journalctl |
| Upstart | systemd | Ubuntu 15.04 (2015) | systemd is universal across major Linux distros |
| .backup to file | VACUUM INTO | SQLite 3.27.0 (2019) | VACUUM INTO works during high write load, but .backup still preferred for simplicity |
| node-sqlite3 | better-sqlite3 or native Node.js sqlite | 2020-2024 | Better performance, simpler API; Node.js 22.5.0+ has native SQLite |
| EnvironmentFile= old location | EnvironmentFile=/path/to/.env | Always supported | More explicit, easier to manage secrets separately |

**Deprecated/outdated:**
- **PM2 in production:** systemd is simpler and native, PM2 adds unnecessary complexity for single-server deployments
- **Upstart:** Replaced by systemd in Ubuntu 15.04+
- **StartLimitInterval=** (without Sec): Use StartLimitIntervalSec= (systemd 230+)
- **File copy for SQLite backup:** Never transaction-safe, especially in WAL mode

## Open Questions

1. **Should backups be stored on the same machine or synced to remote storage?**
   - What we know: Current plan stores backups locally in /opt/wood-fired-bugs/backups
   - What's unclear: No remote backup or off-site storage specified in requirements
   - Recommendation: Start with local backups (satisfies INFRA-06), add remote sync (rsync, rclone to cloud storage) in future phase if needed

2. **Should the service use a dedicated system user or the developer's user account?**
   - What we know: Requirements don't specify, examples show using developer user (stuart)
   - What's unclear: Security vs. convenience tradeoff for single-user LAN machine
   - Recommendation: Use developer user for Phase 5 (simpler permissions), document option to create dedicated user for hardening

3. **Should journald limits be customized or use defaults?**
   - What we know: journald defaults to 10% of filesystem, max 4GB
   - What's unclear: Whether this is sufficient for expected log volume
   - Recommendation: Start with defaults, monitor with `journalctl --disk-usage`, adjust SystemMaxUse if needed

4. **Should UFW rules be specific subnet or specific interface?**
   - What we know: LAN access required, Ubuntu machine has LAN interface
   - What's unclear: Whether LAN subnet is static or DHCP, whether machine has multiple interfaces
   - Recommendation: Use subnet-based rules (`ufw allow from 192.168.1.0/24`) - more explicit and easier to audit than interface-based

5. **Should backup restoration be automated or manual?**
   - What we know: INFRA-06 requires "backup can be restored"
   - What's unclear: Whether restoration should be scripted or documented manual process
   - Recommendation: Document manual restoration process first (gunzip, copy to data dir, restart service), automate if needed later

## Sources

### Primary (HIGH confidence)
- [systemd.service manual](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) - Service unit configuration
- [SQLite Online Backup API](https://www.sqlite.org/backup.html) - Official backup methods
- [Fastify Server API](https://fastify.dev/docs/latest/Reference/Server/) - listen() method and configuration
- [SQLite Write-Ahead Logging](https://sqlite.org/wal.html) - WAL mode backup considerations
- [journald.conf manual](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html) - Log rotation configuration
- [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) - backup() method documentation

### Secondary (MEDIUM confidence)
- [Systemd Complete Guide 2026](https://devtoolbox.dedyn.io/blog/systemd-complete-guide) - Comprehensive systemd practices
- [Running Node.js on Linux with systemd - CloudBees](https://www.cloudbees.com/blog/running-node-js-linux-systemd) - Node.js-specific patterns
- [Graceful Shutdown in Node.js 2026](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view) - Current shutdown patterns
- [SQLite Backup Strategies](https://oldmoe.blog/2024/04/30/backup-strategies-for-sqlite-in-production/) - Production backup patterns
- [UFW Essentials - DigitalOcean](https://www.digitalocean.com/community/tutorials/ufw-essentials-common-firewall-rules-and-commands) - Firewall configuration
- [Pino Logger Guide 2026](https://signoz.io/guides/pino-logger/) - Pino configuration and best practices
- [systemd-analyze security](https://www.freedesktop.org/software/systemd/man/latest/systemd-analyze.html) - Security hardening verification

### Tertiary (LOW confidence - marked for validation)
- [node-systemd-journald](https://www.npmjs.com/package/systemd-journald) - Direct journald bindings (not needed - stdout works)
- [pino-journald search](https://www.npmjs.com/search?q=pino%20journald) - No dedicated transport found, stdout approach verified

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - systemd, Pino, sqlite3 CLI verified from official docs
- Architecture: HIGH - Patterns verified from systemd manual, Fastify docs, SQLite docs
- Pitfalls: MEDIUM-HIGH - Common issues verified from multiple sources, some anecdotal

**Research date:** 2026-02-13
**Valid until:** 2026-04-13 (60 days - systemd is stable, practices don't change rapidly)
