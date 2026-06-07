import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { isMainThread } from 'node:worker_threads';
import { resolveAssetPath, skillsDir, packageRoot } from '../resolve.js';

// The cwd-independence tests must change the working directory, which throws
// inside worker_threads. Stryker's vitest runner forces pool:'threads' for its
// mutation dry run (task #823), so those tests skip there and run fully under
// normal `npm test` (forks pool / main thread). src/assets/** is not in any
// mutation shard, so skipping them under Stryker costs no mutation coverage.
describe('assets/resolve', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    // Always restore the original working directory (no-op when chdir is
    // unsupported, i.e. running inside a worker thread).
    if (isMainThread) process.chdir(originalCwd);
  });

  it.skipIf(!isMainThread)(
    'resolves an existing skills directory when run from a temp cwd outside the repo',
    () => {
      let resolved: string;
      try {
        // chdir into an OS temp dir that lives outside the repo tree.
        process.chdir(tmpdir());
        resolved = skillsDir();
      } finally {
        process.chdir(originalCwd);
      }

      expect(isAbsolute(resolved)).toBe(true);
      expect(existsSync(resolved)).toBe(true);
      // Sanity: the repo ships skills/tasks/ under the package root today.
      expect(existsSync(resolveAssetPath('skills', 'tasks'))).toBe(true);
    },
  );

  it.skipIf(!isMainThread)('is cwd-independent: same result from temp dir and repo root', () => {
    process.chdir(tmpdir());
    const fromTemp = skillsDir();
    process.chdir(originalCwd);
    const fromRepo = skillsDir();

    expect(fromTemp).toBe(fromRepo);
  });

  it('computes package root from import.meta.url, not process.cwd()', () => {
    expect(isAbsolute(packageRoot)).toBe(true);
    // The resolver source must not reference process.cwd().
    const src = readFileSync(fileURLToPath(new URL('../resolve.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('process.cwd');
  });
});
