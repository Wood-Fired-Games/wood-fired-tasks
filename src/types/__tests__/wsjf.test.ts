import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  FIB,
  type Fib,
  type AlignmentClass,
  type SeverityClass,
  type DecayClass,
  type WsjfClassification,
  type WsjfEvidence,
  type WsjfFeatures,
  type WsjfComponents,
  type WsjfComponentKey,
  type WsjfSource,
  type WsjfLocks,
} from '../wsjf.js';

describe('WSJF core types (task #621)', () => {
  it('FIB deep-equals the canonical Fibonacci tier set', () => {
    expect(FIB).toEqual([1, 2, 3, 5, 8, 13]);
  });

  it('FIB is typed readonly Fib[]', () => {
    expectTypeOf(FIB).toEqualTypeOf<readonly Fib[]>();
  });

  it('Contracts enums/types are exported under their exact names', () => {
    // Type-level assertions: these fail tsc if a name/shape drifts.
    expectTypeOf<AlignmentClass>().toEqualTypeOf<'none' | 'weak' | 'direct' | 'core'>();
    expectTypeOf<SeverityClass>().toEqualTypeOf<
      'none' | 'tech_debt' | 'security' | 'data_loss' | 'compliance'
    >();
    expectTypeOf<DecayClass>().toEqualTypeOf<'flat' | 'slow' | 'fast'>();
    expectTypeOf<WsjfComponentKey>().toEqualTypeOf<
      'value' | 'timeCriticality' | 'riskOpportunity' | 'jobSize'
    >();

    const evidence: WsjfEvidence = {
      value: 'v',
      timeCriticality: 't',
      riskOpportunity: 'r',
      jobSize: 'j',
    };
    const classification: WsjfClassification = {
      themeName: null,
      alignment: 'core',
      severity: 'none',
      decay: 'flat',
      jobSizeTier: 5,
      evidence,
    };
    const features: WsjfFeatures = {
      deadlineDate: null,
      daysUntilDeadline: null,
      transitiveDependents: 0,
      filesTouched: null,
      charterVersion: null,
    };
    const components: WsjfComponents = {
      value: 1,
      timeCriticality: 2,
      riskOpportunity: 3,
      jobSize: 5,
    };
    const source: WsjfSource = {
      value: 'auto',
      timeCriticality: 'manual',
      riskOpportunity: 'auto',
      jobSize: 'auto',
    };
    const locks: WsjfLocks = {
      value: false,
      timeCriticality: true,
      riskOpportunity: false,
      jobSize: false,
    };

    expect(classification.evidence).toBe(evidence);
    expect(features.transitiveDependents).toBe(0);
    expect(components.jobSize).toBe(5);
    expect(source.timeCriticality).toBe('manual');
    expect(locks.timeCriticality).toBe(true);
  });
});
