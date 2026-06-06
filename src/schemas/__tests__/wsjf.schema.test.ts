import { describe, it, expect } from 'vitest';
import {
  FibSchema,
  WsjfClassificationSchema,
  WsjfEvidenceSchema,
  WsjfComponentsSchema,
  WsjfLocksSchema,
  WsjfSourceSchema,
  ScoreSubmissionSchema,
} from '../wsjf.schema.js';

const validEvidence = {
  value: 'aligns with checkout reliability theme',
  timeCriticality: 'launch window closes Q3',
  riskOpportunity: 'prevents dropped carts (data_loss)',
  jobSize: 'single-file config change',
};

const validClassification = {
  themeName: 'checkout reliability',
  alignment: 'core' as const,
  severity: 'data_loss' as const,
  decay: null,
  jobSizeTier: 2 as const,
  evidence: validEvidence,
};

const validFeatures = {
  deadlineDate: '2026-09-30T00:00:00.000Z',
  daysUntilDeadline: 121,
  transitiveDependents: 3,
  filesTouched: 1,
  charterVersion: 1,
};

const validSubmission = {
  classification: validClassification,
  features: validFeatures,
};

describe('wsjf.schema — FibSchema', () => {
  it('accepts every Fibonacci tier', () => {
    for (const f of [1, 2, 3, 5, 8, 13]) {
      expect(FibSchema.safeParse(f).success).toBe(true);
    }
  });

  it('rejects off-scale values 4, 6, and 7', () => {
    for (const bad of [4, 6, 7]) {
      expect(FibSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('parse() throws on an off-scale value', () => {
    expect(() => FibSchema.parse(4)).toThrow();
  });
});

describe('wsjf.schema — WsjfComponentsSchema', () => {
  it('accepts all-Fibonacci components', () => {
    expect(
      WsjfComponentsSchema.safeParse({
        value: 8,
        timeCriticality: 5,
        riskOpportunity: 3,
        jobSize: 2,
      }).success,
    ).toBe(true);
  });

  it('rejects an off-scale component value (4, 6, 7)', () => {
    for (const bad of [4, 6, 7]) {
      expect(
        WsjfComponentsSchema.safeParse({
          value: bad,
          timeCriticality: 5,
          riskOpportunity: 3,
          jobSize: 2,
        }).success,
      ).toBe(false);
    }
  });
});

describe('wsjf.schema — WsjfEvidenceSchema', () => {
  it('accepts non-empty spans', () => {
    expect(WsjfEvidenceSchema.safeParse(validEvidence).success).toBe(true);
  });

  it('rejects an empty evidence string', () => {
    const res = WsjfEvidenceSchema.safeParse({ ...validEvidence, value: '' });
    expect(res.success).toBe(false);
  });

  it('rejects an empty span on any component', () => {
    for (const key of ['value', 'timeCriticality', 'riskOpportunity', 'jobSize'] as const) {
      expect(WsjfEvidenceSchema.safeParse({ ...validEvidence, [key]: '' }).success).toBe(false);
    }
  });
});

describe('wsjf.schema — WsjfClassificationSchema', () => {
  it('accepts a well-formed classification', () => {
    expect(WsjfClassificationSchema.safeParse(validClassification).success).toBe(true);
  });

  it('rejects a non-Fibonacci jobSizeTier (4)', () => {
    expect(
      WsjfClassificationSchema.safeParse({
        ...validClassification,
        jobSizeTier: 4,
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid alignment class', () => {
    expect(
      WsjfClassificationSchema.safeParse({
        ...validClassification,
        alignment: 'sorta',
      }).success,
    ).toBe(false);
  });

  it('allows null themeName and null decay', () => {
    expect(
      WsjfClassificationSchema.safeParse({
        ...validClassification,
        themeName: null,
        decay: 'slow',
      }).success,
    ).toBe(true);
  });
});

describe('wsjf.schema — WsjfLocksSchema', () => {
  it('accepts boolean flags for every component', () => {
    expect(
      WsjfLocksSchema.safeParse({
        value: true,
        timeCriticality: false,
        riskOpportunity: false,
        jobSize: true,
      }).success,
    ).toBe(true);
  });

  it('rejects a non-boolean flag', () => {
    expect(
      WsjfLocksSchema.safeParse({
        value: 'yes',
        timeCriticality: false,
        riskOpportunity: false,
        jobSize: true,
      }).success,
    ).toBe(false);
  });
});

describe('wsjf.schema — WsjfSourceSchema', () => {
  it('accepts auto/manual flags for every component', () => {
    expect(
      WsjfSourceSchema.safeParse({
        value: 'auto',
        timeCriticality: 'manual',
        riskOpportunity: 'auto',
        jobSize: 'manual',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown provenance value', () => {
    expect(
      WsjfSourceSchema.safeParse({
        value: 'robot',
        timeCriticality: 'manual',
        riskOpportunity: 'auto',
        jobSize: 'manual',
      }).success,
    ).toBe(false);
  });
});

describe('wsjf.schema — ScoreSubmissionSchema', () => {
  it('accepts a full valid submission', () => {
    const res = ScoreSubmissionSchema.safeParse(validSubmission);
    expect(res.success).toBe(true);
  });

  it('parse() returns the parsed submission', () => {
    const parsed = ScoreSubmissionSchema.parse(validSubmission);
    expect(parsed.classification.jobSizeTier).toBe(2);
    expect(parsed.features.transitiveDependents).toBe(3);
  });

  it('rejects a submission whose classification has bad evidence', () => {
    expect(
      ScoreSubmissionSchema.safeParse({
        ...validSubmission,
        classification: {
          ...validClassification,
          evidence: { ...validEvidence, jobSize: '' },
        },
      }).success,
    ).toBe(false);
  });
});
