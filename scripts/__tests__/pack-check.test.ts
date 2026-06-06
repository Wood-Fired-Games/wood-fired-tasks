import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Absolute path to scripts/pack-check.mjs (resolved from this test's own
// location — repo root is two levels up from scripts/__tests__/).
const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(scriptsDir, '..');
const scriptPath = path.join(scriptsDir, 'pack-check.mjs');

// The pack-check script shells out to `npm pack --dry-run`, which only yields a
// meaningful file list once the project has been built (dist/ must exist). When
// dist/ is absent (e.g. a checkout that hasn't run `npm run build`), skip rather
// than produce a false failure.
const distBuilt =
  fs.existsSync(path.join(repoRoot, 'dist')) &&
  fs.existsSync(path.join(repoRoot, 'dist', 'skills', 'tasks')) &&
  fs.existsSync(path.join(repoRoot, 'dist', 'skills', 'agents'));

describe.skipIf(!distBuilt)('pack:check tarball hygiene guard (task #744)', () => {
  it('exits 0 on the real, clean package and reports no violations', () => {
    const out = execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(out).toContain('pack:check OK');
    expect(out).toContain('no test/spec');
    expect(out).toContain('no sourcemaps');
    expect(out).toContain('no client-package');
  });

  it('asserts the shipped skills (tasks + agents) are present in the tarball', () => {
    const out = execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    // The OK line embeds the per-skill counts; both must be > 0.
    const m = out.match(/(\d+) tasks-skill \+ (\d+) agents-skill/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(0);
    expect(Number(m?.[2])).toBeGreaterThan(0);
  });
});
