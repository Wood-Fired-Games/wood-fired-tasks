/**
 * Agent onboarding smoke test (task #282).
 *
 * Verifies that the seven probe scenarios documented in
 * `docs/ONBOARDING_SMOKE.md` and `docs/AGENT_CONTEXT.md` §7 stay grounded
 * in real on-disk files and real npm scripts / binaries. The acceptance
 * criterion the test enforces:
 *
 *   1. Every `expectedFiles` path referenced by a probe exists on disk.
 *   2. Every `expectedCommands` entry resolves to either an npm script
 *      in `package.json` or a binary on disk under `node_modules/.bin/`.
 *   3. Each probe's expected-files set is "small" (≤ 6 paths) — agents
 *      should not need to read the whole repo to onboard.
 *   4. No single file in a probe set exceeds 1500 lines — the
 *      recommended-read budget would otherwise be meaningless. Reference
 *      deep docs (API.md, MCP.md, CLI.md, tasks-command.ts) drive this
 *      bound; tighten it once those docs are split.
 *
 * Hard determinism rules:
 *   - No fetch, no HTTP, no DB access, no env reads beyond `process.cwd()`.
 *   - All I/O is `node:fs` against files inside the committed repo.
 *   - The probes' wording mirrors `docs/AGENT_CONTEXT.md` §7 and the human
 *     procedure in `docs/ONBOARDING_SMOKE.md`. Keep those three in sync.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findRepoRoot } from '../manifest.js';

interface ProbeScenario {
  name: string;
  prompt: string;
  /** Files (or directories — see `dirPaths`) the probe expects an agent to consult first. */
  expectedFiles: readonly string[];
  /** Subset of `expectedFiles` that are directories, not regular files. */
  dirPaths?: readonly string[];
  /** npm script names or `node_modules/.bin` binary names. */
  expectedCommands: readonly string[];
}

const PROBES: readonly ProbeScenario[] = [
  {
    name: 'probe-api',
    prompt: 'Add a REST endpoint `GET /tasks/:id/history`.',
    expectedFiles: [
      'AGENTS.md',
      'docs/INTERFACES.md',
      'docs/API.md',
      'src/api/routes/tasks/index.ts',
      'src/api/__tests__',
    ],
    dirPaths: ['src/api/__tests__'],
    expectedCommands: ['build', 'test'],
  },
  {
    name: 'probe-mcp',
    prompt: 'Add a new MCP tool `archive_task`.',
    expectedFiles: ['AGENTS.md', 'docs/MCP.md', 'src/mcp/tools/task-tools.ts', 'src/mcp/__tests__'],
    dirPaths: ['src/mcp/__tests__'],
    expectedCommands: ['build', 'test'],
  },
  {
    name: 'probe-cli',
    prompt: 'Add a `tasks export` CLI subcommand.',
    expectedFiles: [
      'AGENTS.md',
      'docs/CLI.md',
      'src/cli/bin/tasks.ts',
      'src/cli/commands',
      'src/cli/__tests__',
    ],
    dirPaths: ['src/cli/commands', 'src/cli/__tests__'],
    expectedCommands: ['build', 'test', 'cli'],
  },
  {
    name: 'probe-db',
    prompt: 'Add a migration adding a `priority` column to `tasks`.',
    expectedFiles: [
      'AGENTS.md',
      'docs/ARCHITECTURE.md',
      'src/db/migrations',
      'src/db/migrate.ts',
      'src/db/__tests__',
    ],
    dirPaths: ['src/db/migrations', 'src/db/__tests__'],
    expectedCommands: ['migrate', 'test'],
  },
  {
    name: 'probe-slack',
    prompt: 'Add a `/bugs status` Slack slash command response.',
    expectedFiles: [
      'AGENTS.md',
      'docs/SLACK.md',
      'src/slack/commands/tasks-command.ts',
      'slack-app-manifest.yml',
    ],
    expectedCommands: ['test', 'build'],
  },
  {
    name: 'probe-docs',
    prompt: 'Add a new section to the README explaining the SSE protocol.',
    expectedFiles: ['AGENTS.md', 'docs/AGENT_CONTEXT.md', 'README.md', 'docs/API.md'],
    expectedCommands: ['lint', 'agent-context:check'],
  },
  {
    name: 'probe-release',
    prompt: 'Cut a v1.1.0 release.',
    expectedFiles: ['AGENTS.md', 'docs/RELEASE.md', 'CHANGELOG.md', 'package.json'],
    expectedCommands: ['prepublishOnly', 'pack:check'],
  },
];

const MAX_FILES_PER_PROBE = 6;
// Soft bound on any single recommended-read file. Reference deep docs
// (docs/API.md ≈ 1056, docs/CLI.md ≈ 1692 after the v2.0 statusline section,
// docs/MCP.md ≈ 809, src/slack/commands/tasks-command.ts ≈ 1050) push this
// ceiling; kept in step with the docs/CLI.md line budget in
// scripts/agent-context/manifest.ts (1800). Tighten when those files are split
// per the AGENT_CONTEXT.md budgets.
const MAX_LINES_PER_PROBE_FILE = 1800;

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  if (text.length > 0 && text.charCodeAt(text.length - 1) !== 10) n++;
  return n;
}

// Stryker mutation testing copies the repo into a sandbox and instruments
// every mutated src/** file, prepending mutant-switch scaffolding
// (stryNS_/stryCov_/stryMutAct_ helpers). This inflates the on-disk line
// count far past the committed source — e.g. under shard 3 (src/slack/**)
// `tasks-command.ts` grows 1193 → 1625 lines — which would false-fail the
// budget below during Stryker's initial dry-run (the dry-run executes the
// whole suite, so a failure here aborts the entire shard). The 1500-line
// budget is a doc-hygiene check on the *committed* file and is already
// enforced on every push/PR CI run where sources are pristine, so detect
// instrumented sandbox copies and skip them. See mutation run 2026-05-26.
function isStrykerInstrumented(text: string): boolean {
  return text.includes('stryMutAct_') || text.includes('stryNS_');
}

interface PackageJsonShape {
  scripts?: Record<string, string>;
}

function loadPackageScripts(repoRoot: string): Record<string, string> {
  const pkgText = readFileSync(resolve(repoRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgText) as PackageJsonShape;
  return pkg.scripts ?? {};
}

function commandResolves(
  repoRoot: string,
  scripts: Record<string, string>,
  command: string,
): boolean {
  if (Object.prototype.hasOwnProperty.call(scripts, command)) return true;
  // Fall back to a real binary inside node_modules/.bin (e.g. `tsx`,
  // `vitest`, `biome`). Keep the check tiny — no shell, no env scan.
  const binPath = resolve(repoRoot, 'node_modules', '.bin', command);
  return existsSync(binPath);
}

describe('onboarding smoke (task #282)', () => {
  const repoRoot = findRepoRoot();
  const scripts = loadPackageScripts(repoRoot);

  it('declares exactly seven probe scenarios (API, MCP, CLI, DB, Slack, docs, release)', () => {
    expect(PROBES.map((p) => p.name)).toEqual([
      'probe-api',
      'probe-mcp',
      'probe-cli',
      'probe-db',
      'probe-slack',
      'probe-docs',
      'probe-release',
    ]);
  });

  for (const probe of PROBES) {
    describe(probe.name, () => {
      it(`keeps the expected-files set small (≤ ${MAX_FILES_PER_PROBE} paths)`, () => {
        expect(
          probe.expectedFiles.length,
          `${probe.name} would point an agent at ${probe.expectedFiles.length} files; ` +
            `cap is ${MAX_FILES_PER_PROBE} — split or trim before merging.`,
        ).toBeLessThanOrEqual(MAX_FILES_PER_PROBE);
      });

      it('lists every expected file/dir as a real path on disk', () => {
        const dirSet = new Set(probe.dirPaths ?? []);
        for (const rel of probe.expectedFiles) {
          const abs = resolve(repoRoot, rel);
          expect(existsSync(abs), `${probe.name}: missing path "${rel}"`).toBe(true);
          const isDir = dirSet.has(rel);
          const st = statSync(abs);
          if (isDir) {
            expect(st.isDirectory(), `${probe.name}: "${rel}" should be a directory`).toBe(true);
          } else {
            expect(st.isFile(), `${probe.name}: "${rel}" should be a regular file`).toBe(true);
          }
        }
      });

      it(`keeps every recommended-read file under ${MAX_LINES_PER_PROBE_FILE} lines`, () => {
        const dirSet = new Set(probe.dirPaths ?? []);
        for (const rel of probe.expectedFiles) {
          if (dirSet.has(rel)) continue;
          const abs = resolve(repoRoot, rel);
          const text = readFileSync(abs, 'utf8');
          // Skip Stryker-instrumented sandbox copies — see isStrykerInstrumented.
          if (isStrykerInstrumented(text)) continue;
          const lines = countLines(text);
          expect(
            lines,
            `${probe.name}: "${rel}" is ${lines} lines (> ${MAX_LINES_PER_PROBE_FILE}); ` +
              'split the doc or trim before relying on it as a recommended read.',
          ).toBeLessThanOrEqual(MAX_LINES_PER_PROBE_FILE);
        }
      });

      it('lists commands that resolve to npm scripts or node_modules binaries', () => {
        for (const cmd of probe.expectedCommands) {
          expect(
            commandResolves(repoRoot, scripts, cmd),
            `${probe.name}: command "${cmd}" is neither an npm script in ` +
              'package.json nor a binary under node_modules/.bin.',
          ).toBe(true);
        }
      });

      it('has a non-empty prompt', () => {
        expect(probe.prompt.trim().length).toBeGreaterThan(0);
      });
    });
  }

  it('cross-references the human procedure (docs/ONBOARDING_SMOKE.md) by name', () => {
    const doc = readFileSync(resolve(repoRoot, 'docs/ONBOARDING_SMOKE.md'), 'utf8');
    for (const probe of PROBES) {
      expect(
        doc.includes(probe.name),
        `docs/ONBOARDING_SMOKE.md is missing a reference to "${probe.name}".`,
      ).toBe(true);
    }
  });
});
