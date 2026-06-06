import { describe, it, expect } from 'vitest';
import {
  fibClamp,
  tcFromDaysUntil,
  tcFromDecayClass,
  rrFromFanout,
  rrFromSeverity,
  jobSizeBand,
  ubvFromThemeAlignment,
  computeWsjf,
  priorityFallbackScore,
  PROPAGATION_GAMMA,
  PROPAGATION_CAP,
} from '../wsjf.service.js';
import { FIB } from '../../types/wsjf.js';
import type { Fib, AlignmentClass, SeverityClass, DecayClass } from '../../types/wsjf.js';

describe('wsjf deterministic functions (task #622)', () => {
  describe('fibClamp', () => {
    it.each<[number, Fib]>([
      [0, 1],
      [4, 5],
      [6, 8],
      [13, 13],
      [99, 13],
    ])('fibClamp(%i) === %i', (input, expected) => {
      expect(fibClamp(input)).toBe(expected);
    });
  });

  describe('tcFromDaysUntil', () => {
    it.each<[number, Fib]>([
      [-3, 13],
      [0, 13],
      [5, 8],
      [75, 5],
      [120, 3],
      [300, 2],
      [800, 1],
    ])('tcFromDaysUntil(%i) === %i', (input, expected) => {
      expect(tcFromDaysUntil(input)).toBe(expected);
    });
  });

  describe('tcFromDecayClass', () => {
    it.each<[DecayClass, Fib]>([
      ['flat', 1],
      ['slow', 3],
      ['fast', 5],
    ])('tcFromDecayClass(%s) === %i', (input, expected) => {
      expect(tcFromDecayClass(input)).toBe(expected);
    });
  });

  describe('rrFromFanout', () => {
    it.each<[number, Fib]>([
      [0, 1],
      [1, 3],
      [3, 5],
      [6, 8],
      [9, 13],
    ])('rrFromFanout(%i) === %i', (input, expected) => {
      expect(rrFromFanout(input)).toBe(expected);
    });
  });

  describe('rrFromSeverity', () => {
    it.each<[SeverityClass, Fib]>([
      ['none', 1],
      ['tech_debt', 3],
      ['security', 8],
      ['compliance', 8],
    ])('rrFromSeverity(%s) === %i', (input, expected) => {
      expect(rrFromSeverity(input)).toBe(expected);
    });
  });

  describe('jobSizeBand', () => {
    it('filesTouched 1 → [1,2]', () => {
      expect(jobSizeBand(1, '')).toEqual([1, 2]);
    });
    it('filesTouched 6 → [5,8]', () => {
      expect(jobSizeBand(6, '')).toEqual([5, 8]);
    });
    it('filesTouched 20 → [8,13]', () => {
      expect(jobSizeBand(20, '')).toEqual([8, 13]);
    });
    it('(null, "migrate the schema") → [8,13]', () => {
      expect(jobSizeBand(null, 'migrate the schema')).toEqual([8, 13]);
    });
    it('(null, "fix typo") → [1,3]', () => {
      expect(jobSizeBand(null, 'fix typo')).toEqual([1, 3]);
    });
  });

  describe('ubvFromThemeAlignment', () => {
    it.each<[Fib, AlignmentClass, Fib]>([
      [13, 'core', 13],
      [13, 'direct', 8],
      [13, 'weak', 5],
      [13, 'none', 1],
      [3, 'direct', 2],
    ])('ubvFromThemeAlignment(%i, %s) === %i', (weight, alignment, expected) => {
      expect(ubvFromThemeAlignment(weight, alignment)).toBe(expected);
    });
  });

  // Task #782 (noUncheckedIndexedAccess remediation): `FIB` was retyped from
  // `readonly Fib[]` to a fixed-shape `as const` tuple, and the computed-index
  // lookups in `oneStepDown` / `fibMedianBucket` gained explicit guards. These
  // pin the FIB table shape and the `ubvFromThemeAlignment` saturation floor
  // (which routes through `oneStepDown`'s `idx <= 0 → 1` fallback branch).
  describe('FIB tuple integrity + oneStepDown saturation (task #782)', () => {
    it('FIB is the canonical 6-tier tuple in ascending order', () => {
      expect(FIB).toEqual([1, 2, 3, 5, 8, 13]);
      expect(FIB).toHaveLength(6);
    });

    it('ubvFromThemeAlignment saturates at 1 (oneStepDown idx<=0 fallback)', () => {
      // weight 1 is FIB[0]; one step down clamps at 1 rather than indexing FIB[-1].
      expect(ubvFromThemeAlignment(1, 'direct')).toBe(1);
      expect(ubvFromThemeAlignment(1, 'weak')).toBe(1);
      expect(ubvFromThemeAlignment(2, 'weak')).toBe(1); // 2→1→1 (saturates)
    });
  });

  // Task #640 (WSJF 3.4): the charter-driven UBV wiring the scoring skills
  // describe. A charter-backed task sources its theme weight from the live
  // charter `value_themes` and UBV = theme weight × alignment; an absent-charter
  // task has no theme weight, so the signal fallback drives `ubvFromThemeAlignment`
  // with the floor weight 1 (alignment-only). This pins the two paths the AC and
  // the rubric/create-task/decompose skills wire to the same function.
  describe('ubvFromThemeAlignment — charter-backed vs signal fallback (task #640)', () => {
    // A live charter theme the scoring skills would resolve `themeName` against.
    const charterTheme = { name: 'Player Retention', weight: 13 as Fib };

    it('charter-backed: UBV = theme weight × alignment (weight 13, direct → 8)', () => {
      // themeName names a live `value_themes` entry; server reads its weight.
      expect(ubvFromThemeAlignment(charterTheme.weight, 'direct')).toBe(8);
    });

    it('charter-backed: same theme, core alignment keeps the full theme weight', () => {
      expect(ubvFromThemeAlignment(charterTheme.weight, 'core')).toBe(13);
    });

    it('charter-backed: a lower-weight theme scales down (weight 5, weak → 2)', () => {
      const lowTheme = { name: 'Internal Tooling', weight: 5 as Fib };
      expect(ubvFromThemeAlignment(lowTheme.weight, 'weak')).toBe(2);
    });

    it('signal fallback (no charter): floor weight 1 collapses to the alignment-only tier', () => {
      // No charter → themeName=null → no theme weight → server uses weight 1.
      const fallbackWeight: Fib = 1;
      expect(ubvFromThemeAlignment(fallbackWeight, 'core')).toBe(1);
      expect(ubvFromThemeAlignment(fallbackWeight, 'direct')).toBe(1);
      expect(ubvFromThemeAlignment(fallbackWeight, 'weak')).toBe(1);
      expect(ubvFromThemeAlignment(fallbackWeight, 'none')).toBe(1);
    });

    it('charter-backed strictly out-ranks the signal fallback for the same alignment', () => {
      // Same task aligned `direct`: with the charter theme it scores 8; with no
      // charter (signal fallback, weight 1) it scores 1.
      const charterBacked = ubvFromThemeAlignment(charterTheme.weight, 'direct');
      const signalFallback = ubvFromThemeAlignment(1 as Fib, 'direct');
      expect(charterBacked).toBeGreaterThan(signalFallback);
    });
  });

  describe('computeWsjf', () => {
    it('{value:13, timeCriticality:5, riskOpportunity:8, jobSize:5} === 5.2', () => {
      expect(computeWsjf({ value: 13, timeCriticality: 5, riskOpportunity: 8, jobSize: 5 })).toBe(
        5.2,
      );
    });
    it('jobSize 0 treated as 1', () => {
      expect(
        computeWsjf({ value: 13, timeCriticality: 5, riskOpportunity: 8, jobSize: 0 as Fib }),
      ).toBe(26);
    });
  });

  describe('priorityFallbackScore', () => {
    it.each<['low' | 'medium' | 'high' | 'urgent', number]>([
      ['urgent', 9],
      ['high', 6],
      ['medium', 3],
      ['low', 1],
    ])('priorityFallbackScore(%s) === %i', (input, expected) => {
      expect(priorityFallbackScore(input)).toBe(expected);
    });
  });

  describe('propagation constants', () => {
    it('PROPAGATION_GAMMA === 0.5', () => {
      expect(PROPAGATION_GAMMA).toBe(0.5);
    });
    it('PROPAGATION_CAP === 3', () => {
      expect(PROPAGATION_CAP).toBe(3);
    });
  });
});
