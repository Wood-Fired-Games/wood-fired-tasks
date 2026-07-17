import { describe, it, expect } from 'vitest';
import {
  EXCLUSION_RULES,
  PLANNING_ARTIFACT_NAMES,
  enforceStageExclusions,
  filterExcluded,
  isExcluded,
  matchingExclusionRule,
  normalizeRepoRelative,
} from './exclusions.js';
import { ScmError } from './types.js';

/**
 * §4.4 "Exclusion invariant" of the pluggable-SCM spec, asserted at the
 * exclusions layer (the git / none backends — tasks #1535 / #1531 — do not
 * exist yet). We feed a synthetic changed-files / stage list through the exact
 * functions those backends will call and assert:
 *   - every excluded path is removed from a `changed-files`-style filter, and
 *   - a `stage`-style call containing an excluded path fails the WHOLE call.
 */

// Representative excluded path per §4.4 category.
const EXCLUDED_SAMPLES: ReadonlyArray<{ path: string; ruleId: string }> = [
  { path: '.tasks/.scm/default/baseline.json', ruleId: 'adapter-runtime-state' },
  { path: '.tasks/.scm', ruleId: 'adapter-runtime-state' },
  { path: '.planning/LOOP-RUN.md', ruleId: 'planning-artifacts' },
  { path: '.planning/AUDIT.md', ruleId: 'planning-artifacts' },
  { path: '.planning/DECOMPOSITION.md', ruleId: 'planning-artifacts' },
  { path: '.gitignore', ruleId: 'gitignore' },
  { path: '.env', ruleId: 'dotenv' },
  { path: '.env.production', ruleId: 'dotenv' },
  { path: 'data/tasks.db', ruleId: 'data-db' },
  { path: 'bin/tasks', ruleId: 'bin-dir' },
  { path: 'bin', ruleId: 'bin-dir' },
];

const SAFE_PATHS: readonly string[] = [
  'src/scm/exclusions.ts',
  'README.md',
  '.planning/config.json', // planning config IS committed — only the named artifacts are excluded
  'data/seed.json', // non-.db file under data/ is fine
  'binaries/tool', // "bin" as a prefix of a longer segment is NOT the /bin dir
  'src/env/config.ts', // ".env" only as a full basename, not a substring
  'docs/gitignore-notes.md',
];

describe('exclusions — §4.4 invariant', () => {
  describe('isExcluded flags every built-in category', () => {
    for (const { path, ruleId } of EXCLUDED_SAMPLES) {
      it(`excludes ${path} (rule: ${ruleId})`, () => {
        expect(isExcluded(path)).toBe(true);
        expect(matchingExclusionRule(path)?.id).toBe(ruleId);
      });
    }
  });

  describe('isExcluded leaves legitimate paths alone', () => {
    for (const path of SAFE_PATHS) {
      it(`keeps ${path}`, () => {
        expect(isExcluded(path)).toBe(false);
        expect(matchingExclusionRule(path)).toBeUndefined();
      });
    }
  });

  describe('normalized-path bypass attempts still match (§4.1)', () => {
    const bypassVariants: ReadonlyArray<[string, string]> = [
      ['leading ./', './.tasks/.scm/x'],
      ['nested ./', 'foo/./../.tasks/.scm/x'],
      ['.. traversal', '.tasks/.scm/../.scm/x'],
      ['absolute anchored at root', '/.tasks/.scm/x'],
      ['absolute /bin', '/bin/tasks'],
      ['backslashes', '.tasks\\.scm\\x'],
      ['trailing slash on dir', '.tasks/.scm/'],
      ['relative to .env', 'config/../.env'],
    ];
    for (const [label, variant] of bypassVariants) {
      it(`normalizes and excludes: ${label} (${variant})`, () => {
        expect(isExcluded(variant)).toBe(true);
      });
    }
  });

  describe('normalizeRepoRelative', () => {
    it('strips leading ./, resolves .., anchors absolute, strips trailing slash', () => {
      expect(normalizeRepoRelative('./.tasks/.scm/x')).toBe('.tasks/.scm/x');
      expect(normalizeRepoRelative('a/../foo')).toBe('foo');
      expect(normalizeRepoRelative('/bin/')).toBe('bin');
      expect(normalizeRepoRelative('.tasks\\.scm\\x')).toBe('.tasks/.scm/x');
      expect(normalizeRepoRelative('.')).toBe('');
      expect(normalizeRepoRelative('./')).toBe('');
    });
  });

  describe('filterExcluded (the changed-files filter)', () => {
    it('removes EVERY excluded path and keeps only the safe ones', () => {
      const changed = [...SAFE_PATHS, ...EXCLUDED_SAMPLES.map((s) => s.path)];
      const { kept, excluded } = filterExcluded(changed);

      // No excluded path survives into the reported set — the §4.4 invariant.
      for (const { path } of EXCLUDED_SAMPLES) {
        expect(kept).not.toContain(path);
        expect(excluded).toContain(path);
      }
      expect(kept).toEqual([...SAFE_PATHS]);
      expect(kept.every((p) => !isExcluded(p))).toBe(true);
    });

    it('is a no-op partition for an all-clean list', () => {
      const { kept, excluded } = filterExcluded(SAFE_PATHS);
      expect(kept).toEqual([...SAFE_PATHS]);
      expect(excluded).toEqual([]);
    });

    it('preserves the original input strings (pre-normalization) in the excluded bucket', () => {
      const { excluded } = filterExcluded(['./.tasks/.scm/x']);
      expect(excluded).toEqual(['./.tasks/.scm/x']);
    });
  });

  describe('enforceStageExclusions (the stage guard)', () => {
    it('returns the list unchanged when nothing is excluded', () => {
      expect(enforceStageExclusions(SAFE_PATHS)).toEqual([...SAFE_PATHS]);
    });

    it('fails the WHOLE call — not a silent drop — when any path is excluded', () => {
      const files = ['src/scm/exclusions.ts', '.planning/LOOP-RUN.md', 'README.md'];
      expect(() => enforceStageExclusions(files)).toThrow(ScmError);
    });

    it('rejects with CONFIG_INVALID (→ exit 2) and lists every offender', () => {
      const files = ['ok.ts', '.env', '.tasks/.scm/state', 'data/tasks.db'];
      try {
        enforceStageExclusions(files);
        expect.unreachable('expected enforceStageExclusions to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ScmError);
        const scmErr = err as ScmError;
        expect(scmErr.code).toBe('CONFIG_INVALID');
        expect(scmErr.message).toContain('.env');
        expect(scmErr.message).toContain('.tasks/.scm/state');
        expect(scmErr.message).toContain('data/tasks.db');
        // The clean path is NOT an offender.
        expect(scmErr.message).not.toContain('ok.ts');
      }
    });

    it('catches normalized bypass attempts in a stage call', () => {
      expect(() => enforceStageExclusions(['./.planning/LOOP-RUN.md'])).toThrow(ScmError);
      expect(() => enforceStageExclusions(['/bin/tasks'])).toThrow(ScmError);
    });
  });

  describe('rule table integrity', () => {
    it('every planning artifact name is covered', () => {
      for (const name of PLANNING_ARTIFACT_NAMES) {
        expect(isExcluded(`.planning/${name}`)).toBe(true);
      }
    });

    it('exposes a non-empty, uniquely-identified rule set', () => {
      expect(EXCLUSION_RULES.length).toBeGreaterThan(0);
      const ids = EXCLUSION_RULES.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
