import { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  mergeClaudeJson,
  type ClaudeMcpServerEntry,
} from '../../setup/claude-json.js';
import { resolveAssetPath } from '../../assets/resolve.js';

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

/** Default destination for copied skills. */
export function commandsDestDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'commands', 'tasks');
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
  sourceDir: string = resolveAssetPath('skills', 'tasks')
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
  sourceDir: string = resolveAssetPath('skills', 'agents')
): CopyAgentsResult {
  const written: string[] = [];
  const files: string[] = [];

  const entries = fs.existsSync(sourceDir)
    ? fs
        .readdirSync(sourceDir)
        .filter((f) => f.endsWith('.md') && !AGENTS_EXCLUDE.has(f))
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
export function fixNpmPrefix(
  options: FixNpmPrefixOptions = {}
): FixNpmPrefixResult {
  const home = options.home ?? os.homedir();
  const log = options.log ?? ((line: string) => console.log(line));
  const runner =
    options.runner ??
    ((cmd: string, args: string[]) => {
      // Hard guard: never elevate.
      if (/^(sudo|runas|pkexec|doas)$/i.test(cmd)) {
        throw new Error('refusing to run elevated command');
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
}

export interface RunSetupResult {
  claudeJsonPath: string;
  claudeJsonChanged: boolean;
  skills: CopySkillsResult;
  agents: CopyAgentsResult;
  npmPrefix?: FixNpmPrefixResult;
}

/**
 * Pure-ish setup action. Resolves all paths from `home` so tests can sandbox
 * with a temp HOME and never touch the real ~/.claude.json or ~/.claude/.
 */
export function runSetup(options: RunSetupOptions = {}): RunSetupResult {
  const home = options.home ?? os.homedir();
  const log = options.log ?? ((line: string) => console.log(line));

  const claudeJsonPath = path.join(home, '.claude.json');
  const merge = mergeClaudeJson({
    filePath: claudeJsonPath,
    serverName: SERVER_NAME,
    entry: buildLocalMcpEntry(),
  });
  log(
    !merge.unchanged
      ? `Installed local MCP server '${SERVER_NAME}' into ${claudeJsonPath}`
      : `Local MCP server '${SERVER_NAME}' already present in ${claudeJsonPath}`
  );

  const skills = copySkills(commandsDestDir(home));
  log(
    skills.written.length > 0
      ? `Copied ${skills.written.length} skill(s) into ${skills.destDir}`
      : `Skills already up to date in ${skills.destDir}`
  );

  const agents = copyAgents(agentsDestDir(home));
  log(
    agents.written.length > 0
      ? `Copied ${agents.written.length} agent(s) into ${agents.destDir}`
      : `Agents already up to date in ${agents.destDir}`
  );

  let npmPrefix: FixNpmPrefixResult | undefined;
  if (options.fixNpmPrefix) {
    npmPrefix = fixNpmPrefix({ home, runner: options.npmRunner, log });
  }

  return {
    claudeJsonPath,
    claudeJsonChanged: !merge.unchanged,
    skills,
    agents,
    npmPrefix,
  };
}

export const setupCommand = new Command('setup')
  .description(
    'Install the local wood-fired-tasks MCP server into ~/.claude.json, copy skills into ~/.claude/commands/tasks/, and copy subagent definitions into ~/.claude/agents/'
  )
  .option(
    '--fix-npm-prefix',
    'Configure a user-writable npm global prefix (~/.npm-global) to avoid EACCES on `npm i -g` (never uses sudo)'
  )
  .action((opts: { fixNpmPrefix?: boolean }) => {
    runSetup({ fixNpmPrefix: Boolean(opts.fixNpmPrefix) });
  });
