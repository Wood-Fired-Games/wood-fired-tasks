import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PATH remediation hint (task #792).
 *
 * After `npm i -g wood-fired-tasks`, the npm global bin directory may not be on
 * the CURRENT shell's PATH (the user must open a new shell) or — even when it
 * IS on PATH — a POSIX shell may have a stale command-hash cache that resolves
 * the old absence. A child process cannot mutate the parent shell's PATH, but
 * we CAN detect the condition and print the exact one-liner to fix it.
 *
 * The core {@link pathHint} is PURE: every input is injected, there is no I/O,
 * no env reads, no process spawning. The {@link resolvePathHint} resolver
 * gathers real inputs for production callers WITHOUT shelling out to
 * `npm`/`which`/`where` (slow at postinstall time, and `which` would mask the
 * hash-cache case).
 */

export interface PathHintInput {
  /** Target platform (`process.platform`). */
  platform: NodeJS.Platform;
  /** Raw `PATH` env value (may be undefined). */
  pathEnv: string | undefined;
  /** Absolute npm global bin directory the CLI was installed into. */
  npmBinDir: string;
  /** Current shell (e.g. `process.env.SHELL`); used to pick an rc file. */
  shell?: string | undefined;
}

/** Path-list delimiter for the given platform. */
function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

/**
 * Normalize a single PATH entry for comparison. On win32 we compare
 * case-insensitively and tolerate a trailing slash/backslash; on POSIX the
 * comparison is exact (modulo a trailing-slash trim, which is always safe).
 */
function normalizeEntry(entry: string, platform: NodeJS.Platform): string {
  let e = entry.trim();
  // Strip a single trailing path separator (both kinds, defensively).
  e = e.replace(/[/\\]+$/, '');
  if (platform === 'win32') {
    e = e.toLowerCase();
  }
  return e;
}

/** True when `npmBinDir` is present in `pathEnv` after normalization. */
function isOnPath(input: PathHintInput): boolean {
  if (input.pathEnv === undefined || input.pathEnv.length === 0) return false;
  const delim = pathDelimiter(input.platform);
  const target = normalizeEntry(input.npmBinDir, input.platform);
  if (target.length === 0) return false;
  return input.pathEnv
    .split(delim)
    .map((p) => normalizeEntry(p, input.platform))
    .some((p) => p.length > 0 && p === target);
}

/**
 * Pick the shell rc file to mention for persistence on POSIX. zsh → ~/.zshrc;
 * otherwise stay generic (~/.bashrc or ~/.profile) since we cannot be certain.
 */
function posixRcHint(shell: string | undefined): string {
  if (typeof shell === 'string' && /zsh/i.test(shell)) {
    return '~/.zshrc';
  }
  return '~/.bashrc (or ~/.profile)';
}

/**
 * Returns a remediation hint string when the npm global bin dir is NOT
 * resolvable in the current PATH (or, on POSIX, when it IS present but a stale
 * shell command-hash cache may hide it), else null (no message needed).
 *
 * PURE: no I/O, no env reads, no spawning — all inputs injected.
 */
export function pathHint(input: PathHintInput): string | null {
  // Cannot resolve a confident hint without a bin dir.
  if (typeof input.npmBinDir !== 'string' || input.npmBinDir.trim().length === 0) {
    return null;
  }

  const onPath = isOnPath(input);
  const isWin = input.platform === 'win32';

  if (onPath) {
    if (isWin) {
      // PowerShell/cmd don't maintain a bash-style command-hash cache; a dir on
      // PATH resolves. Nothing actionable to print.
      return null;
    }
    // POSIX: dir is on PATH, but the running shell may have cached the command's
    // absence (hash table). `hash -r` clears it.
    return (
      `'${input.npmBinDir}' is on your PATH but your shell may have a stale ` +
      `command cache.\n` +
      `If 'wood-fired-tasks' / 'wft' / 'tasks' is "command not found", run:\n` +
      `  hash -r\n` +
      `(or open a new terminal).`
    );
  }

  // NOT on PATH.
  if (isWin) {
    return (
      `The install directory is not on this session's PATH:\n` +
      `  ${input.npmBinDir}\n` +
      `Refresh the current PowerShell session:\n` +
      `  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + ` +
      `[Environment]::GetEnvironmentVariable('Path','User')\n` +
      `cmd.exe users: open a new terminal.`
    );
  }

  const rc = posixRcHint(input.shell);
  return (
    `The npm global bin directory is not on your PATH:\n` +
    `  ${input.npmBinDir}\n` +
    `Add it for the current shell now:\n` +
    `  export PATH="${input.npmBinDir}:$PATH"\n` +
    `Persist it by adding that line to ${rc}, then 'source' it (or open a new terminal).`
  );
}

/**
 * Best-effort resolution of the npm global bin directory WITHOUT shelling out.
 *
 * Strategy (in order):
 *   1. `process.env.npm_config_prefix` (set during npm lifecycle scripts and
 *      when the user configured a prefix) → bin dir per platform convention.
 *   2. The location of the running module: a global install lands under
 *      `<prefix>/lib/node_modules/wood-fired-tasks` (POSIX) or
 *      `<prefix>/node_modules/wood-fired-tasks` (win32). Walk up to recover
 *      `<prefix>` and derive the bin dir.
 *
 * Returns null when it cannot resolve a prefix confidently (better to print no
 * hint than a misleading one).
 *
 * On POSIX the bin dir is `<prefix>/bin`; on win32 the global bins live in the
 * prefix directory itself.
 */
export function resolveNpmBinDir(opts?: {
  platform?: NodeJS.Platform;
  npmConfigPrefix?: string | undefined;
  moduleDir?: string;
}): string | null {
  const platform = opts?.platform ?? process.platform;
  // Distinguish "caller injected a prefix (possibly undefined to mean none)"
  // from "caller said nothing, read the env". `'npmConfigPrefix' in opts` is the
  // discriminator so tests can inject `undefined` to exercise the fallback path
  // without the ambient `npm_config_prefix` env leaking in.
  const npmConfigPrefix =
    opts !== undefined && 'npmConfigPrefix' in opts
      ? opts.npmConfigPrefix
      : process.env['npm_config_prefix'];

  const binFromPrefix = (prefix: string): string =>
    platform === 'win32' ? prefix : path.join(prefix, 'bin');

  // 1) Explicit prefix from the npm environment.
  if (typeof npmConfigPrefix === 'string' && npmConfigPrefix.trim().length > 0) {
    return binFromPrefix(npmConfigPrefix.trim());
  }

  // 2) Derive from the running module's location.
  let moduleDir = opts?.moduleDir;
  if (moduleDir === undefined) {
    try {
      moduleDir = path.dirname(fileURLToPath(import.meta.url));
    } catch {
      return null;
    }
  }

  // Find a `node_modules` segment and treat its parent as the prefix root.
  // POSIX: <prefix>/lib/node_modules/...  → parent of node_modules is `lib`,
  //        whose parent is <prefix>.
  // win32: <prefix>/node_modules/...      → parent of node_modules is <prefix>.
  const segments = moduleDir.split(/[/\\]+/);
  const nmIdx = segments.lastIndexOf('node_modules');
  if (nmIdx <= 0) return null;

  const parentOfNm = segments.slice(0, nmIdx).join(path.sep);
  if (parentOfNm.length === 0) return null;

  let prefix: string;
  if (platform === 'win32') {
    prefix = parentOfNm;
  } else {
    // Expect the parent of node_modules to be `lib`; strip it to get <prefix>.
    prefix = path.basename(parentOfNm) === 'lib' ? path.dirname(parentOfNm) : parentOfNm;
  }
  if (prefix.length === 0) return null;

  return binFromPrefix(prefix);
}

/**
 * Production convenience: resolve real inputs and return the hint (or null).
 * Never throws — wraps resolution defensively so callers (setup, postinstall)
 * can call it best-effort.
 */
export function resolvePathHint(): string | null {
  try {
    const npmBinDir = resolveNpmBinDir();
    if (npmBinDir === null) return null;
    return pathHint({
      platform: process.platform,
      pathEnv: process.env['PATH'],
      npmBinDir,
      shell: process.env['SHELL'],
    });
  } catch {
    return null;
  }
}
