import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoneBackend } from '../none.js';
import { ScmError, type ScmVerbContext } from '../types.js';

/**
 * Fixtures build a throwaway repo root under the OS temp dir and exercise the
 * none backend's pure-filesystem manifest flow: baseline → mutate → changed-files
 * → change-id. `--context` is fixed so the manifest lands at a known path.
 */
describe('none SCM backend (task #1531)', () => {
  let root: string;
  const backend = new NoneBackend();

  function ctx(context = 'task-1531'): ScmVerbContext {
    return { repo: root, context };
  }

  function write(relPath: string, contents: string): void {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scm-none-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('baseline → changed-files (modified file is dirty) → change-id is empty', async () => {
    write('src/app.ts', 'export const answer = 41;\n');
    write('README.md', '# demo\n');

    const baseline = await backend.baseline(ctx());
    expect(baseline.id).toMatch(/^none:[0-9a-f]{64}$/);
    expect(baseline.manifestPath).toBe(join('.tasks', '.scm', 'task-1531', 'baseline.json'));

    // Modify a tracked file so its bytes (and sha256) change.
    write('src/app.ts', 'export const answer = 42;\n');

    const changed = await backend.changedFiles(ctx(), baseline.id);
    expect(changed.base).toBe(baseline.id);
    expect(changed.files).toContainEqual({ path: 'src/app.ts', change: 'modified' });
    // The untouched file must NOT appear.
    expect(changed.files.map((f) => f.path)).not.toContain('README.md');

    // none-mode has no change identifiers: empty array (exit 0 at the CLI layer).
    const ids = await backend.changeId(ctx());
    expect(ids).toEqual({ ids: [] });
  });

  it('changed-files reports added and deleted paths', async () => {
    write('keep.txt', 'stable\n');
    write('gone.txt', 'temporary\n');
    const baseline = await backend.baseline(ctx());

    rmSync(join(root, 'gone.txt'));
    write('fresh.txt', 'new\n');

    const changed = await backend.changedFiles(ctx(), baseline.id);
    expect(changed.files).toContainEqual({ path: 'fresh.txt', change: 'added' });
    expect(changed.files).toContainEqual({ path: 'gone.txt', change: 'deleted' });
    expect(changed.files.map((f) => f.path)).not.toContain('keep.txt');
  });

  it('excludes adapter runtime state and .git from the manifest diff', async () => {
    write('code.ts', 'x\n');
    const baseline = await backend.baseline(ctx());

    // .tasks/.scm/ is where the manifest itself lives; a .git dir may coexist.
    write('.git/HEAD', 'ref: refs/heads/main\n');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports={}\n', 'utf8');

    const changed = await backend.changedFiles(ctx(), baseline.id);
    const paths = changed.files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.tasks/.scm/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
  });

  it('records symlink targets without following them', async () => {
    write('real.txt', 'payload\n');
    symlinkSync('real.txt', join(root, 'link.txt'));
    const baseline = await backend.baseline(ctx());

    // Re-point the symlink at a different target → its recorded digest changes.
    rmSync(join(root, 'link.txt'));
    symlinkSync('README.md', join(root, 'link.txt'));

    const changed = await backend.changedFiles(ctx(), baseline.id);
    expect(changed.files).toContainEqual({ path: 'link.txt', change: 'modified' });
  });

  it('status mirrors changed-files as {path, state} entries', async () => {
    write('a.txt', '1\n');
    await backend.baseline(ctx());
    write('a.txt', '2\n');

    const status = await backend.status(ctx());
    expect(status.dirty).toBe(true);
    expect(status.entries).toContainEqual({ path: 'a.txt', state: 'modified' });
  });

  it('detects a same-size rewrite that keeps the exact baseline mtime (racy-clean)', async () => {
    // Deterministically reproduce the same-tick, same-size false-negative the
    // fast path used to miss — independent of filesystem mtime granularity. We
    // rewrite the file to different bytes of identical length, then rebuild the
    // manifest so the recorded entry's size+mtime EXACTLY match the file on disk
    // AND the entry is "racy" (recorded mtimeMs >= capturedAtMs). The fast path's
    // size+mtime guard then matches exactly, so a pass can ONLY come from
    // racy-clean re-hashing (recorded.mtimeMs >= capturedAtMs), never a mismatch.
    const abs = join(root, 'racy.txt');
    write('racy.txt', 'AAAA\n');
    const baseline = await backend.baseline(ctx('racy'));

    const manifestPath = join(root, '.tasks', '.scm', 'racy', 'baseline.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      capturedAtMs: number;
      entries: { path: string; size: number; mtimeMs: number; sha256: string }[];
    };
    const entry = manifest.entries.find((e) => e.path === 'racy.txt');
    if (entry === undefined) {
      throw new Error('racy.txt missing from manifest');
    }

    // Rewrite content (same 5 bytes) at a fixed, coarse mtime, then read back the
    // actual on-disk mtime the filesystem settled on.
    writeFileSync(abs, 'BBBB\n', 'utf8');
    expect(statSync(abs).size).toBe(5);
    utimesSync(abs, 1_000_000, 1_000_000);
    const onDiskMtimeMs = statSync(abs).mtimeMs;

    // Point the recorded entry at the exact on-disk size+mtime (fast path would
    // reuse the stale 'AAAA' hash) and mark the whole manifest racy for it.
    entry.size = 5;
    entry.mtimeMs = onDiskMtimeMs;
    manifest.capturedAtMs = onDiskMtimeMs; // recorded.mtimeMs >= capturedAtMs ⇒ racy.
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const changed = await backend.changedFiles(ctx('racy'), baseline.id);
    expect(changed.files).toContainEqual({ path: 'racy.txt', change: 'modified' });
    const status = await backend.status(ctx('racy'));
    expect(status.dirty).toBe(true);
  });

  it('detect reports none defaults with shared isolation', async () => {
    const detect = await backend.detect(ctx());
    expect(detect.backend).toBe('none');
    expect(detect.capabilities.isolation).toBe('shared');
    expect(detect.behaviors).toEqual({
      commit: false,
      isolate: false,
      publish: false,
      openReview: false,
      branchPerRun: false,
    });
  });

  it('mutating verbs are no-ops', async () => {
    expect(await backend.record(ctx(), 'msg')).toEqual({
      recorded: false,
      changeId: null,
      mode: 'noop',
    });
    expect(await backend.publish(ctx())).toEqual({ published: false, changeId: null });
    expect(await backend.openReview(ctx())).toEqual({ opened: false, url: null });
    expect(await backend.stage(ctx(), ['src/app.ts'])).toEqual({ staged: [] });
    expect(await backend.isolate(ctx(), 'w1')).toEqual({ strategy: 'shared' });
    expect(await backend.teardownIsolation(ctx(), 'w1')).toEqual({ tornDown: true });
  });

  it('stage rejects excluded paths (surfaces the bug)', async () => {
    await expect(backend.stage(ctx(), ['LOOP-RUN.md'])).rejects.toBeInstanceOf(ScmError);
  });

  it('reset-hard is unsupported in none-mode', async () => {
    await expect(backend.resetHard(ctx(), 'HEAD')).rejects.toMatchObject({
      name: 'ScmError',
      code: 'UNSUPPORTED_VERB',
    });
  });
});
