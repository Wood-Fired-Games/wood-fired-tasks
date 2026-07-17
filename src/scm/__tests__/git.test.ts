/**
 * Git backend tests (task #1535). Everything runs against a REAL fixture git
 * repo created with `git init` in a temp dir — no mocks — so the parity
 * assertions (AC2) compare the adapter's output to the equivalent raw `git`
 * command byte-for-byte.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_DEFAULT_BEHAVIORS, GitBackend } from '../git.js';
import { ScmError, type ScmVerbContext } from '../types.js';

const backend = new GitBackend();
const repos: string[] = [];

/** Run a raw git command in `repo` and return its trimmed stdout (the parity oracle). */
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

/** `git init` a fresh temp repo with a deterministic identity and default branch. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scm-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  repos.push(dir);
  return dir;
}

function ctxFor(repo: string, context = 'default'): ScmVerbContext {
  return { repo, context };
}

/** Write `content` to `<repo>/<rel>`, `git add` it, and commit — returns the commit sha. */
function commitFile(repo: string, rel: string, content: string, message: string): string {
  writeFileSync(join(repo, rel), content);
  execFileSync('git', ['add', '--', rel], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo });
  return git(repo, 'rev-parse', 'HEAD');
}

afterEach(() => {
  while (repos.length > 0) {
    const dir = repos.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('GitBackend — identity + detect (§3.3, §4.1)', () => {
  it('reports name "git"', () => {
    expect(backend.name).toBe('git');
  });

  it('detect returns git defaults + platform-worktree isolation capability', async () => {
    const repo = makeRepo();
    const data = await backend.detect(ctxFor(repo));
    expect(data.backend).toBe('git');
    expect(data.source).toBe('auto');
    expect(data.behaviors).toEqual(GIT_DEFAULT_BEHAVIORS);
    expect(data.behaviors.commit).toBe(true);
    expect(data.behaviors.isolate).toBe(true);
    expect(data.behaviors.publish).toBe(true);
    expect(data.capabilities.isolation).toBe('platform-worktree');
  });
});

describe('GitBackend — baseline parity (AC2)', () => {
  it('baseline.id is byte-identical to raw `git rev-parse HEAD`', async () => {
    const repo = makeRepo();
    const sha = commitFile(repo, 'a.txt', 'hello\n', 'init');
    const data = await backend.baseline(ctxFor(repo));
    expect(data.id).toBe(sha);
    expect(data.id).toBe(git(repo, 'rev-parse', 'HEAD'));
    // Bare 40-char SHA — no adornment (§5.1 parity).
    expect(data.id).toMatch(/^[0-9a-f]{40}$/);
  });

  it('baseline surfaces an unborn HEAD as ScmError(BACKEND_UNAVAILABLE)', async () => {
    const repo = makeRepo();
    await expect(backend.baseline(ctxFor(repo))).rejects.toMatchObject({
      name: 'ScmError',
      code: 'BACKEND_UNAVAILABLE',
    });
  });
});

describe('GitBackend — status (§4.1)', () => {
  it('clean tree → dirty:false, no entries', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    const data = await backend.status(ctxFor(repo));
    expect(data.dirty).toBe(false);
    expect(data.entries).toEqual([]);
  });

  it('untracked + modified files → dirty:true with porcelain states', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    const data = await backend.status(ctxFor(repo));
    expect(data.dirty).toBe(true);
    const byPath = new Map(data.entries.map((e) => [e.path, e.state]));
    expect(byPath.get('a.txt')).toBe(' M');
    expect(byPath.get('new.txt')).toBe('??');
  });
});

describe('GitBackend — changed-files parity (AC2)', () => {
  it('added/modified/deleted map correctly and match raw `git diff --name-only` byte-for-byte', async () => {
    const repo = makeRepo();
    commitFile(repo, 'keep.txt', 'one\n', 'init');
    commitFile(repo, 'gone.txt', 'bye\n', 'add gone');
    const base = git(repo, 'rev-parse', 'HEAD');

    // Second commit: modify keep, add fresh, delete gone.
    writeFileSync(join(repo, 'keep.txt'), 'two\n');
    writeFileSync(join(repo, 'fresh.txt'), 'brand new\n');
    execFileSync('git', ['rm', '-q', '--', 'gone.txt'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'churn'], { cwd: repo });

    const data = await backend.changedFiles(ctxFor(repo), base);
    expect(data.base).toBe(base);

    const byPath = new Map(data.files.map((f) => [f.path, f.change]));
    expect(byPath.get('keep.txt')).toBe('modified');
    expect(byPath.get('fresh.txt')).toBe('added');
    expect(byPath.get('gone.txt')).toBe('deleted');

    // AC2: the path set is byte-identical to raw `git diff --name-only <base>..HEAD`.
    const rawPaths = git(repo, 'diff', '--name-only', `${base}..HEAD`)
      .split('\n')
      .filter(Boolean)
      .sort();
    const ourPaths = data.files.map((f) => f.path).sort();
    expect(ourPaths).toEqual(rawPaths);
  });

  it('drops §4.4-excluded paths (e.g. .env) from the report', async () => {
    const repo = makeRepo();
    commitFile(repo, 'src.txt', 'code\n', 'init');
    const base = git(repo, 'rev-parse', 'HEAD');
    commitFile(repo, '.env', 'SECRET=1\n', 'add env');
    commitFile(repo, 'more.txt', 'more\n', 'add more');

    const data = await backend.changedFiles(ctxFor(repo), base);
    const paths = data.files.map((f) => f.path);
    expect(paths).toContain('more.txt');
    expect(paths).not.toContain('.env');
  });

  it('empty diff → files:[] (exit-0 empty result, §4.1)', async () => {
    const repo = makeRepo();
    const base = commitFile(repo, 'a.txt', 'x\n', 'init');
    const data = await backend.changedFiles(ctxFor(repo), base);
    expect(data.files).toEqual([]);
  });

  it('unknown base ref → ScmError(CONFIG_INVALID)', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    await expect(
      backend.changedFiles(ctxFor(repo), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    ).rejects.toMatchObject({ name: 'ScmError', code: 'CONFIG_INVALID' });
  });
});

describe('GitBackend — stage (§4.4)', () => {
  it('stages discrete paths via `git add --`', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    const data = await backend.stage(ctxFor(repo), ['b.txt']);
    expect(data.staged).toEqual(['b.txt']);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('b.txt');
  });

  it('empty file list is a no-op success', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    const data = await backend.stage(ctxFor(repo), []);
    expect(data.staged).toEqual([]);
  });

  it('rejects the whole call when an excluded path is present (CONFIG_INVALID)', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    writeFileSync(join(repo, '.env'), 'S=1\n');
    await expect(backend.stage(ctxFor(repo), ['.env'])).rejects.toMatchObject({
      name: 'ScmError',
      code: 'CONFIG_INVALID',
    });
  });
});

describe('GitBackend — record + change-id parity (AC2, §5.1)', () => {
  it('record commits staged work and returns the bare HEAD sha, matching raw git', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    writeFileSync(join(repo, 'a.txt'), 'y\n');
    await backend.stage(ctxFor(repo), ['a.txt']);

    const data = await backend.record(ctxFor(repo), 'my message');
    expect(data.recorded).toBe(true);
    expect(data.mode).toBe('commit');
    expect(data.changeId).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(data.changeId).toMatch(/^[0-9a-f]{40}$/);
    // The message went through as a discrete argv entry, verbatim.
    expect(git(repo, 'log', '-1', '--pretty=%s')).toBe('my message');
  });

  it('nothing staged → recorded:false, changeId:null, exit-0 success (§4.1)', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    const data = await backend.record(ctxFor(repo), 'noop');
    expect(data).toEqual({ recorded: false, changeId: null, mode: 'commit' });
  });

  it('record on a detached HEAD SUCCEEDS (§4.1 git edge case)', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    const head = git(repo, 'rev-parse', 'HEAD');
    execFileSync('git', ['checkout', '-q', head], { cwd: repo }); // detach
    expect(await backend.isDetachedHead(ctxFor(repo))).toBe(true);

    writeFileSync(join(repo, 'b.txt'), 'b\n');
    await backend.stage(ctxFor(repo), ['b.txt']);
    const data = await backend.record(ctxFor(repo), 'detached commit');
    expect(data.recorded).toBe(true);
    expect(data.changeId).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('change-id returns [bare HEAD sha] (§5.1 parity)', async () => {
    const repo = makeRepo();
    const sha = commitFile(repo, 'a.txt', 'x\n', 'init');
    const data = await backend.changeId(ctxFor(repo));
    expect(data.ids).toEqual([sha]);
  });
});

describe('GitBackend — publish (§4.1)', () => {
  it('no upstream and no origin → ScmError(NO_REMOTE)', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    await expect(backend.publish(ctxFor(repo))).rejects.toMatchObject({
      name: 'ScmError',
      code: 'NO_REMOTE',
    });
  });

  it('pushes to a local bare origin and returns the pushed HEAD sha', async () => {
    const repo = makeRepo();
    const sha = commitFile(repo, 'a.txt', 'x\n', 'init');
    const bare = mkdtempSync(join(tmpdir(), 'scm-git-bare-'));
    repos.push(bare);
    execFileSync('git', ['init', '-q', '--bare', bare], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });

    const data = await backend.publish(ctxFor(repo));
    expect(data.published).toBe(true);
    expect(data.changeId).toBe(sha);
    // Upstream was set as part of the --set-upstream fallback.
    expect(git(repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe(
      'origin/main',
    );
  });
});

describe('GitBackend — open-review (§4)', () => {
  it('default-off openReview → clean skip { opened:false, url:null } (no gh call)', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    const data = await backend.openReview(ctxFor(repo));
    expect(data).toEqual({ opened: false, url: null });
  });
});

describe('GitBackend — isolate / teardown (§4, §5.2)', () => {
  it('isolate reports platform-worktree without creating anything', async () => {
    const repo = makeRepo();
    const data = await backend.isolate(ctxFor(repo), 'iso-1');
    expect(data.strategy).toBe('platform-worktree');
    expect(data.path).toBeUndefined();
    expect(data.client).toBeUndefined();
  });

  it('teardown-isolation is a no-op success', async () => {
    const repo = makeRepo();
    const data = await backend.teardownIsolation(ctxFor(repo), 'iso-1');
    expect(data).toEqual({ tornDown: true });
  });
});

describe('GitBackend — reset-hard (§4)', () => {
  it('reset --hard <ref> restores the working tree to that ref', async () => {
    const repo = makeRepo();
    const base = commitFile(repo, 'a.txt', 'one\n', 'init');
    commitFile(repo, 'a.txt', 'two\n', 'second');

    const data = await backend.resetHard(ctxFor(repo), base);
    expect(data.reset).toBe(true);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(base);
  });

  it('unknown ref → ScmError(CONFIG_INVALID)', async () => {
    const repo = makeRepo();
    commitFile(repo, 'a.txt', 'x\n', 'init');
    await expect(backend.resetHard(ctxFor(repo), 'no-such-ref')).rejects.toBeInstanceOf(ScmError);
  });
});
