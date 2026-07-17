import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadScmConfig } from '../config.js';
import { detectBackend, findRepoRoot, resolveBackend } from '../detect.js';
import { ScmError } from '../types.js';

/**
 * Fixtures build a throwaway repo root under the OS temp dir. `.git`/`.p4config`
 * are created as plain files (marker existence is all the detectors check), and
 * `.tasks/scm.json` is written to exercise the config-over-detect precedence.
 */
describe('scm config loader + backend auto-detect (task #1530)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scm-detect-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeScmConfig(config: unknown): void {
    mkdirSync(join(root, '.tasks'), { recursive: true });
    writeFileSync(join(root, '.tasks', 'scm.json'), JSON.stringify(config), 'utf8');
  }

  describe('detectBackend', () => {
    it('returns "git" inside a .git repo', () => {
      writeFileSync(join(root, '.git'), '', 'utf8');
      expect(detectBackend(root)).toBe('git');
    });

    it('returns "none" with no SCM markers present', () => {
      expect(detectBackend(root)).toBe('none');
    });

    it('returns "perforce" when a .p4config marker is present', () => {
      writeFileSync(join(root, '.p4config'), 'P4PORT=ssl:1666\n', 'utf8');
      expect(detectBackend(root)).toBe('perforce');
    });

    it('prefers git when both git and perforce markers exist', () => {
      writeFileSync(join(root, '.git'), '', 'utf8');
      writeFileSync(join(root, '.p4config'), '', 'utf8');
      expect(detectBackend(root)).toBe('git');
    });
  });

  describe('loadScmConfig', () => {
    it('returns null when .tasks/scm.json is absent', () => {
      expect(loadScmConfig(root)).toBeNull();
    });

    it('returns the parsed config when valid', () => {
      writeScmConfig({ version: 1, backend: 'perforce' });
      expect(loadScmConfig(root)).toEqual({ version: 1, backend: 'perforce' });
    });

    it('throws CONFIG_INVALID on malformed JSON (never falls through to auto-detect)', () => {
      mkdirSync(join(root, '.tasks'), { recursive: true });
      writeFileSync(join(root, '.tasks', 'scm.json'), '{ not json', 'utf8');
      expect(() => loadScmConfig(root)).toThrow(ScmError);
      try {
        loadScmConfig(root);
      } catch (err) {
        expect((err as ScmError).code).toBe('CONFIG_INVALID');
      }
    });

    it('throws CONFIG_INVALID on a wrong version', () => {
      writeScmConfig({ version: 2, backend: 'git' });
      expect(() => loadScmConfig(root)).toThrow(/CONFIG_INVALID|schema/i);
    });

    it('throws CONFIG_INVALID on unknown keys (.strict())', () => {
      writeScmConfig({ version: 1, backend: 'git', bogus: true });
      expect(() => loadScmConfig(root)).toThrow(ScmError);
    });
  });

  describe('resolveBackend precedence (config over detect)', () => {
    it('a present config overrides detection', () => {
      // Filesystem says git, but the committed config declares "none".
      writeFileSync(join(root, '.git'), '', 'utf8');
      writeScmConfig({ version: 1, backend: 'none' });

      expect(detectBackend(root)).toBe('git');
      expect(resolveBackend(root)).toEqual({ backend: 'none', source: 'file' });
    });

    it('backend:"auto" in the config triggers detection', () => {
      writeFileSync(join(root, '.git'), '', 'utf8');
      writeScmConfig({ version: 1, backend: 'auto' });
      expect(resolveBackend(root)).toEqual({ backend: 'git', source: 'auto' });
    });

    it('falls through to detection when no config file exists', () => {
      expect(resolveBackend(root)).toEqual({ backend: 'none', source: 'auto' });
    });
  });

  describe('findRepoRoot', () => {
    it('walks up to the nearest ancestor holding .tasks/scm.json', () => {
      writeScmConfig({ version: 1, backend: 'none' });
      const nested = join(root, 'a', 'b', 'c');
      mkdirSync(nested, { recursive: true });
      expect(findRepoRoot(nested)).toBe(root);
    });

    it('falls back to the nearest SCM marker when no config exists', () => {
      writeFileSync(join(root, '.git'), '', 'utf8');
      const nested = join(root, 'x', 'y');
      mkdirSync(nested, { recursive: true });
      expect(findRepoRoot(nested)).toBe(root);
    });
  });
});
