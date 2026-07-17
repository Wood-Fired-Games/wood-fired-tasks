import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scmCommand } from '../../cli/commands/scm.js';
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

    it('throws CONFIG_INVALID when both .git and .p4config are present at the same root (ambiguous — never guesses, task #1549)', () => {
      writeFileSync(join(root, '.git'), '', 'utf8');
      writeFileSync(join(root, '.p4config'), '', 'utf8');
      expect(() => detectBackend(root)).toThrow(ScmError);
      try {
        detectBackend(root);
      } catch (err) {
        expect((err as ScmError).code).toBe('CONFIG_INVALID');
      }
    });

    it('ignores a dual-marker ancestor above the resolved root (walk-up stops at the nearest single-marker dir)', () => {
      // root has BOTH markers — ambiguous if ever reached — but a nested dir
      // one level down carries its own single git marker. findRepoRoot must
      // stop at that nested dir, so detectBackend never sees root's ambiguity.
      writeFileSync(join(root, '.git'), '', 'utf8');
      writeFileSync(join(root, '.p4config'), '', 'utf8');
      const nested = join(root, 'nested');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, '.git'), '', 'utf8');

      const resolvedRoot = findRepoRoot(nested);
      expect(resolvedRoot).toBe(nested);
      expect(detectBackend(resolvedRoot)).toBe('git');
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

    it('an explicit .tasks/scm.json still wins over an ambiguous dual-marker root', () => {
      writeFileSync(join(root, '.git'), '', 'utf8');
      writeFileSync(join(root, '.p4config'), '', 'utf8');
      writeScmConfig({ version: 1, backend: 'perforce' });
      expect(resolveBackend(root)).toEqual({ backend: 'perforce', source: 'file' });
    });

    it('propagates CONFIG_INVALID when resolution falls through to auto-detect on a dual-marker root', () => {
      writeFileSync(join(root, '.git'), '', 'utf8');
      writeFileSync(join(root, '.p4config'), '', 'utf8');
      expect(() => resolveBackend(root)).toThrow(ScmError);
    });
  });

  describe('resolveBackend charter tier (task #1550, hardening spec §2.2)', () => {
    it('a charter-only resolution (no config, no marker) returns source "charter"', () => {
      expect(resolveBackend(root, { backend: 'perforce' })).toEqual({
        backend: 'perforce',
        source: 'charter',
      });
    });

    it('a charter-vs-marker conflict resolves to the marker backend and records a conflict warning', () => {
      writeFileSync(join(root, '.git'), '', 'utf8');
      const resolved = resolveBackend(root, { backend: 'perforce' });
      expect(resolved.backend).toBe('git');
      expect(resolved.source).toBe('auto');
      expect(resolved.warnings).toBeDefined();
      expect(resolved.warnings).toHaveLength(1);
      expect(resolved.warnings?.[0]).toMatch(/charter/i);
      expect(resolved.warnings?.[0]).toMatch(/marker/i);
    });

    it('a charter hint matching the detected marker produces no conflict warning', () => {
      writeFileSync(join(root, '.git'), '', 'utf8');
      expect(resolveBackend(root, { backend: 'git' })).toEqual({
        backend: 'git',
        source: 'auto',
      });
    });

    it('a concrete .tasks/scm.json still wins over a charter hint', () => {
      writeScmConfig({ version: 1, backend: 'none' });
      expect(resolveBackend(root, { backend: 'perforce' })).toEqual({
        backend: 'none',
        source: 'file',
      });
    });

    it('a charter backend of "auto" is treated as no hint', () => {
      expect(resolveBackend(root, { backend: 'auto' })).toEqual({
        backend: 'none',
        source: 'auto',
      });
    });

    it('no charter hint + no marker falls through to the pre-charter none/auto baseline', () => {
      expect(resolveBackend(root)).toEqual({ backend: 'none', source: 'auto' });
      expect(resolveBackend(root, null)).toEqual({ backend: 'none', source: 'auto' });
      expect(resolveBackend(root, {})).toEqual({ backend: 'none', source: 'auto' });
    });
  });

  describe('CLI dispatch — dual-marker refusal (task #1549)', () => {
    /**
     * Drives the real `scmCommand` in-process (same pattern as
     * `src/cli/__tests__/scm-command.test.ts`), capturing the printed §4.1
     * envelope and `process.exitCode`.
     */
    async function runScm(
      ...args: string[]
    ): Promise<{ exitCode: number; envelope: Record<string, unknown> }> {
      const stdoutChunks: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
          stdoutChunks.push(
            typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
          );
          return true;
        });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      process.exitCode = 0;
      try {
        await scmCommand.parseAsync(['node', 'scm', ...args]);
      } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
      }

      const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
      process.exitCode = 0;

      const stdout = stdoutChunks.join('');
      const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(1);
      const envelope = JSON.parse(lines[0]) as Record<string, unknown>;
      return { exitCode, envelope };
    }

    it('`scm detect` against a dual-marker root yields a CONFIG_INVALID envelope and exit code 2', async () => {
      writeFileSync(join(root, '.git'), '', 'utf8');
      writeFileSync(join(root, '.p4config'), '', 'utf8');

      const { exitCode, envelope } = await runScm('detect', '--repo', root);

      expect(exitCode).toBe(2);
      expect(envelope.ok).toBe(false);
      const error = envelope.error as Record<string, unknown>;
      expect(error.code).toBe('CONFIG_INVALID');
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
