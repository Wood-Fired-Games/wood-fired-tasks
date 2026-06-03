// WSJF replay regression (Task #636 / WSJF 2.5).
//
// History stores each task's `classification` + `features` (design spec §4.3,
// §12.5). Replay = recompute the score purely from those stored inputs and
// assert it equals the STORED `wsjfScore`. This is the deterministic-rescore
// contract: no LLM, exact equality. A drift between recompute and stored number
// means either the mapping changed (update the fixture) or determinism broke.
//
// Two independent recompute paths are exercised per fixture so the test pins
// BOTH halves of the pipeline:
//   1. validateScoreSubmission(stored classification+features) -> components
//   2. the raw deterministic component functions -> components
// then computeWsjf(components) must equal the stored score exactly. Both paths
// must agree with each other and with the stored number.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';
import {
  validateScoreSubmission,
  computeWsjf,
  ubvFromThemeAlignment,
  tcFromDaysUntil,
  tcFromDecayClass,
  rrFromFanout,
  rrFromSeverity,
  type ScoreSubmission,
  type ValidateContext,
} from '../wsjf.service.js';
import type {
  Fib,
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

interface ReplayCase {
  id: string;
  useCharter: boolean;
  sourceText: string;
  classification: WsjfClassification;
  features: WsjfFeatures;
  expectedComponents: WsjfComponents;
  wsjfScore: number;
}

interface TasksFixture {
  tolerance: { bucketTiers: number; score: number };
  cases: ReplayCase[];
}

const charter = readFixture<ValueCharter>('charter.json');
const fixture = readFixture<TasksFixture>('tasks.json');

/** Recompute components from stored inputs using ONLY the raw component functions. */
function recomputeComponents(
  classification: WsjfClassification,
  features: WsjfFeatures,
  useCharter: boolean,
): WsjfComponents {
  let weight: Fib = 1;
  if (useCharter && classification.themeName !== null) {
    const theme = charter.value_themes.find(
      (t) => t.name === classification.themeName,
    );
    if (theme) weight = theme.weight as Fib;
  }
  const value = ubvFromThemeAlignment(weight, classification.alignment);
  const timeCriticality =
    features.daysUntilDeadline !== null
      ? tcFromDaysUntil(features.daysUntilDeadline)
      : tcFromDecayClass(classification.decay ?? 'flat');
  const riskOpportunity = Math.max(
    rrFromFanout(features.transitiveDependents),
    rrFromSeverity(classification.severity),
  ) as Fib;
  const jobSize = classification.jobSizeTier;
  return { value, timeCriticality, riskOpportunity, jobSize };
}

describe('wsjf replay (task #636)', () => {
  it('replays a non-empty corpus', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  describe.each(fixture.cases)('$id', (c) => {
    const submission: ScoreSubmission = {
      classification: c.classification,
      features: c.features,
    };
    const ctx: ValidateContext = {
      charter: c.useCharter ? charter : null,
      sourceText: c.sourceText,
    };

    it('gate-recomputed score equals the stored wsjf_score exactly', () => {
      const result = validateScoreSubmission(submission, ctx);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      const components = result.components as WsjfComponents;
      const replayed = computeWsjf(components);
      // Replay is an exact-equality contract (deterministic rescore, no LLM).
      expect(replayed).toBe(c.wsjfScore);
    });

    it('function-recomputed score equals the stored wsjf_score exactly', () => {
      const components = recomputeComponents(
        c.classification,
        c.features,
        c.useCharter,
      );
      const replayed = computeWsjf(components);
      expect(replayed).toBe(c.wsjfScore);
    });

    it('both recompute paths agree and match the stored buckets', () => {
      const gate = validateScoreSubmission(submission, ctx)
        .components as WsjfComponents;
      const fns = recomputeComponents(c.classification, c.features, c.useCharter);
      expect(gate).toEqual(fns);
      expect(gate).toEqual(c.expectedComponents);
    });
  });
});
