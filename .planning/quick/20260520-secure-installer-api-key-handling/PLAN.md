---
slug: secure-installer-api-key-handling
status: in-progress
date: 2026-05-20
task_id: 184
---

# Secure installer and client API key handling

## Problem

Setup/install scripts encourage or accept API keys on command lines and write
long-lived keys into cleartext files. Command-line secrets leak via shell
history and process listings (`/proc/<pid>/cmdline`, `ps -ef`). Generated
config and backup files default to umask-derived permissions and can be
world-readable.

Concrete leak surfaces:

- `install.sh` `--api-key KEY`
- `install.ps1` `-ApiKey KEY`
- `client-package/setup.sh` `--api-key KEY` (required)
- `client-package/setup.bat` `setup.bat KEY ...` (positional)
- `client-package/setup.ps1` `-ApiKey KEY` (mandatory)
- `client-package/setup.ps1` writes `bin/tasks.cmd` with literal `set API_KEY=<key>`
- `~/.claude.json` updated by installers with embedded key, no permission tightening
- Timestamped `~/.claude.json.backup.<ts>` files inherit umask, not 600

## Remediation

1. **Preferred secret source order** (everywhere):
   1. Environment variable (`WOOD_FIRED_BUGS_API_KEY` / `WFB_API_KEY`)
   2. Per-user secret file (`~/.config/wood-fired-bugs/api-key` on Unix,
      `%LOCALAPPDATA%\wood-fired-bugs\api-key` on Windows) with strict perms
   3. Masked interactive prompt
   4. **Deprecated** command-line argument (emits a warning, still works for
      one release to preserve backwards compat)
2. Tighten file permissions on every file we write that contains a secret:
   - Unix: `chmod 600` on `~/.claude.json`, all timestamped backups, and the
     per-user secret file
   - Windows: `icacls /inheritance:r /grant:r "$env:USERNAME:(R,W)"` on the
     same files (user-only ACL)
3. Replace embedded-key Windows `tasks.cmd` with a wrapper that reads the
   key from the per-user secret file at runtime. The wrapper does not contain
   the key itself.
4. Docs: present env-var / secret-file / interactive flow as the primary path
   and call out argv as deprecated.

## Files to modify

- `install.sh`
- `install.ps1`
- `client-package/setup.sh`
- `client-package/setup.bat`
- `client-package/setup.ps1`
- `client-package/uninstall.ps1` (clean up new secret file + tasks.cmd)
- `client-package/README.md`
- `docs/SETUP.md` (mention secret-file flow)

## Out of scope (other agents own)

- `src/api/server.ts`
- `src/repositories/task.repository.ts`
- `package.json`
- `package-lock.json`

## Verification

- `bash -n install.sh client-package/setup.sh client-package/uninstall.sh 2>/dev/null` (syntax check)
- PowerShell: `pwsh -NoLogo -Command "Get-Command -Syntax ..."` if available; otherwise visual review.
- Grep: ensure no path embeds `$ApiKey`/`$API_KEY` into a wrapper file as a literal `set API_KEY=` line.
- Grep: ensure each write to `~/.claude.json` or its backup is followed by a `chmod 600` (Unix) / `icacls` call (Windows).
- Grep: ensure each script supports env-var, secret-file, and prompt input paths.
- `npm test` (sanity — installer changes should not touch TypeScript, so test suite should still pass unchanged).
