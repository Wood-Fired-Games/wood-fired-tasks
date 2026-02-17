# Plan 22-01 Summary: systemd Resource Limits and Security Hardening

**Status:** Complete
**Completed:** 2026-02-17

## What Was Done

Updated `deploy/wood-fired-bugs.service` with:

### Resource Limits (INFR-01)
- `MemoryMax=512M` - prevents runaway memory consumption
- `CPUQuota=100%` - limits to one CPU core
- `TasksMax=50` - limits spawned processes/threads

### Security Hardening (INFR-02)
Added 15 security directives beyond the existing 4:
- **Device/Kernel:** PrivateDevices, ProtectKernelTunables, ProtectKernelModules, ProtectKernelLogs, ProtectControlGroups, ProtectClock
- **Privilege:** CapabilityBoundingSet= (empty), AmbientCapabilities= (empty), RestrictSUIDSGID, LockPersonality
- **Network:** RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
- **Namespaces:** RestrictNamespaces, RestrictRealtime
- **Syscalls:** SystemCallFilter=@system-service, SystemCallArchitectures=native

### Compatibility Notes
- MemoryDenyWriteExecute intentionally NOT enabled (V8 JIT requires W+X pages)
- DynamicUser intentionally NOT used (SQLite needs stable file ownership)
- User=stuart preserved for SQLite database access

## Files Modified

- `deploy/wood-fired-bugs.service` (added resource limits and security directives)

## Verification

- MemoryMax=512M present
- CPUQuota=100% present
- TasksMax=50 present
- 15+ security hardening directives applied
- MemoryDenyWriteExecute NOT enabled (V8 compatible)
- User=stuart preserved
- No automated tests (systemd testing requires VM/container per ROADMAP.md)
