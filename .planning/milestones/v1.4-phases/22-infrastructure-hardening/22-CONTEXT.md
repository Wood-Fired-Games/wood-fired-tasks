# Phase 22: Infrastructure Hardening - Context

**Gathered:** 2026-02-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Add resource limits and deeper security hardening to the existing systemd service unit (`deploy/wood-fired-bugs.service`). The service file already has basic security (ProtectSystem=strict, ProtectHome=read-only, PrivateTmp=yes, NoNewPrivileges=yes). This phase adds resource limits (MemoryMax, CPUQuota) and additional security directives.

</domain>

<decisions>
## Implementation Decisions

### Resource limits (INFR-01)
- MemoryMax=512M — generous for a Node.js + SQLite service. Prevents runaway memory from leaking unbounded.
- CPUQuota=100% — one full CPU core max. Prevents CPU-bound operations from starving other services.
- TasksMax=50 — limit forked processes. Node.js is single-threaded but may spawn child processes.

### Security hardening (INFR-02)
- Keep User=stuart (NOT DynamicUser) — the service needs stable ownership of /opt/wood-fired-bugs/data/tasks.db. DynamicUser would break SQLite file persistence across restarts.
- Add these additional directives:
  - ProtectKernelTunables=yes — prevent access to /proc/sys, /sys, etc.
  - ProtectKernelModules=yes — prevent loading kernel modules
  - ProtectKernelLogs=yes — prevent reading kernel log buffer
  - ProtectControlGroups=yes — prevent writing to cgroup hierarchy
  - ProtectClock=yes — prevent changing system clock
  - PrivateDevices=yes — restrict access to /dev
  - RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX — only network sockets needed
  - RestrictNamespaces=yes — prevent creating new namespaces
  - RestrictRealtime=yes — prevent real-time scheduling
  - RestrictSUIDSGID=yes — prevent setuid/setgid
  - SystemCallFilter=@system-service — allowlist safe system calls
  - SystemCallArchitectures=native — only native arch syscalls
  - LockPersonality=yes — prevent changing execution domain
  - MemoryDenyWriteExecute=no — Node.js V8 JIT requires W+X memory (cannot enable this)
  - CapabilityBoundingSet= — drop all capabilities (service doesn't need any)
  - AmbientCapabilities= — no ambient capabilities

### Testing approach
- No automated tests for systemd units (requires VM/container)
- Manual verification: `systemd-analyze security wood-fired-bugs.service` score
- Document the expected score improvement in the summary

### Claude's Discretion
- Exact values for MemoryMax and CPUQuota if the defaults feel wrong
- Any additional systemd security directives that are compatible with Node.js
- Whether to add documentation comments in the service file

</decisions>

<specifics>
## Specific Ideas

- The existing service file at `deploy/wood-fired-bugs.service` is the only file to modify
- MemoryDenyWriteExecute CANNOT be enabled — V8 JIT compiler requires write+execute pages
- DynamicUser CANNOT be used — SQLite needs stable file ownership across restarts
- The service only needs network access (AF_INET, AF_INET6) and unix sockets (AF_UNIX)

</specifics>

<deferred>
## Deferred Ideas

None — this is the final phase of the v1.4 milestone.

</deferred>

---

*Phase: 22-infrastructure-hardening*
*Context gathered: 2026-02-17*
