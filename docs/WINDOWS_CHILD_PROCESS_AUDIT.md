# Windows `child_process` audit (task #794)

Node, since the **CVE-2024-27980** hardening (Node 18.20.2 / 20.12.2+), refuses
to spawn a Windows `.cmd`/`.bat` file **without a shell** and throws
`spawn EINVAL`. npm on Windows is `npm.cmd`, so any direct `spawn`/`execFile` of
`npm` without `shell: true` breaks on Windows.

The matching second hazard: once `shell: true` is set, Node joins the command
and args with spaces and hands the line to `cmd.exe` **verbatim** (no per-arg
escaping). Any arg containing spaces (e.g. a prefix path under
`C:\Users\John Doe\...`) is then **split** by cmd.exe. So a correct fix must
handle *both* — shell on win32 **and** per-arg quoting.

This audit classifies every `child_process` spawn/execFile/exec call in the
CLI/MCP surface against that rule.

## Shared helper

`src/cli/util/npm-spawn.ts` — `buildNpmInvocation(args, platform)` returns
`{ command, args, shell }`:

- win32 → `npm.cmd`, `shell: true`, args double-quoted via `quoteWin32Arg`
  (only when they contain spaces / shell metacharacters).
- elsewhere → `npm`, `shell: false`, args untouched.

Both npm call sites (`self-update`, `setup --fix-npm-prefix`) route through it so
the fix cannot drift apart again. Unit-tested in
`src/cli/util/__tests__/npm-spawn.test.ts` (win32 + spaced-path vector, POSIX
no-op, self-update constant vector).

## Site classification

| # | File | Call | Binary on win32 | `.cmd` EINVAL risk | Status |
|---|------|------|-----------------|--------------------|--------|
| 1 | `src/cli/commands/self-update.ts` | `spawn(npm i -g …)` | `npm.cmd` | **Yes** | **FIXED** — #793, now via `buildNpmInvocation` (shell:true win32). Constant args, no spaces. |
| 2 | `src/cli/commands/setup.ts` | `fixNpmPrefix` → `execFileSync(npm config set prefix <home>/.npm-global)` | `npm.cmd` | **Yes** | **FIXED** — #794. Default runner routes through `buildNpmInvocation`; the prefix path is quoted, so a spaced home (`C:\Users\John Doe`) does not split. |
| 3 | `src/cli/commands/docs.ts` | `execFileSync('cmd', ['/c','start','',path])` | `cmd.exe` | No | **SAFE** — `cmd.exe` is a real `.exe`, not a `.cmd`. `shell:false`, so libuv passes the arg array directly (no shell re-parse); the empty `""` is the `start` title placeholder so a spaced doc path is handled. |
| 4 | `src/cli/commands/service.ts` | `execFileSync('systemctl' \| 'schtasks', …)` | `schtasks.exe` (win32) / `systemctl` (linux) | No | **SAFE** — `schtasks.exe`/`systemctl` are real executables, not `.cmd`. `shell:false`; args passed as an array. Elevation is hard-guarded separately (`ELEVATION_RE`). |
| 5 | `src/cli/commands/mcp.ts` | `spawn(process.execPath, ['--import','tsx',target])` | `node.exe` | No | **SAFE** — `process.execPath` is the real Node `.exe`. |
| 6 | `src/cli/auth/browser-open.ts` | `spawn('cmd', ['/c','start','',url], {shell:false})` | `cmd.exe` | No | **SAFE** — `cmd.exe` is a real `.exe`; `shell:false` + the documented T-30-06-01 mitigation (URL never reaches a shell). |
| 7 | `src/db/migrations/009-parallel-fk-columns.ts` | — | — | No | **N/A** — no `child_process`; the only mention is a comment clarifying it runs SQL on the DB connection, not a shell. |

## Rule of thumb for new code

- Spawning **npm** → use `buildNpmInvocation` from `src/cli/util/npm-spawn.ts`.
  Never `spawn('npm', …)` / `execFileSync('npm', …)` directly.
- Spawning any other `.cmd`/`.bat` on Windows → set `shell: true` **and** quote
  any arg that can contain spaces (or add a sibling helper).
- Spawning a real `.exe` (`node`, `cmd.exe`, `schtasks.exe`, `systemctl`) →
  `shell: false` with an args array is correct and safe.
