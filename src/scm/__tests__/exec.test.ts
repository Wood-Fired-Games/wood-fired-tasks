import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOWED_BINARIES, buildChildEnv, escalateKill, execScm, scrubSecrets } from '../exec.js';
import { ScmError } from '../types.js';

const repos: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scm-exec-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  repos.push(dir);
  return dir;
}

afterEach(() => {
  while (repos.length > 0) {
    const dir = repos.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('execScm — argv safety (§6.1 argv-array only)', () => {
  it('passes a command-substitution filename through literally — no shell evaluation', async () => {
    const repo = makeRepo();
    const hostile = '$(touch pwned).txt';
    writeFileSync(join(repo, hostile), 'x');

    const add = await execScm('git', ['add', '--', hostile], { cwd: repo });
    expect(add.code).toBe(0);

    const status = await execScm('git', ['status', '--porcelain'], { cwd: repo });
    expect(status.code).toBe(0);
    // The literal name is staged...
    expect(status.stdout).toContain('$(touch pwned).txt');
    // ...and the injected `touch pwned` was NEVER executed.
    expect(existsSync(join(repo, 'pwned'))).toBe(false);
  });

  it('passes a leading-dash filename through literally after the `--` terminator', async () => {
    const repo = makeRepo();
    const hostile = '--not-a-flag';
    writeFileSync(join(repo, hostile), 'x');

    const add = await execScm('git', ['add', '--', hostile], { cwd: repo });
    expect(add.code).toBe(0);

    const status = await execScm('git', ['status', '--porcelain'], { cwd: repo });
    expect(status.stdout).toContain('--not-a-flag');
  });
});

describe('execScm — binary allowlist (§6.1)', () => {
  it('rejects a binary that is not on the allowlist', async () => {
    await expect(execScm('rm', ['-rf', '/tmp/nope'], { cwd: tmpdir() })).rejects.toThrow(
      /allowlist/,
    );
  });

  it('rejects a path-like argv[0] (absolute path)', async () => {
    await expect(execScm('/usr/bin/git', ['status'], { cwd: tmpdir() })).rejects.toThrow(
      /path-like/,
    );
  });

  it('rejects a path-like argv[0] (relative ./)', async () => {
    await expect(execScm('./git', ['status'], { cwd: tmpdir() })).rejects.toThrow(/path-like/);
  });

  it('requires a pinned cwd', async () => {
    await expect(execScm('git', ['status'], { cwd: '' })).rejects.toThrow(/cwd/);
  });

  it('exposes exactly git, p4, gh as the allowlist', () => {
    expect([...ALLOWED_BINARIES]).toEqual(['git', 'p4', 'gh']);
  });
});

describe('execScm — non-zero exit propagation (§6.1)', () => {
  it('surfaces a non-zero exit as a structured result rather than throwing', async () => {
    const repo = makeRepo();
    const res = await execScm('git', ['rev-parse', '--verify', 'refs/heads/does-not-exist'], {
      cwd: repo,
    });
    expect(res.code).not.toBe(0);
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  it('maps a missing binary to ScmError(BACKEND_UNAVAILABLE)', async () => {
    // `gh` is allowlisted but not installed in this environment → ENOENT.
    // Skip if gh happens to be present so the assertion stays meaningful.
    let ghPresent = false;
    try {
      execFileSync('gh', ['--version'], { stdio: 'ignore' });
      ghPresent = true;
    } catch {
      ghPresent = false;
    }
    if (ghPresent) return;

    await expect(execScm('gh', ['--version'], { cwd: tmpdir() })).rejects.toMatchObject({
      name: 'ScmError',
      code: 'BACKEND_UNAVAILABLE',
    });
  });
});

describe('execScm — timeout contract (§6.1)', () => {
  it('rejects with ScmError(TIMEOUT) and kills a hung child within the timeout window', async () => {
    const repo = makeRepo();
    // `git commit` with no -m opens the editor and waits for it. Point the
    // editor (via GIT_EDITOR, which execScm propagates from the parent env) at
    // a long sleep so the command hangs deterministically. The inner `sh -c`
    // swallows the appended COMMIT_EDITMSG path as `$0`.
    const prevEditor = process.env['GIT_EDITOR'];
    process.env['GIT_EDITOR'] = 'sh -c "sleep 30"';
    try {
      const start = Date.now();
      const promise = execScm('git', ['commit', '--allow-empty'], {
        cwd: repo,
        timeoutMs: 300,
        killGraceMs: 200,
      });
      await expect(promise).rejects.toBeInstanceOf(ScmError);
      await promise.catch((err: ScmError) => {
        expect(err.code).toBe('TIMEOUT');
      });
      // Must have fired the timeout, not waited for the 30s sleep.
      expect(Date.now() - start).toBeLessThan(5_000);
    } finally {
      if (prevEditor === undefined) delete process.env['GIT_EDITOR'];
      else process.env['GIT_EDITOR'] = prevEditor;
    }
  });
});

describe('escalateKill — SIGTERM→SIGKILL escalation (§6.1)', () => {
  it('escalates to SIGKILL for a child that ignores SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { stdio: 'ignore' },
    );
    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once('exit', (_code, signal) => resolve(signal));
    });
    // Give the child a moment to install its SIGTERM handler.
    await new Promise((r) => setTimeout(r, 150));
    escalateKill(child, 200);
    const signal = await exited;
    expect(signal).toBe('SIGKILL');
  });
});

describe('execScm — output cap (§6.1)', () => {
  it('fails cleanly when stdout exceeds the cap', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'big.txt'), 'A'.repeat(50_000));
    execFileSync('git', ['add', 'big.txt'], { cwd: repo });
    // `git diff --cached` prints the whole added file (~50 KB) to stdout.
    await expect(
      execScm('git', ['diff', '--cached'], { cwd: repo, maxBufferBytes: 1024 }),
    ).rejects.toThrow(/cap/);
  });
});

describe('env hygiene + secret scrubbing (§6.1)', () => {
  it('buildChildEnv strips P4PASSWD (case-insensitive) and keeps everything else', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      P4PASSWD: 'super-secret',
      p4passwd: 'also-secret',
      FOO: 'bar',
    });
    expect(env['P4PASSWD']).toBeUndefined();
    expect(env['p4passwd']).toBeUndefined();
    expect(env['FOO']).toBe('bar');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('scrubSecrets masks P4PASSWD values before they leave the wrapper', () => {
    expect(scrubSecrets('fatal: P4PASSWD=hunter2 rejected')).toBe('fatal: P4PASSWD=*** rejected');
    expect(scrubSecrets('P4PASSWD=abc123')).not.toContain('abc123');
  });
});
