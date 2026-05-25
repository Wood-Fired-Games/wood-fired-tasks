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
