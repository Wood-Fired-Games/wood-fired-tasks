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
import { selectFromMenu, promptSecret, type PromptIO } from '../util/prompt.js';
import { shouldPrompt } from '../prompts/interactive.js';
import { getServiceBackend } from './service.js';
import { runDeviceLogin } from './login.js';
import { writeCredentials } from '../auth/credentials.js';

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
 * Build the deterministic REMOTE stdio MCP entry (task #738; URL-only since
 * #810).
 *
 * Matches the LOCAL convention (`buildLocalMcpEntry`): a `type:'stdio'` server
 * that spawns the bridge entry point with the current Node binary. The entry
 * carries ONLY `WFT_API_URL` — NO token is persisted in claude.json. The
 * bridge resolves its bearer token at runtime via `resolveRemoteConfig`
 * (env `WFT_API_KEY` → the CLI credentials TOML file written by
 * `tasks login` / `tasks setup`), so the secret never lands in claude.json.
 * Kept free of timestamps / random fields so the merge stays idempotent
 * across re-runs.
 */
export function buildRemoteMcpEntry(apiUrl: string): ClaudeMcpServerEntry {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [resolveRemoteMcpEntryPoint()],
    env: {
      WFT_API_URL: apiUrl,
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

/**
 * Absolute path of Claude Code's user settings file, `~/.claude/settings.json`
 * (task #798). `home` is injectable so tests sandbox a temp HOME and NEVER touch
 * the real settings.json — mirroring how the rest of setup.ts is HOME-rooted.
 */
export function settingsJsonPath(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json');
}

/**
 * The exact `statusLine` block setup writes into `settings.json` when none
 * exists. A SINGLE wiring covers BOTH status-line segments — the linked-project
 * task counts AND the update-available hint — because both are rendered by the
 * one `tasks statusline` command (#597). The update segment's own disable
 * controls (`WFT_NO_UPDATE_CHECK` / the `update_check = false` config flag,
 * #797) are honored by that command at render time; this wiring does not need to
 * re-encode them.
 *
 * Kept free of timestamps / random fields so the write is byte-stable and the
 * idempotency check in {@link wireStatusline} holds across re-runs.
 */
export function buildStatuslineConfig(): {
  type: 'command';
  command: string;
  padding: number;
} {
  return { type: 'command', command: 'tasks statusline', padding: 0 };
}

/**
 * One-line embed snippet PRINTED (never auto-applied) when `settings.json`
 * already carries a `statusLine`. Non-clobbering contract: we refuse to
 * overwrite an existing status line, so we hand the user the exact command to
 * splice into their own segment instead.
 */
export function statuslineEmbedSnippet(): string {
  return 'tasks statusline';
}

/** Discriminated outcome of {@link wireStatusline}. */
export type WireStatuslineResult =
  | {
      /** No `statusLine` existed and consent was given → setup wrote one. */
      action: 'written';
      path: string;
      /** True when bytes actually changed (false on an idempotent re-run). */
      changed: boolean;
    }
  | {
      /** A `statusLine` already existed → we printed the embed snippet only. */
      action: 'embed-snippet';
      path: string;
      snippet: string;
    }
  | {
      /** The user declined the offer → nothing was read or written. */
      action: 'declined';
      path: string;
    };

export interface WireStatuslineOptions {
  /** Override HOME root (testing). Defaults to os.homedir(). */
  home?: string;
  /** Injectable logger (testing). */
  log?: (line: string) => void;
}

/**
 * Non-clobbering wiring of `tasks statusline` into `~/.claude/settings.json`
 * (task #798).
 *
 *  - No existing `statusLine` → write {@link buildStatuslineConfig} into the
 *    file (preserving every other key), atomically, idempotently.
 *  - Existing `statusLine` → PRINT the embed snippet and DO NOT modify the file.
 *
 * This is the post-consent action; the opt-in/opt-out prompt is owned by
 * {@link offerStatuslineWiring}. Uses the same temp-HOME-safe, atomic-write
 * (tmp + rename), idempotent (skip write when bytes are identical) patterns as
 * the rest of setup.ts.
 */
export function wireStatusline(options: WireStatuslineOptions = {}): WireStatuslineResult {
  const home = options.home ?? os.homedir();
  const log = options.log ?? ((line: string) => console.log(line));
  const filePath = settingsJsonPath(home);

  // Read the existing settings.json, tolerating absence / malformed JSON. An
  // absent file means "write a fresh statusLine on consent"; a present but
  // UNPARSEABLE file is left untouched (handled below) so we never clobber a
  // user's hand-rolled-but-broken config.
  const existingRaw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  let parsed: Record<string, unknown> = {};
  let parseable = true;
  if (existingRaw !== null) {
    try {
      const doc = JSON.parse(existingRaw);
      if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
        parsed = doc as Record<string, unknown>;
      }
    } catch {
      parseable = false;
    }
  }

  const ours = buildStatuslineConfig();

  // Non-clobbering for an UNPARSEABLE existing file: we cannot safely merge into
  // JSON we can't read, and overwriting it would silently discard the user's
  // (broken-but-recoverable) config. Print the embed snippet and write nothing.
  if (existingRaw !== null && !parseable) {
    log(
      `Could not parse ${filePath} as JSON; leaving it untouched. ` +
        'To show Wood Fired Tasks counts + the update hint, fix the file and ' +
        'embed this command in your status line:',
    );
    log(`  ${statuslineEmbedSnippet()}`);
    return { action: 'embed-snippet', path: filePath, snippet: statuslineEmbedSnippet() };
  }

  // Non-clobbering — with one exception for OUR OWN wiring (idempotency). A
  // present statusLine in a parseable doc is never overwritten, UNLESS it is
  // byte-identical to the config we'd write (i.e. a previous consented run
  // already wired it). In that case we report an idempotent no-op `written`
  // rather than re-printing the embed snippet on every re-run.
  if (parseable && parsed['statusLine'] !== undefined) {
    const isOurs = JSON.stringify(parsed['statusLine']) === JSON.stringify(ours);
    if (isOurs) {
      log(`statusLine already wired to \`tasks statusline\` in ${filePath}`);
      return { action: 'written', path: filePath, changed: false };
    }
    log(
      'A statusLine is already configured in ' +
        `${filePath}; leaving it untouched. To show Wood Fired Tasks ` +
        'counts + the update hint, embed this command in your status line:',
    );
    log(`  ${statuslineEmbedSnippet()}`);
    return { action: 'embed-snippet', path: filePath, snippet: statuslineEmbedSnippet() };
  }

  // No statusLine present in a parseable (or absent) doc: write a fresh
  // statusLine, preserving any other keys from a parseable doc.
  parsed['statusLine'] = ours;
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;

  // Idempotency: identical bytes → skip the write entirely.
  if (existingRaw !== null && existingRaw === serialized) {
    log(`statusLine already wired to \`tasks statusline\` in ${filePath}`);
    return { action: 'written', path: filePath, changed: false };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, serialized, 'utf8');
  fs.renameSync(tmpPath, filePath);
  log(`Wired \`tasks statusline\` into ${filePath} (statusLine)`);
  return { action: 'written', path: filePath, changed: true };
}

/**
 * Injectable yes/no consent seam for the status-line offer (task #798).
 * Defaults to a Yes/No menu via {@link selectFromMenu}, reusing the same prompt
 * IO seam the mode menu uses so tests drive it without a real TTY.
 */
export type ConfirmStatusline = (io?: PromptIO) => Promise<boolean>;

/** Default Yes/No consent prompt for the status-line offer. */
export function confirmStatuslineWiring(io?: PromptIO): Promise<boolean> {
  return selectFromMenu<boolean>(
    {
      message: 'Show Wood Fired Tasks counts + update hint in your Claude Code status line?',
      options: [
        { label: 'Yes — wire `tasks statusline` into settings.json', value: true },
        { label: 'No — skip (no change)', value: false },
      ],
      defaultValue: false,
    },
    io,
  );
}

export interface OfferStatuslineOptions extends WireStatuslineOptions {
  /**
   * Injectable consent prompt (defaults to {@link confirmStatuslineWiring}).
   * Tests stub this to drive the consent / decline branches.
   */
  confirm?: ConfirmStatusline;
  /** Prompt IO forwarded to the consent menu (tests inject streams). */
  promptIO?: PromptIO;
  /**
   * Injectable TTY predicate (defaults to {@link shouldPrompt}). On a non-TTY
   * the offer is silently skipped (declined) so setup never blocks.
   */
  isInteractive?: () => boolean;
}

/**
 * OPT-IN offer to wire `tasks statusline` into `settings.json` (task #798).
 *
 *  - Non-interactive (no TTY) → skip silently, return `declined` (never hang).
 *  - Declining the offer → no read, no write, return `declined`.
 *  - Consenting → delegate to {@link wireStatusline} (writes a fresh statusLine
 *    OR prints the embed snippet when one already exists — non-clobbering).
 */
export async function offerStatuslineWiring(
  options: OfferStatuslineOptions = {},
): Promise<WireStatuslineResult> {
  const home = options.home ?? os.homedir();
  const isInteractive = options.isInteractive ?? shouldPrompt;
  const confirm = options.confirm ?? confirmStatuslineWiring;

  // Non-TTY: never prompt, never write. Honors the opt-in contract — silence
  // means no change.
  if (!isInteractive()) {
    return { action: 'declined', path: settingsJsonPath(home) };
  }

  const consented = await confirm(options.promptIO);
  if (!consented) {
    return { action: 'declined', path: settingsJsonPath(home) };
  }

  return wireStatusline({
    home,
    ...(options.log !== undefined && { log: options.log }),
  });
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
      entry: buildRemoteMcpEntry(apiUrl),
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

/**
 * Write ONLY the URL-only remote MCP bridge entry into ~/.claude.json (and copy
 * skills/agents), WITHOUT requiring or caching a PAT (task #808).
 *
 * This is the device-flow counterpart to {@link runSetup}'s remote branch:
 * after {@link runDeviceLogin} (#806) has self-provisioned the PAT and persisted
 * it via the credentials writer, there is no token to embed or double-cache —
 * the claude.json entry must be URL-only (#810). So this helper mirrors
 * runSetup's claude.json/skills/agents work but deliberately OMITS the
 * `--token`-required guard and the `cachePat` step.
 *
 * The written entry is exactly `buildRemoteMcpEntry(apiUrl)`: a stdio bridge
 * carrying only `WFT_API_URL`. The bridge resolves its bearer token at runtime
 * from the credentials file the device flow wrote.
 */
export function writeRemoteMcpEntryOnly(options: RunSetupOptions = {}): RunSetupResult {
  const home = options.home ?? os.homedir();
  const log = options.log ?? ((line: string) => console.log(line));

  const apiUrl = options.remote;
  if (typeof apiUrl !== 'string' || apiUrl.length === 0) {
    throw new Error('writeRemoteMcpEntryOnly requires a --remote <url> base URL.');
  }

  const claudeJsonPath = path.join(home, '.claude.json');

  // URL-only entry (#810) — no token is ever written into claude.json.
  const merge = mergeClaudeJson({
    filePath: claudeJsonPath,
    serverName: REMOTE_SERVER_NAME,
    entry: buildRemoteMcpEntry(apiUrl),
  });
  log(
    !merge.unchanged
      ? `Installed remote MCP server '${REMOTE_SERVER_NAME}' into ${claudeJsonPath}`
      : `Remote MCP server '${REMOTE_SERVER_NAME}' already present in ${claudeJsonPath}`,
  );

  // ~/.claude.json may carry other credentials, so tighten to 0600 on POSIX
  // (mirrors runSetup). Best-effort + guarded so a chmod failure never blocks.
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

  return {
    claudeJsonPath,
    claudeJsonChanged: !merge.unchanged,
    serverName: REMOTE_SERVER_NAME,
    remote: true,
    skills,
    agents,
  };
}

/**
 * The three top-level setup modes (task #805). `local` is the back-compat
 * default; `service` installs the user-scoped background service; `remote`
 * onboards against a remote REST API (full device-flow self-provisioning lands
 * in #807/#808/#809 — this task only routes to a minimal entry).
 */
export type SetupMode = 'local' | 'service' | 'remote';

/**
 * Coarse OIDC subsystem state reported by `GET /health/detailed` (task #357).
 * Mirrors the server's `oidc.state` enum so the remote-setup branch selector
 * (#807) can route deterministically.
 */
export type OidcState = 'ready' | 'disabled' | 'degraded';

/**
 * Onboarding methods `setup --remote` can choose between, derived from the
 * server's probed OIDC state.
 *  - `device-flow` → RFC 8628 browser login via {@link runDeviceLogin}.
 *  - `manual-pat`  → paste / `--token` a PAT and persist it.
 */
export type RemoteOnboardingMethod = 'device-flow' | 'manual-pat';

/**
 * Result of probing `GET /health/detailed` for the OIDC state.
 *  - `{ ok: true, oidc }` — the probe returned 2xx and an `oidc.state`.
 *  - `{ ok: false, reason }` — network error / non-2xx / unparseable body.
 *    The `reason` is surfaced to the user before falling back to manual PAT.
 */
export type OidcProbeResult = { ok: true; oidc: OidcState } | { ok: false; reason: string };

/** Injectable probe signature so tests can drive each branch without a server. */
export type OidcProbe = (baseUrl: string) => Promise<OidcProbeResult>;

/**
 * Default OIDC probe: `GET <baseUrl>/health/detailed` and read `oidc.state`.
 *
 * `/health/detailed` is auth-protected on the server (Bearer PAT), but the only
 * field we need — `oidc.state` — is returned in the JSON body regardless of the
 * auth-derived status code as long as the route renders. We treat ANY non-2xx
 * or unparseable/missing `oidc.state` as a probe failure and fall back to the
 * manual-PAT escape hatch (the route may not even exist on an older server).
 * Bounded by a 5s timeout so a half-open server can't hang `setup --remote`.
 */
export async function probeOidcState(baseUrl: string): Promise<OidcProbeResult> {
  const probeUrl = new URL('/health/detailed', baseUrl).toString();
  let response: Response;
  try {
    response = await fetch(probeUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `could not reach ${probeUrl}: ${message}` };
  }

  if (!response.ok) {
    return { ok: false, reason: `${probeUrl} returned HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: `${probeUrl} returned a non-JSON body` };
  }

  const oidc = (body as { oidc?: { state?: unknown } } | null)?.oidc?.state;
  if (oidc === 'ready' || oidc === 'disabled' || oidc === 'degraded') {
    return { ok: true, oidc };
  }
  return { ok: false, reason: `${probeUrl} did not report an oidc.state` };
}

/**
 * Map a probe outcome to the onboarding method (task #807).
 *  - `ready`    → device-flow.
 *  - `disabled` → manual-PAT (the server has no browser login).
 *  - `degraded` → manual-PAT (OIDC is configured but discovery is failing; the
 *    device flow would fail, so offer the manual path after informing the user).
 *  - probe failure → manual-PAT (connectivity escape hatch).
 */
export function selectRemoteOnboardingMethod(probe: OidcProbeResult): RemoteOnboardingMethod {
  if (!probe.ok) return 'manual-pat';
  return probe.oidc === 'ready' ? 'device-flow' : 'manual-pat';
}

/**
 * The minimal identity envelope `GET /api/v1/me` returns (task #809). Mirrors
 * the fields {@link writeCredentials} needs so a manually-pasted PAT lands in
 * the SAME credentials file the device flow writes — the bridge then resolves
 * its bearer token from there at runtime (URL-only claude.json entry, #810).
 */
export interface ManualPatIdentity {
  id: number;
  displayName: string;
  email: string | null;
  /** Best-effort token rowid; defaults to 1 when the server omits it. */
  tokenId?: number;
}

/**
 * Outcome of persisting a manually-supplied PAT (task #809).
 *  - `{ ok: true, identity }`  — the PAT validated and credentials were written.
 *  - `{ ok: false, reason }`   — the PAT was rejected / unreachable; `reason`
 *    is surfaced to the user and NOTHING is persisted.
 */
export type ManualPatPersistResult =
  | { ok: true; identity: ManualPatIdentity }
  | { ok: false; reason: string };

/** Injectable manual-PAT persistence seam so tests drive it without a server. */
export type ManualPatPersist = (baseUrl: string, token: string) => Promise<ManualPatPersistResult>;

/**
 * Default manual-PAT persistence (task #809).
 *
 * Validate the pasted PAT against `GET <baseUrl>/api/v1/me` (the same identity
 * envelope `tasks whoami` reads), then persist it through {@link writeCredentials}
 * — the SAME credentials writer {@link runDeviceLogin} uses. This is the only
 * place the manual PAT lands; the claude.json entry stays URL-only (#810) and
 * the bridge resolves the bearer token from this credentials file at runtime,
 * so the secret is never embedded in claude.json.
 *
 * A non-2xx / network failure returns `{ ok: false, reason }` and writes
 * NOTHING — the caller reports the reason and exits without a half-configured
 * install.
 */
export async function persistManualPat(
  baseUrl: string,
  token: string,
): Promise<ManualPatPersistResult> {
  const meUrl = new URL('/api/v1/me', baseUrl).toString();
  let response: Response;
  try {
    response = await fetch(meUrl, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `could not reach ${meUrl}: ${message}` };
  }

  if (response.status === 401) {
    return { ok: false, reason: 'the personal access token was rejected (HTTP 401)' };
  }
  if (!response.ok) {
    return { ok: false, reason: `${meUrl} returned HTTP ${response.status}` };
  }

  let body: { id?: unknown; displayName?: unknown; email?: unknown } | null;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, reason: `${meUrl} returned a non-JSON body` };
  }

  if (body === null || typeof body.id !== 'number' || typeof body.displayName !== 'string') {
    return { ok: false, reason: `${meUrl} did not return a usable identity` };
  }
  const email = typeof body.email === 'string' ? body.email : null;
  const identity: ManualPatIdentity = { id: body.id, displayName: body.displayName, email };

  // Persist through the SAME credentials writer the device flow uses. The
  // server's /me envelope does not carry the token rowid, so default token_id
  // to 1 (a positive int, satisfying the credentials schema); `whoami`'s
  // best-effort token enrichment degrades gracefully when it can't match it.
  try {
    writeCredentials({
      active: {
        token,
        token_id: 1,
        server: baseUrl,
        user_id: identity.id,
        display_name: identity.displayName,
        email: identity.email,
        logged_in_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `failed to write credentials file: ${message}` };
  }

  return { ok: true, identity };
}

export interface RunSetupInteractiveOptions extends RunSetupOptions {
  /**
   * Injectable OIDC-state probe for the `--remote` path (#807). Defaults to
   * {@link probeOidcState} (a real `GET /health/detailed`). Tests stub this to
   * drive the ready / disabled / degraded / probe-failure branches.
   */
  oidcProbe?: OidcProbe;
  /**
   * Injectable device-flow login seam (#806). Defaults to the exported
   * {@link runDeviceLogin}. Tests stub this to assert the `ready` branch routes
   * here without standing up a full device-flow server.
   */
  deviceLogin?: typeof runDeviceLogin;
  /**
   * Injectable manual-PAT persistence seam (#809). Defaults to
   * {@link persistManualPat} (validate the PAT against `GET /api/v1/me`, then
   * write the credentials file). Tests stub this to drive the manual branch
   * without a live server.
   */
  manualPatPersist?: ManualPatPersist;
  /**
   * Explicit mode selected via `--local` / `--service` / `--remote`. When set,
   * the menu is SKIPPED and the chosen path runs non-interactively. When
   * undefined, a TTY gets the menu and a non-TTY defaults to `local`.
   */
  mode?: SetupMode;
  /**
   * Injectable prompt IO forwarded to the menu (tests drive it without a real
   * TTY). Defaults to process.stdin/stdout inside {@link selectFromMenu}.
   */
  promptIO?: PromptIO;
  /**
   * Injectable menu selector (defaults to {@link selectFromMenu}). Tests can
   * stub this to assert routing without exercising stream plumbing.
   */
  selectMode?: (io?: PromptIO) => Promise<SetupMode>;
  /**
   * Injectable user-scoped service install (defaults to the real service
   * backend's user-scoped install from service.ts). Tests assert it is invoked
   * for the `service` path without touching systemctl/launchd/schtasks.
   */
  serviceInstall?: () => void;
  /**
   * Injectable TTY predicate (defaults to {@link shouldPrompt}). Lets tests
   * simulate a TTY / non-TTY without mutating process.stdin.
   */
  isInteractive?: () => boolean;
  /**
   * Injectable status-line consent prompt (#798). Defaults to
   * {@link confirmStatuslineWiring}. The Local path offers (opt-in) to wire
   * `tasks statusline` into `settings.json` after the core install; tests stub
   * this to drive the consent / decline / existing-statusLine branches.
   */
  confirmStatusline?: ConfirmStatusline;
}

/** Result returned by the service path (no claude.json/skills work was done). */
export interface RunSetupServiceResult {
  mode: 'service';
}

/**
 * Result returned by the `--remote` onboarding path (#807). Records the OIDC
 * state the probe observed (or its failure) and the onboarding method that was
 * routed to, so callers (and tests) can assert the branch selection.
 */
export interface RunSetupRemoteResult {
  mode: 'remote';
  /** Probed OIDC state, or `null` when the probe failed (network/non-2xx). */
  oidc: OidcState | null;
  /** The onboarding method the branch selector chose. */
  method: RemoteOnboardingMethod;
  /** True when the chosen path completed successfully. */
  ok: boolean;
  /** The synchronous claude.json/skills setup, when the path ran it. */
  setup?: RunSetupResult;
  /** Identity resolved by the manual-PAT path (#809), when that path ran. */
  manualPatIdentity?: ManualPatIdentity;
}

export type RunSetupInteractiveResult =
  | (RunSetupResult & {
      mode: 'local';
      /** Outcome of the opt-in `tasks statusline` wiring offer (#798). */
      statusline: WireStatuslineResult;
    })
  | RunSetupServiceResult
  | RunSetupRemoteResult;

/** Present the Local / Service / Remote menu and resolve the chosen mode. */
export function selectSetupMode(io?: PromptIO): Promise<SetupMode> {
  return selectFromMenu<SetupMode>(
    {
      message: 'How would you like to set up Wood Fired Tasks?',
      options: [
        { label: 'Local — install the local MCP server into ~/.claude.json', value: 'local' },
        { label: 'Service — install the background service (user-scoped)', value: 'service' },
        { label: 'Remote — connect to a remote Wood Fired Tasks server', value: 'remote' },
      ],
      defaultValue: 'local',
    },
    io,
  );
}

/**
 * Mode-aware entry point for `tasks setup` (task #805).
 *
 *  1. No-args on a TTY → present a Local/Service/Remote menu and run the choice.
 *  2. `--local` / `--service` / `--remote` (i.e. `mode` set) → run that path
 *     non-interactively (no menu).
 *  3. No-args + non-TTY → default to the Local path (back-compat: identical to
 *     the original `runSetup` behavior).
 *
 * The `service` path delegates to the user-scoped install from service.ts; the
 * `local` path delegates to {@link runSetup} (so all existing idempotency /
 * 0600 / asset-resolver guarantees are preserved verbatim). The `remote` path
 * delegates to {@link runRemoteOnboarding}, which probes `/health/detailed` and
 * branches on the server's OIDC state (#807).
 */
export async function runSetupInteractive(
  options: RunSetupInteractiveOptions = {},
): Promise<RunSetupInteractiveResult> {
  const home = options.home ?? os.homedir();
  const log = options.log ?? ((line: string) => console.log(line));
  const isInteractive = options.isInteractive ?? shouldPrompt;
  const selectMode = options.selectMode ?? selectSetupMode;

  // Resolve the mode: explicit flag wins; otherwise prompt on a TTY, else local.
  let mode: SetupMode;
  if (options.mode !== undefined) {
    mode = options.mode;
  } else if (isInteractive()) {
    mode = await selectMode(options.promptIO);
  } else {
    mode = 'local';
  }

  if (mode === 'service') {
    log('Installing the user-scoped background service…');
    const serviceInstall =
      options.serviceInstall ?? (() => getServiceBackend().install({ system: false }));
    serviceInstall();
    return { mode: 'service' };
  }

  // Remote: probe the server's OIDC state and branch to the right onboarding
  // method BEFORE choosing how to authenticate (#807).
  if (mode === 'remote') {
    return runRemoteOnboarding(options);
  }

  // Local flows through the existing synchronous runSetup verbatim, preserving
  // all idempotency / 0600 / asset-resolver guarantees.
  const result = runSetup(options);

  // Task #798: after the core local install, OPT-IN offer to wire
  // `tasks statusline` into ~/.claude/settings.json. Non-clobbering and
  // skipped silently on a non-TTY (the offer never blocks / never auto-writes).
  const statusline = await offerStatuslineWiring({
    home,
    log,
    isInteractive,
    ...(options.confirmStatusline !== undefined && { confirm: options.confirmStatusline }),
    ...(options.promptIO !== undefined && { promptIO: options.promptIO }),
  });

  return { ...result, mode: 'local', statusline };
}

/**
 * `setup --remote` onboarding selector (task #807, Phase 2).
 *
 * BEFORE choosing an onboarding method, probe `GET /health/detailed` to read
 * the server's OIDC state, then branch deterministically:
 *   - `ready`    → device-flow path via {@link runDeviceLogin} (#806).
 *   - `disabled` → manual-PAT entry (the server has no browser login).
 *   - `degraded` → inform the user, then offer the manual-PAT path.
 *   - probe failure (network / non-2xx) → fall back to manual-PAT entry.
 *
 * The probe, the prompt seam, and the device-login seam are all injectable so
 * each branch is testable without a live server (see setup.remote.test.ts).
 *
 * NOTE: the deeper write specifics — a URL-only `claude.json` entry for the
 * device-flow path (#808) and full manual-PAT persistence (#809) — are
 * downstream. This task implements the PROBE + BRANCH ROUTING and makes each
 * branch invoke the right action with a minimal-but-functional manual path.
 */
export async function runRemoteOnboarding(
  options: RunSetupInteractiveOptions = {},
): Promise<RunSetupRemoteResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const baseUrl = options.remote;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new Error('remote onboarding requires a --remote <url> base URL.');
  }

  const probe = options.oidcProbe ?? probeOidcState;
  const deviceLogin = options.deviceLogin ?? runDeviceLogin;

  // 1. Probe the OIDC state.
  log(`Probing ${baseUrl} for its OIDC state…`);
  const probeResult = await probe(baseUrl);

  // 2. Inform on degraded / probe failure so the user understands the fallback.
  if (!probeResult.ok) {
    log(`Could not determine the server's OIDC state (${probeResult.reason}).`);
    log('Falling back to manual personal-access-token entry.');
  } else if (probeResult.oidc === 'disabled') {
    log('This server has no browser login (OIDC disabled); using manual PAT entry.');
  } else if (probeResult.oidc === 'degraded') {
    log(
      'This server has OIDC configured but discovery is currently failing ' +
        '(degraded); browser login is unavailable. Offering manual PAT entry.',
    );
  } else {
    log('This server supports browser login (OIDC ready); using the device flow.');
  }

  // 3. Branch on the selected method.
  const method = selectRemoteOnboardingMethod(probeResult);
  const oidc = probeResult.ok ? probeResult.oidc : null;

  if (method === 'device-flow') {
    // Self-provision a PAT via the OIDC device flow (#806). runDeviceLogin owns
    // the entire RFC 8628 exchange AND persists the minted PAT via the
    // credentials writer (writeCredentials) — there is NO host token-mint path
    // here. On failure it has already emitted its own error output; we just
    // propagate ok:false without writing anything.
    const result = await deviceLogin({
      baseUrl,
      clientId: process.env['OIDC_CLIENT_ID'] ?? 'wft-cli',
      hostname: os.hostname(),
      openBrowser: true,
      isJson: false,
    });
    if (!result.ok) {
      return { mode: 'remote', oidc, method, ok: false };
    }

    // Device login succeeded and the PAT is already persisted in the
    // credentials file. Now write the URL-only remote MCP entry (#810) into
    // ~/.claude.json. The entry carries ONLY WFT_API_URL — the bridge resolves
    // its bearer token at runtime from the credentials file the device flow
    // just wrote, so NO token is ever embedded in claude.json and NO PAT is
    // double-cached here.
    const setup = writeRemoteMcpEntryOnly({ ...options, remote: baseUrl });
    return { mode: 'remote', oidc, method, ok: true, setup };
  }

  // method === 'manual-pat' (task #809): obtain a PAT, validate it, and persist
  // it through the SAME credentials writer the device flow uses
  // (writeCredentials), then write the URL-only claude.json entry via the
  // shared writeRemoteMcpEntryOnly helper (#808/#810) — identical entry shape to
  // the device-flow path; only the PAT source differs.
  //
  // PAT precedence:
  //   1. `--token <pat>`            (explicit flag; wins).
  //   2. interactive promptSecret   (a TTY pastes the PAT, never echoed).
  //   3. env `WFT_API_KEY`          (DOCUMENTED non-TTY fallback — the same env
  //      the remote bridge reads at runtime; lets CI / non-TTY callers supply
  //      the PAT without a prompt instead of hanging).
  // On a non-TTY with none of the above, fail clearly (no hang).
  let token = options.token;
  if (
    (typeof token !== 'string' || token.length === 0) &&
    (options.isInteractive ?? shouldPrompt)()
  ) {
    token = await promptSecret('Paste a personal access token: ', options.promptIO);
  }
  if (typeof token !== 'string' || token.length === 0) {
    // Non-TTY (or empty prompt) fallback: read the PAT from the documented
    // WFT_API_KEY env var rather than hanging on a prompt that has no TTY.
    const envToken = process.env['WFT_API_KEY'];
    if (typeof envToken === 'string' && envToken.length > 0) {
      token = envToken;
    }
  }
  if (typeof token !== 'string' || token.length === 0) {
    log(
      'No personal access token supplied. Re-run with --token <pat> ' +
        'or set the WFT_API_KEY environment variable to finish remote setup.',
    );
    return { mode: 'remote', oidc, method, ok: false };
  }

  // Validate the PAT and persist it via writeCredentials (the device-flow
  // writer). Nothing is written to claude.json until the PAT proves valid, so a
  // rejected/unreachable token never leaves a half-configured install.
  const persist = options.manualPatPersist ?? persistManualPat;
  const persisted = await persist(baseUrl, token);
  if (!persisted.ok) {
    log(`Could not store the personal access token: ${persisted.reason}.`);
    return { mode: 'remote', oidc, method, ok: false };
  }
  log(`Stored credentials for ${persisted.identity.displayName}.`);

  // URL-only claude.json entry (#810) via the SAME helper the device-flow path
  // uses (#808). No PAT is embedded — the bridge resolves it at runtime from the
  // credentials file written above.
  const setup = writeRemoteMcpEntryOnly({ ...options, remote: baseUrl });
  return {
    mode: 'remote',
    oidc,
    method,
    ok: true,
    setup,
    manualPatIdentity: persisted.identity,
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
  .option('--local', 'Run the Local setup path non-interactively (skip the menu)')
  .option('--service', 'Run the Service setup path non-interactively (user-scoped service install)')
  .option(
    '--remote <url>',
    'Install the remote MCP bridge (wood-fired-tasks-remote) pointed at the given REST API base URL; requires --token',
  )
  .option(
    '--token <pat>',
    'Personal access token for the manual-PAT --remote path (OIDC disabled/degraded). Validated against the server and stored in the CLI credentials file. On a non-TTY the WFT_API_KEY env var is also honored as a fallback.',
  )
  .action(
    (opts: {
      fixNpmPrefix?: boolean;
      local?: boolean;
      service?: boolean;
      remote?: string;
      token?: string;
    }) => {
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

      // Resolve the explicit mode from the flags. `--remote <url>` implies the
      // remote mode; `--service` and `--local` are bare flags. When none is
      // present, `mode` stays undefined so runSetupInteractive shows the menu on
      // a TTY (and defaults to local on a non-TTY) — preserving back-compat.
      let mode: SetupMode | undefined;
      if (opts.remote !== undefined) {
        mode = 'remote';
      } else if (opts.service === true) {
        mode = 'service';
      } else if (opts.local === true) {
        mode = 'local';
      }

      void runSetupInteractive({
        fixNpmPrefix: Boolean(opts.fixNpmPrefix),
        ...(mode !== undefined && { mode }),
        ...(opts.remote !== undefined && { remote: opts.remote }),
        ...(token !== undefined && { token }),
      });
    },
  );
