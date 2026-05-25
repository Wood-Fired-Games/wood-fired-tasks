import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TASK_PRIORITIES, TASK_STATUSES } from '../../../../types/task.js';

/**
 * Client-package command drift gate.
 *
 * `scripts/build-client-package.sh` ships the 10 markdown command files under
 * `client-package/commands/tasks/*.md` to end users (plain `cp`, no transform).
 * A prior audit found these copies had drifted into pre-rename / pre-hardening
 * artifacts that shipped WRONG info: a non-canonical priority enum
 * (`critical, high, normal, low`), a hardcoded `"user"` identity anti-pattern,
 * and missing Preflight (identity resolution / ToolSearch recovery / transition
 * guards).
 *
 * The sibling test `skill-enums.test.ts` only scans `skills/tasks/`, so it
 * could NOT catch this — the client copies are a separate, independently-shipped
 * source set. This test closes that hole by asserting the shipped client copies:
 *
 *   1. contain no non-canonical status/priority enum token
 *      (`critical`, `normal`, `cancelled`, ...);
 *   2. never hardcode `"user"` as an identity VALUE
 *      (author / created_by / assignee = "user");
 *   3. carry no dev-only relative links that would 404 once installed
 *      standalone on a client machine (`_enums.md`, `../../src/...`,
 *      `../../docs/...`, `../agents/...`).
 *
 * Together these guarantee the distributable can never silently regress to the
 * audited-bad state again.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const CLIENT_DIR = resolve(REPO_ROOT, 'client-package/commands/tasks');
const SKILL_DIR = resolve(REPO_ROOT, 'skills/tasks');

// The intentional 10-command client surface (orchestrators loop/loop-dag/
// loop-shared, decompose, audit, and the non-invocable _enums doc are
// deliberately NOT shipped to clients — see build-client-package.sh).
const EXPECTED_CLIENT_COMMANDS = [
  'add-comment.md',
  'blocked.md',
  'create-task.md',
  'done.md',
  'log-bug.md',
  'my-work.md',
  'pick-up.md',
  'project-status.md',
  'search.md',
  'show-task.md',
] as const;

// Tokens considered candidates for "is this an enum value?". Includes the known
// historical-divergent values so the test surfaces them if they reappear.
const CANDIDATE_TOKENS = [
  'open',
  'in_progress',
  'done',
  'closed',
  'blocked',
  'backlogged',
  'cancelled', // non-canonical
  'low',
  'medium',
  'high',
  'urgent',
  'critical', // non-canonical
  'normal', // non-canonical
] as const;

const CANONICAL_SET = new Set<string>([...TASK_STATUSES, ...TASK_PRIORITIES]);

/**
 * Allowlist of English-prose false positives for the enum scan. Each entry is
 * matched with `includes` against a line; a match excludes that line. The
 * post-resync client copies replace the dev-only `_enums.md` citation with
 * inline guidance like "no `critical` (use `urgent`)" — legitimate prose, not
 * an enum value list, so it is whitelisted here.
 */
const ENUM_PROSE_ALLOWLIST: ReadonlyArray<{ file: string; contains: string }> =
  [
    { file: 'create-task.md', contains: 'no `critical`' },
    { file: 'log-bug.md', contains: 'no `critical`' },
    { file: 'search.md', contains: 'no `critical`' },
    { file: 'done.md', contains: 'normal flow' },
    { file: 'done.md', contains: 'normal completion flow' },
    { file: 'pick-up.md', contains: 'normal pickup' },
  ];

/**
 * Dev-only relative-link / source-path patterns that resolve in-repo but 404
 * once a command is installed standalone under `~/.claude/commands/tasks/`.
 * The resync inlined the enum values and stripped these refs; this guard keeps
 * them out for good.
 */
const FORBIDDEN_LINK_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'unshipped _enums.md link', re: /_enums\.md/ },
  { label: 'repo src/ path', re: /\.\.\/\.\.\/src\// },
  { label: 'repo docs/ path', re: /\.\.\/\.\.\/docs\// },
  { label: 'repo agents/ path', re: /\.\.\/agents\// },
  { label: 'src/types/task.ts source ref', re: /src\/types\/task\.ts/ },
  { label: 'src/schemas source ref', re: /src\/schemas/ },
];

/**
 * The hardcoded-identity anti-pattern: assigning the literal `user` as the
 * VALUE of an identity field. Catches `author: 'user'`, `created_by: "user"`,
 * `assignee: 'user'`, and YAML/object spellings — but NOT the safe warning
 * prose ("do NOT pass the literal \"user\"", "NOT the literal \"user\"").
 */
const HARDCODED_IDENTITY_RE =
  /\b(author|created_by|assignee)\b\s*[:=]\s*['"]user['"]/i;

interface Finding {
  file: string;
  line: number;
  detail: string;
  raw: string;
}

function readClientFiles(): string[] {
  return readdirSync(CLIENT_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

function isEnumLineAllowlisted(file: string, line: string): boolean {
  return ENUM_PROSE_ALLOWLIST.some(
    (entry) => entry.file === file && line.includes(entry.contains),
  );
}

describe('client-package command drift gate', () => {
  const clientFiles = readClientFiles();

  it('ships exactly the intended 10 client commands', () => {
    expect(clientFiles).toEqual([...EXPECTED_CLIENT_COMMANDS].sort());
  });

  it('contains no non-canonical status/priority enum token', () => {
    const offenders: Finding[] = [];

    for (const file of clientFiles) {
      const text = readFileSync(resolve(CLIENT_DIR, file), 'utf8');
      text.split('\n').forEach((line, idx) => {
        if (isEnumLineAllowlisted(file, line)) return;
        for (const token of CANDIDATE_TOKENS) {
          if (CANONICAL_SET.has(token)) continue; // only flag non-canonical
          if (new RegExp(`\\b${token}\\b`).test(line)) {
            offenders.push({
              file,
              line: idx + 1,
              detail: `non-canonical enum token "${token}"`,
              raw: line.trim(),
            });
          }
        }
      });
    }

    if (offenders.length > 0) {
      throw new Error(
        `Client commands contain non-canonical enum tokens (canonical source: src/types/task.ts). ` +
          `If a hit is English prose, add it to ENUM_PROSE_ALLOWLIST.\n\n` +
          offenders
            .map((o) => `  ${o.file}:${o.line}  ${o.detail}  ${JSON.stringify(o.raw)}`)
            .join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });

  it('never hardcodes "user" as an identity value', () => {
    const offenders: Finding[] = [];

    for (const file of clientFiles) {
      const text = readFileSync(resolve(CLIENT_DIR, file), 'utf8');
      text.split('\n').forEach((line, idx) => {
        if (HARDCODED_IDENTITY_RE.test(line)) {
          offenders.push({
            file,
            line: idx + 1,
            detail: 'hardcoded "user" identity value',
            raw: line.trim(),
          });
        }
      });
    }

    if (offenders.length > 0) {
      throw new Error(
        `Client commands hardcode the literal "user" as an identity value. ` +
          `Identity MUST be resolved at runtime (git email -> $USER -> claude-<model>).\n\n` +
          offenders
            .map((o) => `  ${o.file}:${o.line}  ${JSON.stringify(o.raw)}`)
            .join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });

  it('carries no dev-only relative links that break standalone install', () => {
    const offenders: Finding[] = [];

    for (const file of clientFiles) {
      const text = readFileSync(resolve(CLIENT_DIR, file), 'utf8');
      text.split('\n').forEach((line, idx) => {
        for (const { label, re } of FORBIDDEN_LINK_PATTERNS) {
          if (re.test(line)) {
            offenders.push({
              file,
              line: idx + 1,
              detail: label,
              raw: line.trim(),
            });
          }
        }
      });
    }

    if (offenders.length > 0) {
      throw new Error(
        `Client commands contain dev-only relative links/paths that 404 once installed ` +
          `standalone under ~/.claude/commands/tasks/. Inline the needed values instead.\n\n` +
          offenders
            .map((o) => `  ${o.file}:${o.line}  ${o.detail}  ${JSON.stringify(o.raw)}`)
            .join('\n'),
      );
    }
    expect(offenders).toEqual([]);
  });

  it('every command resolves a real identity in Preflight (no bare "user")', () => {
    // Positive assertion: each command that writes an identity field must
    // mention the runtime resolution chain. Read-only commands (search,
    // show-task, project-status) are exempt — they take no identity.
    const IDENTITY_WRITERS = [
      'add-comment.md',
      'blocked.md',
      'create-task.md',
      'done.md',
      'log-bug.md',
      'my-work.md',
      'pick-up.md',
    ];
    for (const file of IDENTITY_WRITERS) {
      const text = readFileSync(resolve(CLIENT_DIR, file), 'utf8');
      expect(text, `${file} must document identity resolution`).toMatch(
        /git config user\.email/,
      );
    }
  });
});

/**
 * Skills → client-package CONTENT-PARITY gate.
 *
 * The previous `describe` block above only proves the shipped client copies are
 * individually well-formed (no bad enum tokens, no hardcoded identity, no
 * dev-only links). It does NOT prove the client copy still says the SAME THING
 * as its `skills/tasks/<name>.md` dev original — an instruction sentence could
 * be dropped from (or added to) one side and every check above would still pass.
 *
 * Per `scripts/build-client-package.sh:95-138`, the client copies are the
 * SELF-CONTAINED, link-stripped source of truth. They are intentionally NOT
 * byte-identical to the skill originals: the build documents exactly one class
 * of divergence — the dev-only enum-citation lines (`_enums.md`,
 * `../../src/types/task.ts`, `src/schemas/...`) are stripped and the enum VALUES
 * are inlined as plain prose. Everything else (the workflow steps, the
 * transition rules, the example usage, the headings) MUST match verbatim.
 *
 * This gate compares the two sources after normalizing away ONLY that
 * documented transform, then asserts the remaining instruction content is
 * identical. The normalization is deliberately tight: it removes (a) any line
 * carrying a FORBIDDEN_LINK_PATTERN (the dev-only citation lines), (b) the
 * inlined-enum guidance lines that replace them on the client side, and (c) an
 * in-prose `(source: src/types/task.ts)` / `— see [_enums.md](...)` fragment
 * embedded mid-sentence (project-status). It does NOT absorb arbitrary content
 * differences: a dropped/added/changed instruction line on either side survives
 * normalization and reds the test (verified during development by injecting a
 * unique sentence into one client copy).
 */

// Lines that carry one of the dev-only citations the build strips. On the skill
// side these are whole "See [_enums.md] ... (source: src/types/task.ts)" lines;
// reuse the same FORBIDDEN_LINK_PATTERNS the hardening gate uses.
function lineHasForbiddenLink(line: string): boolean {
  return FORBIDDEN_LINK_PATTERNS.some(({ re }) => re.test(line));
}

// The inlined-enum guidance lines that REPLACE the stripped citation on the
// client side (and the skill's own pre-strip "Valid priority values:" line,
// which is part of the same enum-reference region). These restate canonical
// status/priority VALUES as prose; the actual canonical values are asserted by
// the enum-token gate above, so dropping them here loses no coverage.
const ENUM_INLINE_PATTERNS: ReadonlyArray<RegExp> = [
  /Canonical (task )?status(es)?\b/i,
  /Canonical priorit(y|ies)\b/i,
  /Canonical priority enum\b/i,
  /Canonical statuses are\b/i,
  /Valid priority values\b/i,
  /canonical status values\b/i,
];

function lineIsInlinedEnumGuidance(line: string): boolean {
  return ENUM_INLINE_PATTERNS.some((re) => re.test(line));
}

// Some skill sentences embed the citation mid-line (project-status) rather than
// on a dedicated line. Strip just the documented `(source: ...)` / `— see
// [_enums.md](...)` fragment so the surrounding shared prose still compares.
function stripInlineCitationFragment(line: string): string {
  return line
    .replace(
      /\s*[—–-]+\s*see \[_enums\.md\]\(_enums\.md\)[^.)]*?source:\s*`src\/types\/task\.ts`\)?/i,
      ')',
    )
    .replace(/\s*\(source:\s*`src\/types\/task\.ts`\)/i, '');
}

/**
 * Reduce a command file to its transform-invariant instruction content: strip
 * the documented enum-citation fragment from each line, drop dev-only-link
 * lines and inlined-enum-guidance lines, then drop blank lines so the
 * blank-line churn the enum-block substitution introduces (e.g. create-task
 * collapsing a 3-line block to 1 line) does not cause false mismatches.
 */
function normalizeCommandContent(text: string): string[] {
  return text
    .split('\n')
    .map(stripInlineCitationFragment)
    .filter((line) => !lineHasForbiddenLink(line))
    .filter((line) => !lineIsInlinedEnumGuidance(line))
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '');
}

describe('skills → client-package content parity', () => {
  it.each([...EXPECTED_CLIENT_COMMANDS])(
    '%s says the same thing in skills/ and client-package/ (modulo the documented enum-link transform)',
    (file) => {
      const skillText = readFileSync(resolve(SKILL_DIR, file), 'utf8');
      const clientText = readFileSync(resolve(CLIENT_DIR, file), 'utf8');

      const skillContent = normalizeCommandContent(skillText);
      const clientContent = normalizeCommandContent(clientText);

      // Compare the normalized instruction-line sequences. A real divergence —
      // an instruction present in one source but not the other, or reworded —
      // survives normalization (it is neither a dev-only link nor inlined-enum
      // guidance) and fails here. Joining with '\n' gives a readable line diff.
      expect(
        clientContent.join('\n'),
        `client-package/commands/tasks/${file} drifted from skills/tasks/${file} ` +
          `in non-enum/non-link content. The build transform only strips dev-only ` +
          `enum citations (see build-client-package.sh:95-138); any other difference ` +
          `is real drift — re-sync the client copy from the skill original.`,
      ).toEqual(skillContent.join('\n'));
    },
  );
});
