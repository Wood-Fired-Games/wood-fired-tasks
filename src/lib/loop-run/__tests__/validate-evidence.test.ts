import { describe, expect, it } from 'vitest';
import { validateEvidence } from '../validate-evidence.js';

describe('validateEvidence', () => {
  it('accepts a minimal valid envelope', () => {
    const r = validateEvidence(
      JSON.stringify({
        verdict: 'PARTIAL',
        checks: [
          {
            name: 'live DB smoke',
            status: 'SKIP',
            evidence_url_or_text: 'UNCHECKABLE: read-only verifier',
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects PARTIAL at the check level with a targeted message', () => {
    const r = validateEvidence(
      JSON.stringify({
        verdict: 'PASS',
        checks: [{ name: 'x', status: 'PARTIAL', evidence_url_or_text: 'y' }],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/checks\.0\.status/);
  });

  it('rejects the wrong per-check field name (criterion)', () => {
    const r = validateEvidence(
      JSON.stringify({
        verdict: 'PASS',
        checks: [{ criterion: 'x', status: 'PASS', evidence_url_or_text: 'y' }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects non-JSON input without throwing', () => {
    const r = validateEvidence('```json\n{"verdict":"PASS"}\n```');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/not parseable as JSON/i);
  });
});
