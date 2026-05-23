import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { VerificationEvidenceSchema } from '../../../../schemas/task.schema.js';

/**
 * Wave 2.1 (task #314) — verifier-fixture shape gate.
 *
 * The `tests/verifier-fixtures/` directory holds three hand-crafted
 * scenarios (real PASS, lying worker FAIL, partial work) that document
 * the `tasks-verifier` subagent contract at
 * `docs/verifier-contract.md`. Each scenario's `expected.json` is the
 * shape the verifier should emit — and that shape MUST be writable
 * into the `tasks.verification_evidence` column via the existing zod
 * schema, otherwise the contract diverges silently from the storage
 * layer.
 *
 * This test is the FALSIFIABLE programmatic check: each fixture's
 * `expected.json` is parsed and validated against
 * `VerificationEvidenceSchema`. Adding a fixture without updating the
 * list below is a deliberate omission — the test file is intentionally
 * static so it doubles as a manifest of which scenarios exist.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');

const FIXTURES = [
  {
    label: 'scenario-1-real-pass',
    expectedVerdict: 'PASS',
    path: 'tests/verifier-fixtures/scenario-1-real-pass/expected.json',
  },
  {
    label: 'scenario-2-false-pass-lying-worker',
    expectedVerdict: 'FAIL',
    path: 'tests/verifier-fixtures/scenario-2-false-pass-lying-worker/expected.json',
  },
  {
    label: 'scenario-3-partial-work',
    expectedVerdict: 'PARTIAL',
    path: 'tests/verifier-fixtures/scenario-3-partial-work/expected.json',
  },
] as const;

describe('tasks-verifier fixtures — expected.json shape (#314)', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.label}: parses against VerificationEvidenceSchema and rolls up to ${fixture.expectedVerdict}`, () => {
      const abs = resolve(REPO_ROOT, fixture.path);
      const raw = readFileSync(abs, 'utf8');
      const parsedJson = JSON.parse(raw);

      // 1. Storage-layer schema must accept the fixture verbatim.
      const result = VerificationEvidenceSchema.safeParse(parsedJson);
      if (!result.success) {
        throw new Error(
          `${fixture.label} did not parse against VerificationEvidenceSchema:\n${result.error.message}`,
        );
      }

      // 2. The rolled-up verdict must match the scenario name's intent.
      // This catches "I added a FAIL check to the partial fixture and
      // forgot to flip verdict back to FAIL" drift.
      expect(result.data.verdict).toBe(fixture.expectedVerdict);

      // 3. Rollup invariant: any FAIL check ⇒ overall verdict=FAIL.
      const statuses = (result.data.checks ?? []).map((c) => c.status);
      if (statuses.includes('FAIL')) {
        expect(result.data.verdict).toBe('FAIL');
      } else if (statuses.length === 0) {
        expect(result.data.verdict).toBe('NOT_VERIFIED');
      } else if (statuses.every((s) => s === 'PASS')) {
        expect(result.data.verdict).toBe('PASS');
      } else {
        // Mix of PASS + SKIP, or all SKIP — PARTIAL.
        expect(result.data.verdict).toBe('PARTIAL');
      }

      // 4. UNCHECKABLE mapping: every SKIP must carry the literal
      // `UNCHECKABLE:` prefix in its evidence string (contract rule).
      for (const check of result.data.checks ?? []) {
        if (check.status === 'SKIP') {
          expect(check.evidence_url_or_text.startsWith('UNCHECKABLE:')).toBe(true);
        }
      }
    });
  }

  it('covers all three rollup paths (PASS, FAIL, PARTIAL)', () => {
    const verdicts = FIXTURES.map((f) => f.expectedVerdict).sort();
    expect(verdicts).toEqual(['FAIL', 'PARTIAL', 'PASS']);
  });
});
