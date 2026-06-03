import { describe, it, expect } from 'vitest';
import {
  validateScoreSubmission,
  VARIANCE_FLOOR,
  type ScoreSubmission,
  type ValidateContext,
} from '../wsjf.service.js';
import type { ValueCharter, ValueTheme } from '../../types/task.js';
import type { WsjfComponents } from '../../types/wsjf.js';

// ---------------------------------------------------------------------------
// Task #626 (WSJF 1.6) — acceptance tests for the deterministic gate.
// ---------------------------------------------------------------------------

const theme = (name: string, weight: ValueTheme['weight']): ValueTheme => ({
  name,
  weight,
  description: `${name} matters`,
});

const charter = (themes: ValueTheme[]): ValueCharter => ({
  mission: 'ship a reliable checkout',
  value_themes: themes,
  time_context: 'launch window is tight',
  risk_posture: 'security and data loss are top concerns',
  out_of_scope: [],
  interview_version: 1,
  updated_at: '2026-06-01T00:00:00Z',
});

// Source text every evidence span below is a verbatim substring of.
const SOURCE =
  'Refactor the checkout payment retry path. It is core to checkout reliability ' +
  'and addresses a security gap. The launch window is tight. ' +
  'This touches the payment retry path and several modules.';

/** A baseline submission whose spans all occur in SOURCE and that passes cleanly. */
function validSubmission(
  over: Partial<ScoreSubmission['classification']> = {},
  features: Partial<ScoreSubmission['features']> = {},
): ScoreSubmission {
  return {
    classification: {
      themeName: 'checkout reliability',
      alignment: 'core',
      severity: 'security',
      decay: null,
      jobSizeTier: 8,
      evidence: {
        value: 'core to checkout reliability',
        timeCriticality: 'launch window is tight',
        riskOpportunity: 'addresses a security gap',
        jobSize: 'touches the payment retry path and several modules',
      },
      ...over,
    },
    features: {
      deadlineDate: null,
      daysUntilDeadline: 5,
      transitiveDependents: 0,
      filesTouched: 6, // band [5,8] — admits jobSizeTier 8
      charterVersion: 1,
      ...features,
    },
  };
}

const ctxWith = (over: Partial<ValidateContext> = {}): ValidateContext => ({
  charter: charter([theme('checkout reliability', 13)]),
  sourceText: SOURCE,
  ...over,
});

describe('validateScoreSubmission (task #626)', () => {
  it('passes a clean submission and returns server-computed components', () => {
    const res = validateScoreSubmission(validSubmission(), ctxWith());
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.components).toEqual<WsjfComponents>({
      value: 13, // theme weight 13 × core
      timeCriticality: 8, // daysUntilDeadline 5 → 8
      riskOpportunity: 8, // max(fanout 0→1, severity security→8)
      jobSize: 8,
    });
  });

  it('rejects an evidence span not present in source text', () => {
    const sub = validSubmission({
      evidence: {
        value: 'core to checkout reliability',
        timeCriticality: 'launch window is tight',
        riskOpportunity: 'addresses a security gap',
        jobSize: 'a span that never appears anywhere in the task',
      },
    });
    const res = validateScoreSubmission(sub, ctxWith());
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('evidence.jobSize'))).toBe(true);
  });

  it('rejects a themeName absent from the charter', () => {
    const sub = validSubmission({ themeName: 'nonexistent theme' });
    const res = validateScoreSubmission(sub, ctxWith());
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('not a theme'))).toBe(true);
  });

  it('rejects themeName=null when a charter is present', () => {
    const sub = validSubmission({ themeName: null });
    const res = validateScoreSubmission(sub, ctxWith());
    expect(res.ok).toBe(false);
    expect(
      res.errors.some((e) => e.includes('only allowed when the project has no charter')),
    ).toBe(true);
  });

  it('allows themeName=null only when charter is null', () => {
    const sub = validSubmission({ themeName: null, alignment: 'none' });
    const res = validateScoreSubmission(sub, ctxWith({ charter: null }));
    expect(res.ok).toBe(true);
    // No charter / themeName=null → UBV collapses to alignment floor (none→1).
    expect(res.components?.value).toBe(1);
  });

  it('rejects a non-null themeName when charter is null', () => {
    const sub = validSubmission({ themeName: 'checkout reliability' });
    const res = validateScoreSubmission(sub, ctxWith({ charter: null }));
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('no charter'))).toBe(true);
  });

  it('rejects jobSizeTier outside the jobSizeBand', () => {
    // filesTouched 1 → band [1,2]; jobSizeTier 8 is outside it.
    const sub = validSubmission(
      { jobSizeTier: 8 },
      { filesTouched: 1 },
    );
    const res = validateScoreSubmission(sub, ctxWith());
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('outside the allowed band'))).toBe(true);
  });

  it('rejects the jobSize=1 && value=13 contradiction', () => {
    // filesTouched 1 → band [1,2] admits jobSizeTier 1; theme weight 13 × core → value 13.
    const sub = validSubmission(
      { jobSizeTier: 1 },
      { filesTouched: 1 },
    );
    const res = validateScoreSubmission(sub, ctxWith());
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('contradiction'))).toBe(true);
  });

  it('rejects a batch with no 1 anchor in a CoD column', () => {
    // value column = [13, 8, 8] has no 1 anchor.
    const batch: WsjfComponents[] = [
      { value: 13, timeCriticality: 8, riskOpportunity: 5, jobSize: 5 },
      { value: 8, timeCriticality: 1, riskOpportunity: 8, jobSize: 3 },
      { value: 8, timeCriticality: 3, riskOpportunity: 1, jobSize: 8 },
    ];
    const res = validateScoreSubmission(validSubmission(), ctxWith({ batch }));
    expect(res.ok).toBe(false);
    expect(
      res.errors.some((e) => e.includes('column "value" has no 1 anchor')),
    ).toBe(true);
  });

  it('rejects a degenerate batch where all components are identical (variance floor)', () => {
    const same: WsjfComponents = {
      value: 5,
      timeCriticality: 5,
      riskOpportunity: 5,
      jobSize: 5,
    };
    const batch: WsjfComponents[] = [same, { ...same }, { ...same }];
    const res = validateScoreSubmission(validSubmission(), ctxWith({ batch }));
    expect(res.ok).toBe(false);
    // Zero variance < floor on every CoD column, and no 1 anchor either.
    expect(
      res.errors.some((e) => e.includes(`variance below floor ${VARIANCE_FLOOR}`)),
    ).toBe(true);
  });

  it('accepts a well-anchored, varied batch', () => {
    const batch: WsjfComponents[] = [
      { value: 13, timeCriticality: 8, riskOpportunity: 8, jobSize: 5 },
      { value: 1, timeCriticality: 1, riskOpportunity: 3, jobSize: 8 },
      { value: 5, timeCriticality: 5, riskOpportunity: 1, jobSize: 2 },
    ];
    const res = validateScoreSubmission(validSubmission(), ctxWith({ batch }));
    expect(res.ok).toBe(true);
  });

  it('uses decay class for time criticality when no deadline date', () => {
    const sub = validSubmission(
      { decay: 'fast' },
      { daysUntilDeadline: null },
    );
    const res = validateScoreSubmission(sub, ctxWith());
    expect(res.ok).toBe(true);
    expect(res.components?.timeCriticality).toBe(5); // fast → 5
  });

  it('rejects an off-scale Fibonacci tier via the schema', () => {
    const sub = validSubmission();
    // Force an invalid enum value past the type system.
    (sub.classification as { jobSizeTier: number }).jobSizeTier = 7;
    const res = validateScoreSubmission(sub, ctxWith());
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
