import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * README Quick Start drift guard (task #713; re-pointed by project #36 / #747).
 *
 * The Quick Start now documents the **frictionless npm-global** distribution
 * flow (the entire point of milestone #36): install with `npm i -g
 * wood-fired-tasks` (NO git clone, NO build, NO admin rights), wire it into
 * Claude Code with `wood-fired-tasks setup`, run the API with `wood-fired-tasks
 * serve`, then create a project before any task. This guard locks that contract
 * so the section cannot drift back to a git-clone / `npm run cli --` flow or
 * silently drop the no-sudo guarantee.
 *
 * SCOPE: it operates ONLY on the `## Quick Start` section and its fenced code
 * blocks — prose edits elsewhere, and rewording of the Quick Start narrative,
 * do not trip it. The assertions key off the *commands* in the fenced blocks.
 *
 * CI: a vitest test, so it runs under `npm test` (`vitest run`) on every PR.
 */

const README_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'README.md',
);

/**
 * Extract the body of the `## Quick Start` section: everything between that
 * heading and the next top-level (`## `) heading.
 */
export function extractQuickStart(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^##\s+Quick Start\s*$/.test(l));
  if (start === -1) {
    throw new Error('README is missing a "## Quick Start" section');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Pull the contents of every fenced (``` … ```) code block out of a section. */
export function extractFencedBlocks(section: string): string[] {
  const blocks: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

/**
 * Structured findings about the Quick Start section, derived purely from its
 * fenced command blocks. The positive tests assert on these fields; the
 * negative tests drive the same analyzer against mutated copies of the section.
 */
export interface QuickStartFindings {
  /** Command lines (fenced, comment/blank-stripped) in the Quick Start. */
  commandLines: string[];
  /** Whether the section installs globally via `npm i -g wood-fired-tasks`. */
  installsGlobally: boolean;
  /** Whether the section drives the global `wood-fired-tasks` bin (setup/serve/…). */
  usesGlobalBin: boolean;
  /** Whether any fenced command instructs a `git clone` install step (forbidden). */
  hasGitCloneInstall: boolean;
  /** Whether any fenced command escalates via sudo/runas/pkexec/doas (forbidden). */
  hasElevation: boolean;
  /** Whether a project is created (`project-create`) in the fenced commands. */
  createsProject: boolean;
  /** Whether a task is created (`create`, not `project-create`) afterwards. */
  createsTask: boolean;
}

export function analyzeQuickStart(section: string): QuickStartFindings {
  const blocks = extractFencedBlocks(section);
  const commandLines: string[] = [];
  for (const block of blocks) {
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue; // skip blanks + shell comments
      commandLines.push(line);
    }
  }

  return {
    commandLines,
    installsGlobally: commandLines.some((l) =>
      /\bnpm\s+i(?:nstall)?\s+-g\s+wood-fired-tasks\b/.test(l),
    ),
    // The global bin (`wood-fired-tasks <subcmd>` or its `tasks`/`wft` aliases)
    // is now the SUPPORTED invocation — npm i -g ships it on PATH.
    usesGlobalBin: commandLines.some((l) =>
      /\bwood-fired-tasks\s+\S/.test(l),
    ),
    hasGitCloneInstall: commandLines.some((l) => /\bgit\s+clone\b/.test(l)),
    hasElevation: commandLines.some((l) =>
      /(^|[;&|]\s*)(?:sudo|runas|pkexec|doas)\s+\S/.test(l),
    ),
    createsProject: commandLines.some((l) =>
      /\bwood-fired-tasks\b.*\bproject-create\b/.test(l),
    ),
    createsTask: commandLines.some(
      (l) => /\bwood-fired-tasks\b/.test(l) && /(?<!-)\bcreate\b/.test(l),
    ),
  };
}

describe('README Quick Start drift guard', () => {
  const readme = readFileSync(README_PATH, 'utf8');
  const section = extractQuickStart(readme);
  const findings = analyzeQuickStart(section);

  it('has a Quick Start section with at least one fenced command block', () => {
    expect(extractFencedBlocks(section).length).toBeGreaterThan(0);
    expect(findings.commandLines.length).toBeGreaterThan(0);
  });

  it('installs globally via `npm i -g wood-fired-tasks` (no clone, no build)', () => {
    expect(
      findings.installsGlobally,
      'Quick Start should install via `npm i -g wood-fired-tasks` — the frictionless no-clone flow (#36).',
    ).toBe(true);
  });

  it('drives the global `wood-fired-tasks` bin (setup/serve), not `npm run cli --`', () => {
    expect(
      findings.usesGlobalBin,
      'Quick Start should invoke the global `wood-fired-tasks` bin (e.g. `setup`, `serve`).',
    ).toBe(true);
  });

  it('does NOT instruct a `git clone` install step (no-clone guarantee)', () => {
    expect(
      findings.hasGitCloneInstall,
      'Quick Start must not drift back to a git-clone install — milestone #36 is npm-global, no clone.',
    ).toBe(false);
  });

  it('never escalates (admin-free: no sudo/runas/pkexec/doas in commands)', () => {
    expect(
      findings.hasElevation,
      'Quick Start commands must stay admin-free — no sudo/runas/pkexec/doas.',
    ).toBe(false);
  });

  it('creates a project before creating a task (no assumed project id 1)', () => {
    expect(
      findings.createsProject,
      'Quick Start should create a project (`wood-fired-tasks … project-create`) before tasks.',
    ).toBe(true);
    expect(
      findings.createsTask,
      'Quick Start should create a task after the project.',
    ).toBe(true);
  });
});

/**
 * Negative tests: prove the guard actually guards. We mutate a COPY of the real
 * Quick Start section to reintroduce each forbidden drift and assert the
 * analyzer flags it. The real README is never modified.
 */
describe('README Quick Start drift guard — negative (proves it fails on drift)', () => {
  const readme = readFileSync(README_PATH, 'utf8');
  const section = extractQuickStart(readme);

  it('flags a reintroduced `git clone` install step', () => {
    const drifted = section.replace(
      'npm i -g wood-fired-tasks',
      'git clone https://github.com/Wood-Fired-Games/wood-fired-tasks',
    );
    const f = analyzeQuickStart(drifted);
    expect(drifted).not.toEqual(section); // sanity: the mutation applied
    expect(f.hasGitCloneInstall).toBe(true);
  });

  it('flags a Quick Start that drops the global `npm i -g` install', () => {
    const drifted = section.replace(/\bnpm\s+i\s+-g\s+wood-fired-tasks\b/g, 'true');
    const f = analyzeQuickStart(drifted);
    expect(f.installsGlobally).toBe(false);
  });
});
