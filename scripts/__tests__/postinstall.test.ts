import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Absolute path to scripts/postinstall.cjs (resolved from this test's own
// location — repo root is two levels up from scripts/__tests__/).
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'postinstall.cjs',
);

describe('postinstall script (task #752)', () => {
  it('prints exactly one notice line pointing at `wood-fired-tasks setup`', () => {
    const out = execFileSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
    });
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(out).toContain('wood-fired-tasks setup');
  });

  it('has NO file-system side effects (writes nothing to its cwd)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-postinstall-'));
    try {
      const before = fs.readdirSync(tmp).sort();
      expect(before).toEqual([]);

      // Run with cwd inside the empty temp dir; capture (ignore) stdout.
      execFileSync(process.execPath, [scriptPath], {
        cwd: tmp,
        encoding: 'utf8',
      });

      // The temp cwd must be untouched: no files/dirs created.
      const after = fs.readdirSync(tmp).sort();
      expect(after).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
