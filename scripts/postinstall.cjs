#!/usr/bin/env node
/**
 * postinstall notice (task #752).
 *
 * Prints ONE line pointing the user at `wood-fired-tasks setup`. That is the
 * entire contract: NO file writes, NO network, NO mutation of ~/.claude.json or
 * any other state. All real installation work is done explicitly by the user
 * running `wood-fired-tasks setup` (idempotent, inspectable) — postinstall must
 * stay a pure stdout notice so `npm install` is never surprising or
 * side-effecting.
 *
 * `.cjs` (not `.js`) so it runs as CommonJS regardless of the package's
 * `"type": "module"`, and so npm can execute it directly with `node`.
 *
 * Skipped silently in CI by convention is NOT done here on purpose — a single
 * println is cheap and harmless everywhere.
 */
process.stdout.write(
  'wood-fired-tasks installed. Run `wood-fired-tasks setup` to register the ' +
    'MCP server and copy skills into ~/.claude.\n',
);

/**
 * Task #792: PATH remediation hint.
 *
 * After `npm i -g`, the npm global bin dir may not be on the CURRENT shell's
 * PATH (needs a new shell), or — on POSIX — may be on PATH but hidden by a
 * stale command-hash cache. A child process can't mutate the parent shell's
 * PATH, but we can DETECT and print the exact fix.
 *
 * This is a SELF-CONTAINED mirror of `src/cli/util/path-hint.ts` rather than an
 * import of the ESM dist helper. postinstall.cjs is CommonJS and must (#752)
 * stay self-contained + side-effect-free, and must run even if `dist/` is weird
 * or absent — importing the built helper would couple this to a successful
 * build and to ESM/CJS interop. The logic is short, so we inline it and keep
 * the two copies in sync. Everything is wrapped in try/catch so a hint failure
 * NEVER breaks `npm install` (postinstall must always exit 0).
 */
try {
  const path = require('node:path');
  const platform = process.platform;
  const isWin = platform === 'win32';

  /** Resolve the npm global bin dir without shelling out (no npm/which/where). */
  function resolveNpmBinDir() {
    const binFromPrefix = (prefix) => (isWin ? prefix : path.join(prefix, 'bin'));
    const prefixEnv = process.env.npm_config_prefix;
    if (typeof prefixEnv === 'string' && prefixEnv.trim().length > 0) {
      return binFromPrefix(prefixEnv.trim());
    }
    // Derive from this module's location: a global install lands under
    // <prefix>/lib/node_modules/wood-fired-tasks (POSIX) or
    // <prefix>/node_modules/wood-fired-tasks (win32).
    const segments = __dirname.split(/[/\\]+/);
    const nmIdx = segments.lastIndexOf('node_modules');
    if (nmIdx <= 0) return null;
    const parentOfNm = segments.slice(0, nmIdx).join(path.sep);
    if (parentOfNm.length === 0) return null;
    let prefix;
    if (isWin) {
      prefix = parentOfNm;
    } else {
      prefix = path.basename(parentOfNm) === 'lib' ? path.dirname(parentOfNm) : parentOfNm;
    }
    if (prefix.length === 0) return null;
    return binFromPrefix(prefix);
  }

  function normalizeEntry(entry) {
    let e = entry.trim().replace(/[/\\]+$/, '');
    if (isWin) e = e.toLowerCase();
    return e;
  }

  function isOnPath(npmBinDir) {
    const pathEnv = process.env.PATH;
    if (typeof pathEnv !== 'string' || pathEnv.length === 0) return false;
    const delim = isWin ? ';' : ':';
    const target = normalizeEntry(npmBinDir);
    if (target.length === 0) return false;
    return pathEnv
      .split(delim)
      .map(normalizeEntry)
      .some((p) => p.length > 0 && p === target);
  }

  function pathHint(npmBinDir) {
    if (typeof npmBinDir !== 'string' || npmBinDir.trim().length === 0) return null;
    const onPath = isOnPath(npmBinDir);
    if (onPath) {
      if (isWin) return null;
      return (
        `'${npmBinDir}' is on your PATH but your shell may have a stale ` +
        `command cache.\n` +
        `If 'wood-fired-tasks' / 'wft' / 'tasks' is "command not found", run:\n` +
        `  hash -r\n` +
        `(or open a new terminal).`
      );
    }
    if (isWin) {
      return (
        `The install directory is not on this session's PATH:\n` +
        `  ${npmBinDir}\n` +
        `Refresh the current PowerShell session:\n` +
        `  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + ` +
        `[Environment]::GetEnvironmentVariable('Path','User')\n` +
        `cmd.exe users: open a new terminal.`
      );
    }
    const shell = process.env.SHELL;
    const rc =
      typeof shell === 'string' && /zsh/i.test(shell) ? '~/.zshrc' : '~/.bashrc (or ~/.profile)';
    return (
      `The npm global bin directory is not on your PATH:\n` +
      `  ${npmBinDir}\n` +
      `Add it for the current shell now:\n` +
      `  export PATH="${npmBinDir}:$PATH"\n` +
      `Persist it by adding that line to ${rc}, then 'source' it (or open a new terminal).`
    );
  }

  const npmBinDir = resolveNpmBinDir();
  if (npmBinDir !== null) {
    const hint = pathHint(npmBinDir);
    if (hint !== null) process.stdout.write(hint + '\n');
  }
} catch {
  /* best-effort: a PATH hint must NEVER fail `npm install`. */
}
