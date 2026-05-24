import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TASK_PRIORITIES, TASK_STATUSES } from '../../../../types/task.js';

/**
 * Task #347 — central enum source-of-truth gate.
 *
 * `src/types/task.ts` is the authoritative source for the task `status` and
 * `priority` enums. `skills/tasks/_enums.md` mirrors the values in
 * documentation form and every other `skills/tasks/*.md` file MUST cite it
 * instead of duplicating divergent values.
 *
 * This test reads every shipped skill source file and asserts that the
 * status/priority shaped tokens it mentions are members of the canonical
 * arrays imported above — i.e. catches `cancelled`, `critical`, `normal`,
 * etc. before they ship to `~/.claude/commands/tasks/` via `install.sh`.
 *
 * English-prose false positives (e.g. "normal flow", "critical path") are
 * intentionally whitelisted via a small allowlist of `(file, regex)` pairs.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const SKILLS_DIR = resolve(REPO_ROOT, 'skills/tasks');

// Tokens we even consider candidates for "is this an enum value?".
// Includes both canonical members AND known historical-divergent values
// (`cancelled`, `critical`, `normal`) so the test will surface them.
const CANDIDATE_TOKENS = [
  // status candidates
  'open',
  'in_progress',
  'done',
  'closed',
  'blocked',
  'backlogged',
  'cancelled', // non-canonical — should never appear as enum value
  // priority candidates
  'low',
  'medium',
  'high',
  'urgent',
  'critical', // non-canonical — should never appear as enum value
  'normal', // non-canonical — should never appear as enum value
] as const;

const CANONICAL_SET = new Set<string>([
  ...TASK_STATUSES,
  ...TASK_PRIORITIES,
]);

/**
 * Allowlist of English-prose false positives. Each entry is matched with
 * `String.prototype.includes` against the line of skill source — when ANY
 * matches the line, that line is excluded from enum-value scanning.
 *
 * Keep this list tight. Each entry should represent a verifiable
 * English-language usage of the word, NOT an enum value list.
 */
const PROSE_ALLOWLIST: ReadonlyArray<{
  file: string;
  contains: string;
}> = [
  // done.md — "normal flow" and "normal completion flow" are English prose
  { file: 'done.md', contains: 'normal flow' },
  { file: 'done.md', contains: 'normal completion flow' },
  // pick-up.md — "normal pickup" is English prose
  { file: 'pick-up.md', contains: 'normal pickup' },
  // log-bug.md — "with high priority" / "high-priority" describe behavior,
  // not an enum citation. They are also valid canonical members so they
  // are not blocked by this test, but keeping them explicit here documents
  // intent.
];

interface SkillFinding {
  file: string;
  line: number;
  token: string;
  raw: string;
}

function isLineProseAllowlisted(file: string, line: string): boolean {
  return PROSE_ALLOWLIST.some(
    (entry) => entry.file === file && line.includes(entry.contains),
  );
}

function scanSkillFile(filePath: string): SkillFinding[] {
  const fileName = filePath.split('/').pop() ?? filePath;
  const text = readFileSync(filePath, 'utf8');
  const findings: SkillFinding[] = [];

  text.split('\n').forEach((line, idx) => {
    if (isLineProseAllowlisted(fileName, line)) return;

    for (const token of CANDIDATE_TOKENS) {
      // Word-boundary match on the bare token. We rely on the underscore
      // in `in_progress` keeping word boundaries simple — `\b` in JS regex
      // treats `_` as a word char, so `\bin_progress\b` is what we want.
      const re = new RegExp(`\\b${token}\\b`);
      if (re.test(line)) {
        findings.push({ file: fileName, line: idx + 1, token, raw: line });
      }
    }
  });

  return findings;
}

describe('skill enum-value consistency (#347)', () => {
  // Non-invocable doc files (frontmatter `disable-model-invocation: true`) are
  // filtered from the invocable-skill surface. `_enums.md` is the original
  // precedent; `loop-shared.md` was added in task #346 (loop.md refactor) to
  // host shared reference contracts between `/tasks:loop` and `/tasks:loop-dag`.
  const NON_INVOCABLE_DOCS: ReadonlySet<string> = new Set([
    '_enums.md',
    'loop-shared.md',
  ]);
  const skillFiles = readdirSync(SKILLS_DIR)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => !NON_INVOCABLE_DOCS.has(name));

  it('discovers all 14 shipped skill files (sanity: install.sh source set)', () => {
    expect(skillFiles.length).toBe(14);
  });

  it('every status/priority token in skills/tasks/*.md is a subset of canonical enums', () => {
    const offenders: SkillFinding[] = [];

    for (const fileName of skillFiles) {
      const findings = scanSkillFile(resolve(SKILLS_DIR, fileName));
      for (const finding of findings) {
        if (!CANONICAL_SET.has(finding.token)) {
          offenders.push(finding);
        }
      }
    }

    if (offenders.length > 0) {
      const formatted = offenders
        .map(
          (o) =>
            `  ${o.file}:${o.line}  token="${o.token}"  line=${JSON.stringify(o.raw.trim())}`,
        )
        .join('\n');
      throw new Error(
        `Found non-canonical enum-shaped tokens in skill files. The canonical source is src/types/task.ts; see skills/tasks/_enums.md. If a hit is English prose, add it to PROSE_ALLOWLIST in this test.\n\n${formatted}`,
      );
    }

    expect(offenders).toEqual([]);
  });

  it('canonical _enums.md doc exists and cites src/types/task.ts', () => {
    const enumsDoc = readFileSync(
      resolve(SKILLS_DIR, '_enums.md'),
      'utf8',
    );
    expect(enumsDoc).toContain('src/types/task.ts');
    expect(enumsDoc).toContain('TASK_STATUSES');
    expect(enumsDoc).toContain('TASK_PRIORITIES');
    expect(enumsDoc).toMatch(/disable-model-invocation:\s*true/);
    // Every canonical value must appear verbatim in the doc body.
    for (const value of TASK_STATUSES) {
      expect(enumsDoc).toContain(`\`${value}\``);
    }
    for (const value of TASK_PRIORITIES) {
      expect(enumsDoc).toContain(`\`${value}\``);
    }
  });
});
