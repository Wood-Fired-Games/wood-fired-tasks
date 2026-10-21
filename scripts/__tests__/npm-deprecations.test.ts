import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  formatDeprecationReport,
  parseNpmInstallWarnings,
  splitSpec,
} from '../npm-deprecations.mjs';

// task #2132: the global-install-smoke guard that fails on any
// `npm warn deprecated` line from installing the packed tarball.
const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(scriptsDir, 'npm-deprecations.mjs');
const fixture280 = path.join(scriptsDir, '__tests__', 'fixtures', 'npm-install-2.8.0.txt');

const CLEAN =
  'added 351 packages in 9s\n\n42 packages are looking for funding\n  run `npm fund` for details\n';
const WINDOWS_CLEANUP = [
  'npm warn cleanup Failed to remove some directories [',
  'npm warn cleanup   [',
  "npm warn cleanup     'D:\\a\\_temp\\wft smoke prefix with spaces abc\\node_modules\\wood-fired-tasks',",
  "npm warn cleanup     [Error: EPERM: operation not permitted, rmdir 'D:\\a\\_temp\\x\\node_modules\\wood-fired-tasks\\dist'] {",
  'npm warn cleanup       errno: -4048,',
  'npm warn cleanup     }',
  'npm warn cleanup   ]',
  'npm warn cleanup ]',
  '',
  'added 351 packages in 40s',
].join('\r\n');

describe('npm install deprecation guard (task #2132)', () => {
  it('flags every deprecation in the captured 2.8.0 global-install output', () => {
    const { deprecated, otherWarnings } = parseNpmInstallWarnings(
      fs.readFileSync(fixture280, 'utf8'),
    );
    expect(deprecated.map((d) => d.spec)).toEqual([
      'lodash.get@4.4.2',
      'lodash.isequal@4.5.0',
      'prebuild-install@7.1.3',
    ]);
    expect(deprecated.map((d) => d.name)).toEqual([
      'lodash.get',
      'lodash.isequal',
      'prebuild-install',
    ]);
    expect(deprecated[2]?.version).toBe('7.1.3');
    expect(deprecated[0]?.message).toMatch(/optional chaining/);
    expect(otherWarnings).toEqual([]);
  });

  it('reports nothing for a clean install', () => {
    expect(parseNpmInstallWarnings(CLEAN)).toEqual({ deprecated: [], otherWarnings: [] });
    expect(parseNpmInstallWarnings('')).toEqual({ deprecated: [], otherWarnings: [] });
  });

  it('reports unrelated npm warnings (Windows EPERM cleanup) without counting them', () => {
    const { deprecated, otherWarnings } = parseNpmInstallWarnings(WINDOWS_CLEANUP);
    expect(deprecated).toEqual([]);
    expect(otherWarnings).toHaveLength(8);
    expect(otherWarnings.some((l) => l.includes('EPERM'))).toBe(true);
  });

  it('separates deprecations from other warnings in mixed output (legacy WARN casing, scoped names)', () => {
    const mixed = [
      'npm WARN deprecated @scope/old-pkg@1.0.0: use @scope/new-pkg',
      'npm warn config production Use `--omit=dev` instead.',
      'npm warn deprecated whatwg-encoding@3.1.1: Use @exodus/bytes instead',
      'added 1 package in 1s',
    ].join('\n');
    const { deprecated, otherWarnings } = parseNpmInstallWarnings(mixed);
    expect(deprecated.map((d) => [d.name, d.version])).toEqual([
      ['@scope/old-pkg', '1.0.0'],
      ['whatwg-encoding', '3.1.1'],
    ]);
    expect(otherWarnings).toEqual(['npm warn config production Use `--omit=dev` instead.']);
  });

  it('does not treat prose mentioning deprecation as a warning', () => {
    const out = 'This package is deprecated upstream\n> npm warn deprecated is quoted here\n';
    expect(parseNpmInstallWarnings(out).deprecated).toEqual([]);
  });

  it('splitSpec handles scoped and unversioned specs', () => {
    expect(splitSpec('@a/b@2.0.0')).toEqual({ name: '@a/b', version: '2.0.0' });
    expect(splitSpec('pkg@1')).toEqual({ name: 'pkg', version: '1' });
    expect(splitSpec('pkg')).toEqual({ name: 'pkg', version: '' });
  });

  it('formats each offending line with its dependency path', () => {
    const { deprecated } = parseNpmInstallWarnings(fs.readFileSync(fixture280, 'utf8'));
    const report = formatDeprecationReport(deprecated, (name) =>
      name === 'lodash.get'
        ? 'wood-fired-tasks@2.8.0\n└─┬ umzug@3.8.2\n  └── lodash.get@4.4.2'
        : '',
    );
    expect(report).toContain('3 deprecation warning(s)');
    expect(report).toContain('npm warn deprecated prebuild-install@7.1.3');
    expect(report).toContain('└─┬ umzug@3.8.2');
  });

  it('CLI exits 1 and lists the lines for the 2.8.0 fixture', () => {
    const res = spawnSync(process.execPath, [scriptPath, fixture280], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('npm warn deprecated lodash.get@4.4.2');
    expect(res.stderr).toContain('npm warn deprecated lodash.isequal@4.5.0');
    expect(res.stderr).toContain('npm warn deprecated prebuild-install@7.1.3');
  });

  it('CLI exits 0 on clean stdin and notes unrelated warnings', () => {
    const res = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      input: WINDOWS_CLEANUP,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('no npm deprecation warnings');
    expect(res.stdout).toContain('note (not counted): npm warn cleanup');
  });
});
