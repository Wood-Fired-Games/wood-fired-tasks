import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Exercises the client-side reference hook docs/hooks/validate-sha.mjs.
 *
 * The hook is a Claude Code PreToolUse guard: it reads a { tool_name,
 * tool_input } payload on stdin, extracts git-SHA-looking tokens from the
 * evidence field, and runs `git cat-file -t <sha>` in the client's cwd. A
 * nonexistent SHA -> deny decision on stdout; a real SHA (or none) -> allow
 * (exit 0, empty stdout).
 *
 * We build a throwaway git repo with exactly one real commit, capture its real
 * SHA, then drive the hook with a real-SHA payload (expect allow) and a
 * fabricated-SHA payload (expect deny). The hook's own git probe runs against
 * the temp repo because we set the child process cwd to it.
 */

// docs/hooks/validate-sha.mjs relative to this test file (src/__tests__/).
const HOOK_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'docs',
  'hooks',
  'validate-sha.mjs',
);

let repoDir: string;
let realSha: string;

/** Run the hook with the given payload, executing git inside `cwd`. */
function runHook(
  payload: unknown,
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [HOOK_PATH], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'validate-sha-hook-'));
  git(['init', '-q'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  writeFileSync(join(repoDir, 'file.txt'), 'hello\n');
  git(['add', 'file.txt'], repoDir);
  git(['commit', '-q', '-m', 'initial commit'], repoDir);
  realSha = git(['rev-parse', 'HEAD'], repoDir);
  expect(realSha).toMatch(/^[0-9a-f]{40}$/);
});

afterAll(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

describe('validate-sha.mjs PreToolUse hook', () => {
  it('allows update_task whose verification_evidence references a REAL sha', () => {
    const { status, stdout } = runHook(
      {
        tool_name: 'mcp__wood-fired-tasks__update_task',
        tool_input: {
          id: 608,
          verification_evidence: {
            note: `Implemented in commit ${realSha} (full) and ${realSha.slice(0, 8)} (short).`,
          },
        },
      },
      repoDir,
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('denies update_task whose verification_evidence references a FABRICATED sha', () => {
    const { status, stdout } = runHook(
      {
        tool_name: 'mcp__wood-fired-tasks__update_task',
        tool_input: {
          id: 608,
          verification_evidence: {
            note: 'Fixed in commit deadbeefdeadbeef per the audit.',
          },
        },
      },
      repoDir,
    );
    expect(status).toBe(0);
    const decision = JSON.parse(stdout);
    expect(decision.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('deadbeefdeadbeef');
  });

  it('denies add_comment whose content references a fabricated short sha', () => {
    const { status, stdout } = runHook(
      {
        tool_name: 'mcp__wood-fired-tasks__add_comment',
        tool_input: {
          task_id: 608,
          content: 'Done, see 2f9c1a4e for the fix.',
        },
      },
      repoDir,
    );
    expect(status).toBe(0);
    const decision = JSON.parse(stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('2f9c1a4e');
  });

  it('allows add_comment with no sha-looking tokens', () => {
    const { status, stdout } = runHook(
      {
        tool_name: 'mcp__wood-fired-tasks__add_comment',
        tool_input: { task_id: 608, content: 'Working on this now.' },
      },
      repoDir,
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('allows unrelated tools without scanning', () => {
    const { status, stdout } = runHook(
      {
        tool_name: 'mcp__wood-fired-tasks__create_task',
        tool_input: { title: 'deadbeefdeadbeef looks like a sha but is ignored' },
      },
      repoDir,
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('does not flag hex embedded inside a longer alphanumeric word', () => {
    // A UUID-ish token: its leading hex run abuts non-space chars, so it must
    // not be treated as a standalone SHA candidate -> allow.
    const { status, stdout } = runHook(
      {
        tool_name: 'mcp__wood-fired-tasks__add_comment',
        tool_input: {
          task_id: 608,
          content: 'session id deadbeef-1234-5678-9abc-def012345678 logged',
        },
      },
      repoDir,
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('allows evidence containing plain decimal numbers (not hex SHAs)', () => {
    // Regression: a row count, a Unix timestamp, a PID, or a dollar-in-micros
    // figure is a run of 7+ digits that matches the length window but has no
    // a-f letter. These are honest numeric evidence — exactly what the loop
    // records — and must NOT be treated as fabricated commit SHAs.
    const { status, stdout } = runHook(
      {
        tool_name: 'mcp__wood-fired-tasks__update_task',
        tool_input: {
          id: 608,
          verification_evidence: {
            note: 'Migrated 1234567 rows at ts 20260531; worker pid 9876543 exited 0.',
          },
        },
      },
      repoDir,
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('skips (allows) when cwd is not a git repo', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'validate-sha-nonrepo-'));
    try {
      const { status, stdout } = runHook(
        {
          tool_name: 'mcp__wood-fired-tasks__add_comment',
          tool_input: { task_id: 608, content: 'commit deadbeefdeadbeef' },
        },
        nonRepo,
      );
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
