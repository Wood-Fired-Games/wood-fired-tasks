import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { isMain } from '../is-main.js';

describe('isMain', () => {
  const originalArgv1 = process.argv[1];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'is-main-test-'));
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when process.argv[1] is undefined', () => {
    // Cast to satisfy strict types for the deliberate undefined.
    (process.argv as unknown as Array<string | undefined>)[1] = undefined;
    expect(isMain('file:///anywhere/index.js')).toBe(false);
  });

  it('returns true when the realpath of argv[1] equals fileURLToPath(metaUrl)', () => {
    const real = join(tmpDir, 'real.js');
    const link = join(tmpDir, 'link.js');
    writeFileSync(real, '// real entry');
    symlinkSync(real, link);

    // Simulate `node <symlink>`: argv[1] is the symlink, metaUrl is the realpath.
    process.argv[1] = link;
    const metaUrl = pathToFileURL(real).href;

    expect(isMain(metaUrl)).toBe(true);
  });

  it('returns false when realpathSync throws (argv[1] does not exist)', () => {
    process.argv[1] = join(tmpDir, 'does-not-exist.js');
    expect(isMain(pathToFileURL(join(tmpDir, 'whatever.js')).href)).toBe(
      false,
    );
  });

  it('returns false for an ordinary string mismatch', () => {
    const a = join(tmpDir, 'a.js');
    const b = join(tmpDir, 'b.js');
    writeFileSync(a, '');
    writeFileSync(b, '');

    process.argv[1] = a;
    expect(isMain(pathToFileURL(b).href)).toBe(false);
  });
});
