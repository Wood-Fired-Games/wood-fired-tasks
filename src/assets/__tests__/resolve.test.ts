import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolveAssetPath, skillsDir, packageRoot } from '../resolve.js';

describe('assets/resolve', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    // Always restore the original working directory.
    process.chdir(originalCwd);
  });

  it('resolves an existing skills directory when run from a temp cwd outside the repo', () => {
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
  });

  it('is cwd-independent: same result from temp dir and repo root', () => {
    process.chdir(tmpdir());
    const fromTemp = skillsDir();
    process.chdir(originalCwd);
    const fromRepo = skillsDir();

    expect(fromTemp).toBe(fromRepo);
  });

  it('computes package root from import.meta.url, not process.cwd()', () => {
    expect(isAbsolute(packageRoot)).toBe(true);
    // The resolver source must not reference process.cwd().
    const src = readFileSync(
      fileURLToPath(new URL('../resolve.ts', import.meta.url)),
      'utf8',
    );
    expect(src).not.toContain('process.cwd');
  });
});
