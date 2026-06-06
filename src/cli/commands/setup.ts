import { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mergeClaudeJson, type ClaudeMcpServerEntry } from '../../setup/claude-json.js';
import { resolveAssetPath } from '../../assets/resolve.js';
import { configDir as defaultConfigDir } from '../../config/paths.js';
import { resolvePathHint } from '../util/path-hint.js';
import { buildNpmInvocation } from '../util/npm-spawn.js';

/**
 * `tasks setup` (task #737).
 *
 * Frictionless local install:
 *   (a) merge the LOCAL `wood-fired-tasks` stdio MCP entry into ~/.claude.json
 *       via mergeClaudeJson (#736) — atomic, idempotent.
 *   (b) copy packaged skills (resolved via the #730 asset resolver, NOT a
 *       cwd-relative path) into ~/.claude/commands/tasks/, idempotently.
 *   (c) optionally repair an EACCES-prone global npm prefix via
 *       --fix-npm-prefix (NEVER sudo).
 */

const SERVER_NAME = 'wood-fired-tasks';
/** Server key for the REMOTE bridge entry (task #738). */
const REMOTE_SERVER_NAME = 'wood-fired-tasks-remote';

/**
 * Resolve the local MCP server entry point. Prefer the built
 * `dist/mcp/index.js` under the package root (deterministic for published
 * installs); the resolver locates the package root from import.meta.url so the
 * path is stable regardless of CWD.
 */
export function resolveMcpEntryPoint(): string {
  return resolveAssetPath('dist', 'mcp', 'index.js');
}

/**
 * Build the deterministic LOCAL stdio MCP entry. Kept minimal so idempotency
 * holds across runs (no timestamps / random fields).
 */
export function buildLocalMcpEntry(): ClaudeMcpServerEntry {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [resolveMcpEntryPoint()],
    env: {},
  };
}

/**
 * Resolve the REMOTE MCP bridge entry point. Mirrors `resolveMcpEntryPoint()`
 * but targets the remote stdio bridge (`dist/mcp/remote/index.js`), which
 * proxies every MCP tool to the backend REST API over HTTP. Resolved via the
 * asset resolver so the path is stable regardless of CWD / global install.
 */
export function resolveRemoteMcpEntryPoint(): string {
  return resolveAssetPath('dist', 'mcp', 'remote', 'index.js');
}

/**
 * Build the deterministic REMOTE stdio MCP entry (task #738).
 *
 * Matches the LOCAL convention (`buildLocalMcpEntry`): a `type:'stdio'` server
 * that spawns the bridge entry point with the current Node binary. The remote
 * bridge reads its target + credentials from `WFT_API_URL` / `WFT_API_KEY` in
 * `env` (see `src/mcp/remote/index.ts#resolveRemoteConfig`), so those are the
 * only two env keys we set. Kept free of timestamps / random fields so the
 * merge stays idempotent across re-runs.
 */
export function buildRemoteMcpEntry(apiUrl: string, apiKey: string): ClaudeMcpServerEntry {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [resolveRemoteMcpEntryPoint()],
    env: {
      WFT_API_URL: apiUrl,
      WFT_API_KEY: apiKey,
    },
  };
}

/** Default destination for copied skills. */
export function commandsDestDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'commands', 'tasks');
}

/**
 * Absolute path of the cached PAT file under the OS CONFIG dir (task #738).
 *
 * The PAT is operator configuration — NOT persistent application state — so it
 * lives under `configDir` (env-paths, OS-correct), NEVER the data dir where the
 * SQLite DB lives. `configDir` is injectable so tests can sandbox it into a
 * temp directory.
 */
export function patCachePath(configDir: string = defaultConfigDir): string {
  return path.join(configDir, 'remote-token');
}

export interface CachePatResult {
  /** Absolute path the PAT was written to. */
  path: string;
  /** True when the file content changed this run (idempotency signal). */
  changed: boolean;
}

/**
 * Cache the remote PAT to a file under the CONFIG dir, idempotently. On POSIX
 * the file is created/tightened to 0600 (owner read/write only) so the secret
 * is not world-readable; on Windows the mode arg is a best-effort no-op (NTFS
 * ACLs already restrict the per-user config dir).
 */
export function cachePat(token: string, configDir: string = defaultConfigDir): CachePatResult {
  const filePath = patCachePath(configDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  const changed = existing !== token;

  if (changed) {
    fs.writeFileSync(filePath, token, { encoding: 'utf8', mode: 0o600 });
  }
  // Tighten perms on POSIX even when bytes were unchanged (defensive). chmod is
  // a best-effort no-op semantically on Windows; guard so it never throws.
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort: never block setup on a chmod failure */
    }
  }

  return { path: filePath, changed };
}

export interface CopySkillsResult {
  sourceDir: string;
  destDir: string;
  /** Files written (changed) this run. */
  written: string[];
  /** All skill files considered (basename). */
  files: string[];
}

/**
 * Copy every `*.md` skill from the asset-resolver source into destDir.
 * Idempotent: a file is only (re)written when its bytes differ.
 */
export function copySkills(
  destDir: string = commandsDestDir(),
  sourceDir: string = resolveAssetPath('dist', 'skills', 'tasks'),
): CopySkillsResult {
  const written: string[] = [];
  const files: string[] = [];

  const entries = fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir).filter((f) => f.endsWith('.md'))
    : [];

  fs.mkdirSync(destDir, { recursive: true });

  for (const name of entries.sort()) {
    files.push(name);
    const srcPath = path.join(sourceDir, name);
    const destPath = path.join(destDir, name);
    const srcBytes = fs.readFileSync(srcPath);
    let needsWrite = true;
    if (fs.existsSync(destPath)) {
      const destBytes = fs.readFileSync(destPath);
      needsWrite = !srcBytes.equals(destBytes);
    }
    if (needsWrite) {
      fs.writeFileSync(destPath, srcBytes);
      written.push(name);
    }
  }

  return { sourceDir, destDir, written, files };
}

/** Default destination for copied agent/subagent definitions. */
export function agentsDestDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'agents');
}

export interface CopyAgentsResult {
  sourceDir: string;
  destDir: string;
  /** Files written (changed) this run. */
  written: string[];
  /** All agent files considered (basename). */
  files: string[];
}

/**
 * Basenames excluded from the agents copy. `README.md` is authoring docs that
 * only make sense inside the repo, not a shipped subagent definition (task
 * #751). Mirrors the build-skills.ts exclusion.
 */
const AGENTS_EXCLUDE = new Set(['README.md']);

/**
 * Copy every shipped `*.md` subagent definition from the asset-resolver source
 * into destDir (~/.claude/agents/), excluding README.md. These back the
 * mandatory verifier in /tasks:loop and /tasks:loop-dag. Source is resolved via
 * the #730 asset resolver (NOT a cwd-relative path); behavior exactly mirrors
 * copySkills. Idempotent: a file is only (re)written when its bytes differ.
 */
export function copyAgents(
  destDir: string = agentsDestDir(),
  sourceDir: string = resolveAssetPath('dist', 'skills', 'agents'),
): CopyAgentsResult {
  const written: string[] = [];
  const files: string[] = [];

  const entries = fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir).filter((f) => f.endsWith('.md') && !AGENTS_EXCLUDE.has(f))
    : [];

  fs.mkdirSync(destDir, { recursive: true });

  for (const name of entries.sort()) {
    files.push(name);
    const srcPath = path.join(sourceDir, name);
    const destPath = path.join(destDir, name);
    const srcBytes = fs.readFileSync(srcPath);
    let needsWrite = true;
    if (fs.existsSync(destPath)) {
      const destBytes = fs.readFileSync(destPath);
      needsWrite = !srcBytes.equals(destBytes);
    }
    if (needsWrite) {
      fs.writeFileSync(destPath, srcBytes);
      written.push(name);
    }
  }

  return { sourceDir, destDir, written, files };
}

export interface FixNpmPrefixOptions {
  /** Override HOME (testing). */
  home?: string;
  /** Injectable runner so tests can assert the command without executing npm. */
  runner?: (cmd: string, args: string[]) => void;
  /** Injectable logger (testing). */
  log?: (line: string) => void;
}

export interface FixNpmPrefixResult {
  prefix: string;
  binDir: string;
  /** Guidance lines emitted to the user. */
  guidance: string[];
}

/**
 * Compute and advise a user-writable npm global prefix (~/.npm-global) so that
 * `npm i -g` never hits EACCES and NEVER requires sudo.
 *
 * The runner (defaults to `npm config set prefix <dir>`) is injectable so the
 * unit test can assert behavior without mutating real npm config. This function
 * MUST NOT invoke sudo / runas / pkexec / doas under any circumstances.
 */
export function fixNpmPrefix(options: FixNpmPrefixOptions = {}): FixNpmPrefixResult {
  const home = options.home ?? os.homedir();
  const log = options.log ?? ((line: string) => console.log(line));
  const runner =
    options.runner ??
    ((cmd: string, args: string[]) => {
      // Hard guard: never elevate.
      if (/^(sudo|runas|pkexec|doas)$/i.test(cmd)) {
        throw new Error('refusing to run elevated command');
      }
      // Windows-safe npm invocation (task #794): npm is `npm.cmd`, which since
      // CVE-2024-27980 cannot be spawned without a shell (EINVAL), and the
      // prefix arg can contain spaces (e.g. C:\Users\John Doe\.npm-global)
      // which a naive `shell:true` would split. buildNpmInvocation handles both
      // by quoting per-arg for the win32 shell. Non-npm commands (none today)
      // fall through to a plain shell-less exec.
      if (cmd === 'npm') {
        const inv = buildNpmInvocation(args);
        execFileSync(inv.command, inv.args, { stdio: 'inherit', shell: inv.shell });
        return;
      }
      execFileSync(cmd, args, { stdio: 'inherit' });
    });

  const prefix = path.join(home, '.npm-global');
  const binDir = path.join(prefix, 'bin');

  fs.mkdirSync(binDir, { recursive: true });

  // Apply via npm (injectable). npm itself needs no elevation for a user dir.
  runner('npm', ['config', 'set', 'prefix', prefix]);

  const guidance = [
    `Set npm global prefix to ${prefix} (no elevation required).`,
    `Add this to your shell profile so globally-installed CLIs are on PATH:`,
    `  export PATH="${binDir}:$PATH"`,
    `Then re-run: npm install -g wood-fired-tasks`,
  ];
  for (const line of guidance) log(line);

  return { prefix, binDir, guidance };
}

export interface RunSetupOptions {
  /** Override HOME root (testing). Defaults to os.homedir(). */
  home?: string;
  fixNpmPrefix?: boolean;
  /** Injectable runner forwarded to fixNpmPrefix. */
  npmRunner?: (cmd: string, args: string[]) => void;
  log?: (line: string) => void;
  /**
   * Remote REST API base URL (task #738). When set, the REMOTE bridge entry
   * (`wood-fired-tasks-remote`) is written instead of the local one, carrying
   * `WFT_API_URL` / `WFT_API_KEY`.
   */
  remote?: string;
  /** Remote PAT (task #738). Cached under the CONFIG dir; never the data dir. */
  token?: string;
  /**
   * Override the OS CONFIG dir (testing). Defaults to the real `configDir`.
   * Only the PAT cache is directed here — skills/claude.json follow `home`.
   */
  configDir?: string;
}

export interface RunSetupResult {
  claudeJsonPath: string;
  claudeJsonChanged: boolean;
  /** The MCP server key written this run ('wood-fired-tasks[-remote]'). */
  serverName: string;
  /** True when the remote bridge entry was written (vs the local entry). */
  remote: boolean;
  skills: CopySkillsResult;
  agents: CopyAgentsResult;
  npmPrefix?: FixNpmPrefixResult;
  /** Set when a PAT was cached (i.e. `remote` + `token` provided). */
  patCache?: CachePatResult;
}

/**
 * Pure-ish setup action. Resolves all paths from `home` so tests can sandbox
 * with a temp HOME and never touch the real ~/.claude.json or ~/.claude/.
 */
export function runSetup(options: RunSetupOptions = {}): RunSetupResult {
  const home = options.home ?? os.homedir();
  const log = options.log ?? ((line: string) => console.log(line));

  const claudeJsonPath = path.join(home, '.claude.json');

  // Task #738: when a remote URL is supplied, write the REMOTE bridge entry
  // (carrying WFT_API_URL/WFT_API_KEY) under 'wood-fired-tasks-remote' instead
  // of the local stdio entry. A token is required to author a usable entry.
  const isRemote = typeof options.remote === 'string' && options.remote.length > 0;
  let patCache: CachePatResult | undefined;
  let serverName: string;
  let merge: ReturnType<typeof mergeClaudeJson>;

  if (isRemote) {
    const apiUrl = options.remote as string;
    const token = options.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(
        '--remote requires --token <pat> so WFT_API_KEY can be set on the ' + 'remote MCP entry.',
      );
    }
    serverName = REMOTE_SERVER_NAME;
    merge = mergeClaudeJson({
      filePath: claudeJsonPath,
      serverName: REMOTE_SERVER_NAME,
      entry: buildRemoteMcpEntry(apiUrl, token),
    });
    log(
      !merge.unchanged
        ? `Installed remote MCP server '${REMOTE_SERVER_NAME}' into ${claudeJsonPath}`
        : `Remote MCP server '${REMOTE_SERVER_NAME}' already present in ${claudeJsonPath}`,
    );

    // Cache the PAT under the CONFIG dir (NOT the data dir).
    patCache = cachePat(token, options.configDir);
    log(
      patCache.changed
        ? `Cached remote PAT at ${patCache.path}`
        : `Remote PAT already cached at ${patCache.path}`,
    );
  } else {
    serverName = SERVER_NAME;
    merge = mergeClaudeJson({
      filePath: claudeJsonPath,
      serverName: SERVER_NAME,
      entry: buildLocalMcpEntry(),
    });
    log(
      !merge.unchanged
        ? `Installed local MCP server '${SERVER_NAME}' into ${claudeJsonPath}`
        : `Local MCP server '${SERVER_NAME}' already present in ${claudeJsonPath}`,
    );
  }

  // Task #752: ~/.claude.json can carry the local-credentials PAT and the
  // remote WFT_API_KEY env, so tighten it to owner-only (0600) on POSIX after
  // the merge writes it. Best-effort + guarded so a chmod failure (e.g. an
  // exotic FS, or Windows where mode is a no-op) never blocks setup. On Windows
  // the per-user profile dir is already ACL-restricted, so this is a documented
  // no-op there.
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(claudeJsonPath, 0o600);
    } catch {
      /* best-effort: never block setup on a chmod failure */
    }
  }

  const skills = copySkills(commandsDestDir(home));
  log(
    skills.written.length > 0
      ? `Copied ${skills.written.length} skill(s) into ${skills.destDir}`
      : `Skills already up to date in ${skills.destDir}`,
  );

  const agents = copyAgents(agentsDestDir(home));
  log(
    agents.written.length > 0
      ? `Copied ${agents.written.length} agent(s) into ${agents.destDir}`
      : `Agents already up to date in ${agents.destDir}`,
  );

  let npmPrefix: FixNpmPrefixResult | undefined;
  if (options.fixNpmPrefix) {
    npmPrefix = fixNpmPrefix({
      home,
      ...(options.npmRunner !== undefined && { runner: options.npmRunner }),
      log,
    });
  }

  // Task #792: best-effort PATH remediation hint. If the npm global bin dir is
  // not resolvable on the current PATH (or a POSIX shell may have a stale
  // command-hash cache), print the exact one-liner to fix it. Non-fatal: a
  // child process cannot mutate the parent shell's PATH, so this is advice only.
  try {
    const hint = resolvePathHint();
    if (hint !== null) log(hint);
  } catch {
    /* best-effort: never block setup on a hint failure */
  }

  return {
    claudeJsonPath,
    claudeJsonChanged: !merge.unchanged,
    serverName,
    remote: isRemote,
    skills,
    agents,
    ...(npmPrefix !== undefined && { npmPrefix }),
    ...(patCache !== undefined && { patCache }),
  };
}

export const setupCommand = new Command('setup')
  .description(
    'Install the local wood-fired-tasks MCP server into ~/.claude.json, copy skills into ~/.claude/commands/tasks/, and copy subagent definitions into ~/.claude/agents/',
  )
  .option(
    '--fix-npm-prefix',
    'Configure a user-writable npm global prefix (~/.npm-global) to avoid EACCES on `npm i -g` (never uses sudo)',
  )
  .option(
    '--remote <url>',
    'Install the remote MCP bridge (wood-fired-tasks-remote) pointed at the given REST API base URL; requires --token',
  )
  .option(
    '--token <pat>',
    'Personal access token for --remote; written to the remote MCP entry (WFT_API_KEY) and cached under the OS config dir',
  )
  .action((opts: { fixNpmPrefix?: boolean; remote?: string; token?: string }) => {
    // `--token` is ALSO a global option on the root program (src/cli/bin/tasks.ts),
    // registered for Bearer-auth override. When a user runs
    // `setup --remote <url> --token <pat>`, Commander binds `--token` to the
    // global program, so `opts.token` here is undefined. Fall back to the
    // global value via optsWithGlobals() so `--token` works regardless of which
    // scope Commander attaches it to.
    const globalOpts = setupCommand.parent?.optsWithGlobals() ?? {};
    const token =
      typeof opts.token === 'string' && opts.token.length > 0
        ? opts.token
        : (globalOpts['token'] as string | undefined);
    runSetup({
      fixNpmPrefix: Boolean(opts.fixNpmPrefix),
      ...(opts.remote !== undefined && { remote: opts.remote }),
      ...(token !== undefined && { token }),
    });
  });
