/**
 * Cross-platform-safe npm invocation builder (project #36, task #794).
 *
 * Two Windows hazards must be handled *together* whenever we shell out to npm:
 *
 *  1. **EINVAL** — npm on Windows is `npm.cmd` (a batch file). Since the
 *     CVE-2024-27980 hardening (Node 18.20.2 / 20.12.2+), Node refuses to spawn
 *     a `.cmd`/`.bat` directly without a shell and throws `spawn EINVAL`. So we
 *     must run npm through a shell on win32 (`shell: true`).
 *
 *  2. **arg-splitting** — once `shell: true` is set, Node joins the command and
 *     its args with single spaces and hands that line to `cmd.exe` *verbatim*
 *     (it does NOT escape per-arg). An argument containing spaces — e.g. a
 *     prefix path under `C:\Users\John Doe\.npm-global` — would then be split
 *     into multiple tokens by cmd.exe. So on win32 we double-quote any arg that
 *     needs it before handing the array to the shell.
 *
 * `self-update` (constant args) and `setup --fix-npm-prefix` (a user home path
 * that may contain spaces) both route through here so the fix cannot drift
 * between the two call sites.
 */

/** npm binary name for the platform (`npm.cmd` on win32, else `npm`). */
export function npmBin(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * Quote a single argument for the win32 `cmd.exe` shell when it contains spaces
 * or shell metacharacters; otherwise return it unchanged. Embedded double
 * quotes are doubled (`"` → `""`), the cmd.exe convention.
 */
export function quoteWin32Arg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface NpmInvocation {
  /** The executable to spawn (`npm.cmd` on win32, `npm` elsewhere). */
  command: string;
  /** Args, win32-quoted when running through the shell. */
  args: string[];
  /** Whether the spawn must go through a shell (true only on win32). */
  shell: boolean;
}

/**
 * Build a `{ command, args, shell }` triple that runs `npm <args...>` safely on
 * the given platform. Pass the result straight to `spawn`/`spawnSync`/
 * `execFileSync` (forwarding `shell`). On non-win32 this is a plain, shell-less
 * `npm` invocation with args untouched.
 */
export function buildNpmInvocation(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NpmInvocation {
  if (platform === 'win32') {
    return { command: npmBin(platform), args: args.map(quoteWin32Arg), shell: true };
  }
  return { command: npmBin(platform), args: [...args], shell: false };
}
