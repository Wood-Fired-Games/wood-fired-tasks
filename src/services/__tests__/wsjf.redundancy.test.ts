import { describe, it, expect, vi } from 'vitest';
import {
  fibMedianBucket,
  aggregateSamples,
  componentSpread,
  disagreeingComponents,
  isHighStakes,
  redundantScore,
  DEFAULT_REDUNDANCY_SAMPLES,
  DEFAULT_REDUNDANCY_TOLERANCE,
} from '../wsjf.service.js';
import type { Fib, WsjfComponents } from '../../types/wsjf.js';

// A small builder so each sample reads as a single line in the tests below.
function comp(value: Fib, tc: Fib, rr: Fib, js: Fib): WsjfComponents {
  return { value, timeCriticality: tc, riskOpportunity: rr, jobSize: js };
}

describe('WSJF 2.4 redundancy — median aggregation (task #635)', () => {
  describe('fibMedianBucket', () => {
    it.each<[Fib[], Fib]>([
      [[5], 5],
      [[3, 5, 8], 5],
      [[8, 8, 3], 8], // order-independent: sorts ords [2,4,4] → mid 4 → 8
      [[2, 5], 2], // even count uses the LOWER median
      [[1, 1, 13], 1],
      [[3, 8], 3], // ordinal median of {2,4} lower → 3
      [[2, 3, 5, 8, 13], 5],
    ])('fibMedianBucket(%j) === %i', (samples, expected) => {
      expect(fibMedianBucket(samples)).toBe(expected);
    });

    it('is deterministic for a fixed sample set regardless of input order', () => {
      const a: Fib[] = [3, 8, 5, 2, 13];
      const b = [...a].reverse();
      const c = [...a].sort(() => 0); // identity but exercises a different array
      expect(fibMedianBucket(a)).toBe(fibMedianBucket(b));
      expect(fibMedianBucket(a)).toBe(fibMedianBucket(c));
      expect(fibMedianBucket(a)).toBe(5);
    });

    it('throws on an empty sample', () => {
      expect(() => fibMedianBucket([])).toThrow(/empty/);
    });
  });

  describe('aggregateSamples — per-component median, deterministic', () => {
    // A fixed sample set of 3 classifications. Per component:
    //   value:           [13, 8, 8]  → 8
    //   timeCriticality: [5, 5, 3]   → 5
    //   riskOpportunity: [8, 13, 8]  → 8
    //   jobSize:         [2, 3, 5]   → 3
    const fixed: WsjfComponents[] = [
      comp(13, 5, 8, 2),
      comp(8, 5, 13, 3),
      comp(8, 3, 8, 5),
    ];

    it('produces the deterministic median bucket per component', () => {
      expect(aggregateSamples(fixed)).toEqual(comp(8, 5, 8, 3));
    });

    it('is invariant to sample ordering (deterministic for a fixed set)', () => {
      const shuffled = [fixed[2], fixed[0], fixed[1]];
      expect(aggregateSamples(shuffled)).toEqual(aggregateSamples(fixed));
    });

    it('throws when there are no samples', () => {
      expect(() => aggregateSamples([])).toThrow(/at least one/);
    });
  });

  describe('componentSpread / disagreeingComponents', () => {
    it('reports zero spread when every sample agrees', () => {
      const s = [comp(5, 3, 8, 2), comp(5, 3, 8, 2)];
      expect(componentSpread(s, 'value')).toBe(0);
      expect(disagreeingComponents(s)).toEqual([]);
    });

    it('measures spread in ordinal Fibonacci steps', () => {
      // value: 3(ord2)..13(ord5) → spread 3
      const s = [comp(3, 5, 8, 2), comp(13, 5, 8, 2)];
      expect(componentSpread(s, 'value')).toBe(3);
      expect(componentSpread(s, 'timeCriticality')).toBe(0);
    });

    it('default tolerance of 1 allows a one-step straddle but flags two-step', () => {
      expect(DEFAULT_REDUNDANCY_TOLERANCE).toBe(1);
      // 5↔8 is one ordinal step → within tolerance.
      const within = [comp(5, 3, 8, 2), comp(8, 3, 8, 2)];
      expect(disagreeingComponents(within)).toEqual([]);
      // 3↔8 is two ordinal steps → beyond tolerance.
      const beyond = [comp(3, 3, 8, 2), comp(8, 3, 8, 2)];
      expect(disagreeingComponents(beyond)).toEqual(['value']);
    });
  });

  describe('isHighStakes — redundancy scoped to high-stakes tasks only', () => {
    it('applies to top-of-frontier tasks', () => {
      expect(isHighStakes({ topOfFrontier: true, deterministicUndecided: false })).toBe(true);
    });
    it('applies to deterministically-undecided tasks', () => {
      expect(isHighStakes({ topOfFrontier: false, deterministicUndecided: true })).toBe(true);
    });
    it('does NOT apply to ordinary tasks (neither flag)', () => {
      expect(isHighStakes({ topOfFrontier: false, deterministicUndecided: false })).toBe(false);
    });
  });

  describe('redundantScore orchestration', () => {
    it('takes N (default 3) Tier-1 samples and returns the median without escalating when samples agree', async () => {
      expect(DEFAULT_REDUNDANCY_SAMPLES).toBe(3);
      const sample = vi
        .fn<[], Promise<WsjfComponents>>()
        .mockResolvedValueOnce(comp(8, 5, 8, 3))
        .mockResolvedValueOnce(comp(8, 5, 8, 3))
        .mockResolvedValueOnce(comp(5, 5, 8, 3)); // one-step straddle on value → within tol
      const verify = vi.fn<[], Promise<WsjfComponents>>();

      const res = await redundantScore(sample, verify);

      expect(sample).toHaveBeenCalledTimes(3);
      expect(verify).not.toHaveBeenCalled();
      expect(res.escalated).toBe(false);
      expect(res.lowConfidence).toEqual([]);
      expect(res.components).toEqual(comp(8, 5, 8, 3));
      expect(res.samples).toHaveLength(3);
    });

    it('escalates to the verifier when samples disagree beyond tolerance; verifier agreement clears low-confidence', async () => {
      // value spreads 3(ord2)..13(ord5) = 3 steps → beyond tolerance 1.
      const sample = vi
        .fn<[], Promise<WsjfComponents>>()
        .mockResolvedValueOnce(comp(3, 5, 8, 3))
        .mockResolvedValueOnce(comp(13, 5, 8, 3))
        .mockResolvedValueOnce(comp(8, 5, 8, 3)); // aggregate value median → 8
      // Verifier lands on 8 — exactly the aggregate, within tolerance.
      const verify = vi
        .fn<[], Promise<WsjfComponents>>()
        .mockResolvedValue(comp(8, 5, 8, 3));

      const res = await redundantScore(sample, verify);

      expect(verify).toHaveBeenCalledTimes(1);
      expect(res.escalated).toBe(true);
      expect(res.lowConfidence).toEqual([]); // verifier agreed → resolved
      expect(res.components).toEqual(comp(8, 5, 8, 3));
    });

    it('persistent disagreement (verifier still disagrees) → component flagged low-confidence', async () => {
      const sample = vi
        .fn<[], Promise<WsjfComponents>>()
        .mockResolvedValueOnce(comp(2, 5, 8, 3))
        .mockResolvedValueOnce(comp(13, 5, 8, 3))
        .mockResolvedValueOnce(comp(8, 5, 8, 3)); // value median → 8
      // Verifier lands on 2 — two ordinal steps from aggregate 8 → still disagrees.
      const verify = vi
        .fn<[], Promise<WsjfComponents>>()
        .mockResolvedValue(comp(2, 5, 8, 3));

      const res = await redundantScore(sample, verify);

      expect(res.escalated).toBe(true);
      expect(res.lowConfidence).toEqual(['value']);
      // Aggregate components still returned for ranking; the flag rides alongside.
      expect(res.components.value).toBe(8);
    });

    it('without a verifier wired, beyond-tolerance disagreement marks low-confidence directly', async () => {
      const sample = vi
        .fn<[], Promise<WsjfComponents>>()
        .mockResolvedValueOnce(comp(2, 5, 8, 3))
        .mockResolvedValueOnce(comp(13, 5, 8, 3))
        .mockResolvedValueOnce(comp(8, 5, 8, 3));

      const res = await redundantScore(sample, undefined);

      expect(res.escalated).toBe(false);
      expect(res.lowConfidence).toEqual(['value']);
    });

    it('a contradiction in the aggregate triggers escalation even when samples agree', async () => {
      // Every sample identical AND contradictory: jobSize=1 ∧ value=13.
      const sample = vi
        .fn<[], Promise<WsjfComponents>>()
        .mockResolvedValue(comp(13, 5, 8, 1));
      const verify = vi
        .fn<[], Promise<WsjfComponents>>()
        .mockResolvedValue(comp(5, 5, 8, 5)); // verifier resolves both ends

      const res = await redundantScore(sample, verify);

      expect(res.escalated).toBe(true);
      expect(verify).toHaveBeenCalledTimes(1);
      // value: agg 13 vs verifier 5 → 2 steps beyond tol → low-confidence.
      // jobSize: agg 1 vs verifier 5 → 2 steps beyond tol → low-confidence.
      expect(res.lowConfidence).toEqual(['value', 'jobSize']);
    });

    it('honours custom samples and tolerance options', async () => {
      const sample = vi
        .fn<[], Promise<WsjfComponents>>()
        .mockResolvedValueOnce(comp(3, 5, 8, 3))
        .mockResolvedValueOnce(comp(13, 5, 8, 3));
      // tolerance 5 swallows even the max ordinal spread → no escalation.
      const res = await redundantScore(sample, undefined, { samples: 2, tolerance: 5 });
      expect(sample).toHaveBeenCalledTimes(2);
      expect(res.escalated).toBe(false);
      expect(res.lowConfidence).toEqual([]);
    });
  });
});
