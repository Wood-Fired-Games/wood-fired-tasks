/**
 * CLI dispatcher tests for `tasks scm <verb>` (task #1536 — P1 keystone).
 *
 * These drive the REAL `scmCommand` in-process via Commander's `parseAsync`
 * against real temp fixtures (a `git init` dir for the git backend; a plain dir
 * for the none backend) — no mocks of the backends. Each assertion inspects the
 * single-line §4.1 JSON envelope the command prints on stdout plus the
 * `process.exitCode` it sets. Perforce dispatch is covered by the sibling
 * `scm-perforce.test.ts` (task #1542).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scmCommand } from '../commands/scm.js';

const dirs: string[] = [];

/** A plain temp dir with no SCM markers — resolves to the `none` backend. */
function makeNoneRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scm-cli-none-'));
  dirs.push(dir);
  return dir;
}

/** A `git init` temp repo with one commit — resolves to the `git` backend. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scm-cli-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  dirs.push(dir);
  return dir;
}

interface RunResult {
  stdout: string;
  envelope: Record<string, unknown>;
  exitCode: number;
}

/**
 * Invoke the real `scmCommand` with the given args, capturing the printed
 * envelope and the resulting exit code. stdout/stderr are spied so nothing
 * leaks into the test reporter.
 */
async function runScm(...args: string[]): Promise<RunResult> {
  const stdoutChunks: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  process.exitCode = 0;
  try {
    await scmCommand.parseAsync(['node', 'scm', ...args]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;

  const stdout = stdoutChunks.join('');
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  // Exactly one JSON object on stdout (§4.1).
  expect(lines).toHaveLength(1);
  const envelope = JSON.parse(lines[0]) as Record<string, unknown>;
  return { stdout, envelope, exitCode };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('scm CLI dispatcher — git backend', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeGitRepo();
  });

  it('detect → git success envelope, exit 0', async () => {
    const { envelope, exitCode } = await runScm('detect', '--repo', repo);
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.verb).toBe('detect');
    expect(envelope.backend).toBe('git');
    expect(envelope.context).toBe('default');
    const data = envelope.data as Record<string, unknown>;
    expect(data.backend).toBe('git');
    expect(envelope.warnings).toEqual([]);
  });

  it('baseline → returns a bare sha id, exit 0', async () => {
    const { envelope, exitCode } = await runScm('baseline', '--repo', repo);
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.verb).toBe('baseline');
    expect(envelope.backend).toBe('git');
    const data = envelope.data as Record<string, unknown>;
    expect(typeof data.id).toBe('string');
    expect((data.id as string).length).toBeGreaterThan(0);
  });

  it('changed-files <base> → empty diff against HEAD, exit 0', async () => {
    const { envelope, exitCode } = await runScm('changed-files', 'HEAD', '--repo', repo);
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.verb).toBe('changed-files');
    expect(envelope.backend).toBe('git');
    const data = envelope.data as Record<string, unknown>;
    expect(data.base).toBe('HEAD');
    expect(data.files).toEqual([]);
  });

  it('record on a detached HEAD → non-empty envelope warnings[] referencing detached HEAD (§2.4)', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-q', head], { cwd: repo }); // detach
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    execFileSync('git', ['add', '--', 'b.txt'], { cwd: repo });

    const { envelope, exitCode } = await runScm(
      'record',
      'detached commit',
      '--repo',
      repo,
      '--context',
      'detached-smoke',
    );
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as Record<string, unknown>;
    expect(data.recorded).toBe(true);
    const warnings = envelope.warnings as string[];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /detached HEAD/.test(w))).toBe(true);
  });
});

describe('scm CLI dispatcher — none backend', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeNoneRepo();
  });

  it('detect → none success envelope, exit 0', async () => {
    const { envelope, exitCode } = await runScm('detect', '--repo', repo);
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.verb).toBe('detect');
    expect(envelope.backend).toBe('none');
    const data = envelope.data as Record<string, unknown>;
    expect(data.backend).toBe('none');
    expect((data.capabilities as Record<string, unknown>).isolation).toBe('shared');
  });

  it('baseline → writes a manifest, none:<digest> id, exit 0', async () => {
    const { envelope, exitCode } = await runScm('baseline', '--repo', repo);
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.backend).toBe('none');
    const data = envelope.data as Record<string, unknown>;
    expect(data.id as string).toMatch(/^none:[0-9a-f]{64}$/);
    expect(typeof data.manifestPath).toBe('string');
  });

  it('changed-files <base> after baseline → empty change set, exit 0', async () => {
    await runScm('baseline', '--repo', repo);
    const { envelope, exitCode } = await runScm('changed-files', 'BASE', '--repo', repo);
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.verb).toBe('changed-files');
    expect(envelope.backend).toBe('none');
    const data = envelope.data as Record<string, unknown>;
    expect(data.base).toBe('BASE');
    expect(data.files).toEqual([]);
  });

  it('honors --context in the envelope', async () => {
    const { envelope } = await runScm('baseline', '--repo', repo, '--context', 'run-7');
    expect(envelope.context).toBe('run-7');
  });
});

describe('scm CLI dispatcher — error mapping', () => {
  it('unknown verb → failure envelope, exit 2 (USAGE_OR_CONFIG_ERROR)', async () => {
    const repo = makeGitRepo();
    const { envelope, exitCode } = await runScm('frobnicate', '--repo', repo);
    expect(exitCode).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.verb).toBe('frobnicate');
    const error = envelope.error as Record<string, unknown>;
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('unknown verb');
  });

  it('none-mode reset-hard → UNSUPPORTED_VERB failure envelope, exit 4', async () => {
    const repo = makeNoneRepo();
    const { envelope, exitCode } = await runScm('reset-hard', 'HEAD', '--repo', repo);
    expect(exitCode).toBe(4);
    expect(envelope.ok).toBe(false);
    expect(envelope.backend).toBe('none');
    const error = envelope.error as Record<string, unknown>;
    expect(error.code).toBe('UNSUPPORTED_VERB');
  });

  it('changed-files with no <base> arg → usage error, exit 2', async () => {
    const repo = makeNoneRepo();
    const { envelope, exitCode } = await runScm('changed-files', '--repo', repo);
    expect(exitCode).toBe(2);
    expect(envelope.ok).toBe(false);
    const error = envelope.error as Record<string, unknown>;
    expect(error.code).toBe('CONFIG_INVALID');
  });
});

describe('scm CLI dispatcher — --charter-scm (task #1550)', () => {
  it('a valid --charter-scm hint resolves the charter backend for a no-marker repo', async () => {
    const repo = makeNoneRepo();
    const { envelope, exitCode } = await runScm(
      'detect',
      '--repo',
      repo,
      '--charter-scm',
      JSON.stringify({ backend: 'perforce' }),
    );
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.backend).toBe('perforce');
  });

  it('a --charter-scm hint is ignored when an on-disk marker is present (marker wins)', async () => {
    const repo = makeGitRepo();
    const { envelope, exitCode } = await runScm(
      'detect',
      '--repo',
      repo,
      '--charter-scm',
      JSON.stringify({ backend: 'perforce' }),
    );
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.backend).toBe('git');
  });

  it('a charter/marker conflict surfaces a non-empty envelope warnings[] (§2.4)', async () => {
    const repo = makeGitRepo();
    const { envelope, exitCode } = await runScm(
      'detect',
      '--repo',
      repo,
      '--charter-scm',
      JSON.stringify({ backend: 'perforce' }),
    );
    expect(exitCode).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.backend).toBe('git');
    const warnings = envelope.warnings as string[];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /perforce/i.test(w) && /git/i.test(w))).toBe(true);
  });

  it('malformed --charter-scm JSON → CONFIG_INVALID failure envelope, exit 2', async () => {
    const repo = makeNoneRepo();
    const { envelope, exitCode } = await runScm(
      'detect',
      '--repo',
      repo,
      '--charter-scm',
      '{ not json',
    );
    expect(exitCode).toBe(2);
    expect(envelope.ok).toBe(false);
    const error = envelope.error as Record<string, unknown>;
    expect(error.code).toBe('CONFIG_INVALID');
  });

  it('a --charter-scm value failing schema validation → CONFIG_INVALID failure envelope, exit 2', async () => {
    const repo = makeNoneRepo();
    const { envelope, exitCode } = await runScm(
      'detect',
      '--repo',
      repo,
      '--charter-scm',
      JSON.stringify({ backend: 'svn' }),
    );
    expect(exitCode).toBe(2);
    expect(envelope.ok).toBe(false);
    const error = envelope.error as Record<string, unknown>;
    expect(error.code).toBe('CONFIG_INVALID');
  });
});
