import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * README Quick Start drift guard (task #713).
 *
 * The README Quick Start was rewritten in #706 to be command-real: the CLI is
 * invoked via `npm run cli -- <args>` (the repo ships NO global `tasks` binary
 * and the Quick Start explicitly does NOT run `npm link`), both `API_KEYS`
 * (server) and `API_KEY` (client) are exported, and a project is created
 * before any task. This guard locks that contract so the section cannot drift
 * back to documenting an unlinked bare-`tasks` invocation or an `API_KEY`-less
 * CLI flow.
 *
 * SCOPE (AC2): it operates ONLY on the `## Quick Start` section and its fenced
 * code blocks — ordinary prose/wording edits elsewhere in the README, and even
 * rewording of the Quick Start narrative, do not trip it. The assertions key
 * off the *commands* in the fenced blocks, not the surrounding sentences.
 *
 * CI (AC3): this is a vitest test, so it runs automatically under `npm test`
 * (`vitest run`) and therefore in CI on every PR. No separate wiring needed.
 */

const README_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'README.md',
);

/**
 * Extract the body of the `## Quick Start` section: everything between that
 * heading and the next top-level (`## `) heading. Heading-level-agnostic to the
 * exact title wording beyond "Quick Start".
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
 * fenced command blocks. The test cases assert on these fields; the negative
 * tests drive the same analyzer against mutated copies of the section.
 */
export interface QuickStartFindings {
  /** Command lines (fenced, comment/blank-stripped) in the Quick Start. */
  commandLines: string[];
  /** Lines that invoke a bare global `tasks` binary (the drift we forbid). */
  bareTasksLines: string[];
  /** Whether the section anywhere instructs an `npm link` global install. */
  hasNpmLink: boolean;
  /** Whether any command uses the supported `npm run cli -- …` form. */
  hasNpmRunCli: boolean;
  /** Whether `API_KEY` (client/CLI var) is referenced in the section. */
  hasApiKey: boolean;
  /** Whether `API_KEYS` (server var) is referenced in the section. */
  hasApiKeys: boolean;
  /** Whether a project is created (project-create) in the fenced commands. */
  createsProject: boolean;
  /** Whether a task is created (cli `create`) in the fenced commands. */
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

  // A "bare tasks" invocation runs the global `tasks` binary directly: a token
  // `tasks` (optionally after a leading `$`/`sudo`) followed by a subcommand.
  // We explicitly do NOT flag `npm run cli -- …` (the supported form) or
  // `npm link` / `tasks --version`-style narration inside `npm run` chains.
  const bareTasksLines = commandLines.filter((line) =>
    /(^|[;&|]\s*)(?:\$\s*)?(?:sudo\s+)?tasks\s+\S/.test(line) &&
    !/npm\s+run\s+cli/.test(line),
  );

  const sectionText = section;
  // `npm link` only counts as a global-install instruction when it appears as
  // an actual command in a fenced block — NOT when prose mentions it (the #706
  // Quick Start says "no `npm link`" in prose, which must not be read as an
  // install step that would license a bare `tasks` invocation).
  const hasNpmLink = commandLines.some((l) => /\bnpm\s+link\b/.test(l));
  return {
    commandLines,
    bareTasksLines,
    hasNpmLink,
    hasNpmRunCli: commandLines.some((l) => /npm\s+run\s+cli\s+(?:--silent\s+)?--/.test(l)),
    hasApiKey: /\bAPI_KEY\b/.test(sectionText),
    hasApiKeys: /\bAPI_KEYS\b/.test(sectionText),
    createsProject: commandLines.some((l) => /npm\s+run\s+cli\s.*\bproject-create\b/.test(l)),
    // A task-create line runs the cli `create` subcommand but is NOT the
    // `project-create` line. Match `create` not immediately preceded by `-`.
    createsTask: commandLines.some(
      (l) => /npm\s+run\s+cli\s/.test(l) && /(?<!-)\bcreate\b/.test(l),
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

  it('AC1: does NOT invoke a bare global `tasks` binary without an `npm link` step', () => {
    // The repo ships no global `tasks` binary from a fresh clone. A bare
    // `tasks <subcmd>` in the Quick Start is only legitimate if the section
    // first tells the reader to `npm link`. The #706 Quick Start does neither,
    // so this must be empty. If a future edit reintroduces `tasks list` etc.
    // without an `npm link` instruction, this fails.
    if (!findings.hasNpmLink) {
      expect(
        findings.bareTasksLines,
        `Quick Start invokes a bare global \`tasks\` binary without an \`npm link\` step. ` +
          `Use \`npm run cli -- <args>\` instead. Offending lines:\n  ${findings.bareTasksLines.join('\n  ')}`,
      ).toEqual([]);
    }
  });

  it('AC1: uses the supported `npm run cli -- …` CLI invocation form', () => {
    expect(
      findings.hasNpmRunCli,
      'Quick Start should invoke the CLI via `npm run cli -- <args>` (the fresh-clone form).',
    ).toBe(true);
  });

  it('AC1: exports `API_KEY` (client/CLI auth var) for CLI use', () => {
    expect(
      findings.hasApiKey,
      'Quick Start omits `API_KEY` — the CLI cannot authenticate to the API without it.',
    ).toBe(true);
  });

  it('also exports the server-side `API_KEYS` var (separate from `API_KEY`)', () => {
    expect(
      findings.hasApiKeys,
      'Quick Start omits the server-side `API_KEYS` var. `API_KEYS` (server) and `API_KEY` (client) are separate.',
    ).toBe(true);
  });

  it('creates a project before creating a task (no assumed project id 1)', () => {
    expect(
      findings.createsProject,
      'Quick Start should create a project (`npm run cli -- … project-create`) before tasks.',
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

  it('flags a bare `tasks list` invocation (no npm link present)', () => {
    const drifted = section.replace(
      'npm run cli -- list --project 2',
      'tasks list --project 2',
    );
    const f = analyzeQuickStart(drifted);
    expect(drifted).not.toEqual(section); // sanity: the mutation applied
    expect(f.hasNpmLink).toBe(false);
    expect(f.bareTasksLines.length).toBeGreaterThan(0);
    expect(f.bareTasksLines.some((l) => /tasks\s+list/.test(l))).toBe(true);
  });

  it('flags a Quick Start that omits `API_KEY` for the CLI', () => {
    const drifted = section
      .replace(/^.*\bAPI_KEY\b.*$/gm, '') // strip every line mentioning API_KEY/API_KEYS
      .replace(/API_KEY/g, '');
    const f = analyzeQuickStart(drifted);
    expect(f.hasApiKey).toBe(false);
  });
});
