// WSJF golden-set regression (Task #636 / WSJF 2.5).
//
// A fixed corpus of (task text + charter) inputs each carries the component
// buckets we expect the deterministic scorer to produce. This suite drives every
// golden input through the SOURCE-OF-TRUTH gate (`validateScoreSubmission` in
// `src/services/wsjf.service.ts`) and asserts the server-computed components
// match the fixture's `expectedComponents` within tolerance. The expected
// buckets are NOT hand-invented — they equal what the deterministic functions
// actually produce; if the canonical mapping changes, only the fixtures'
// `expectedComponents` need updating (design spec §12.5 golden-set CI gate).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';
import {
  validateScoreSubmission,
  type ScoreSubmission,
  type ValidateContext,
} from '../wsjf.service.js';
import type {
  WsjfClassification,
  WsjfComponents,
  WsjfFeatures,
} from '../../types/wsjf.js';
import type { ValueCharter } from '../../types/task.js';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../../tests/fixtures/wsjf-golden/', import.meta.url),
);
const readFixture = <T>(name: string): T =>
  JSON.parse(readFileSync(`${FIXTURE_DIR}${name}`, 'utf8')) as T;

interface GoldenCase {
  id: string;
  summary: string;
  useCharter: boolean;
  sourceText: string;
  classification: WsjfClassification;
  features: WsjfFeatures;
  expectedComponents: WsjfComponents;
  wsjfScore: number;
}

interface TasksFixture {
  tolerance: { bucketTiers: number; score: number };
  charterRef: string;
  cases: GoldenCase[];
}

const charter = readFixture<ValueCharter>('charter.json');
const fixture = readFixture<TasksFixture>('tasks.json');

describe('wsjf golden-set (task #636)', () => {
  it('has a non-empty corpus with tasks + a charter fixture', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    expect(charter.value_themes.length).toBeGreaterThan(0);
    // At least one case exercises the charter path and one the charter-less path.
    expect(fixture.cases.some((c) => c.useCharter)).toBe(true);
    expect(fixture.cases.some((c) => !c.useCharter)).toBe(true);
  });

  describe.each(fixture.cases)('$id', (golden) => {
    const submission: ScoreSubmission = {
      classification: golden.classification,
      features: golden.features,
    };
    const ctx: ValidateContext = {
      charter: golden.useCharter ? charter : null,
      sourceText: golden.sourceText,
    };

    it('passes the deterministic gate (valid golden input)', () => {
      const result = validateScoreSubmission(submission, ctx);
      // Surface the precise violations if a fixture drifts out of contract.
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.components).toBeDefined();
    });

    it('maps to its expected component buckets within tolerance', () => {
      const { components } = validateScoreSubmission(submission, ctx);
      expect(components).toBeDefined();
      const c = components as WsjfComponents;
      const tol = fixture.tolerance.bucketTiers;
      for (const key of [
        'value',
        'timeCriticality',
        'riskOpportunity',
        'jobSize',
      ] as const) {
        expect(
          Math.abs(c[key] - golden.expectedComponents[key]),
          `component "${key}" of ${golden.id}: got ${c[key]}, expected ${golden.expectedComponents[key]}`,
        ).toBeLessThanOrEqual(tol);
      }
    });
  });
});
