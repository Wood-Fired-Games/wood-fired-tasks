import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isEntryPoint } from '../wft-router.js';

// Regression guard for the bundled bin: when wft-router ships inside the
// wood-fired-tasks package, it is invoked via an npm bin symlink
// (node_modules/.bin/wft-router). `process.argv[1]` is then the symlink path,
// not the real dist file, so a naive identity check made `main()` never fire
// and the bin was a silent no-op when installed.
describe('isEntryPoint (bundled-bin symlink resolution)', () => {
  let dir: string;
  let real: string;
  let link: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wft-router-bin-'));
    real = join(dir, 'wft-router.js');
    link = join(dir, 'wft-router-link');
    writeFileSync(real, '// entry');
    symlinkSync(real, link);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches when argv[1] is the real path', () => {
    expect(isEntryPoint(pathToFileURL(real).href, real)).toBe(true);
  });

  it('matches when argv[1] is a symlink to the real entry (the install case)', () => {
    // import.meta.url resolves to the real file; argv[1] is the symlink.
    expect(isEntryPoint(pathToFileURL(real).href, link)).toBe(true);
  });

  it('does not match an unrelated entry', () => {
    expect(isEntryPoint(pathToFileURL(real).href, join(dir, 'other.js'))).toBe(false);
  });

  it('returns false when there is no entry (imported, not run)', () => {
    expect(isEntryPoint(pathToFileURL(real).href, undefined)).toBe(false);
  });
});
