import { VerificationEvidenceSchema } from '../../schemas/task.schema.js';

export interface EvidenceValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a candidate `verification_evidence` JSON string against the
 * authoritative {@link VerificationEvidenceSchema}. Used by the tasks-verifier
 * self-check (`npm run -s validate:evidence`) so a verifier can catch the §G
 * parse-failure patterns in its OWN output before emitting.
 *
 * Never throws — non-JSON input returns `{ ok: false, errors: [...] }`.
 */
export function validateEvidence(raw: string): EvidenceValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [
        `input is not parseable as JSON (${(err as Error).message}); emit ONLY the bare JSON object — no fence, no preamble, no trailing prose`,
      ],
    };
  }
  const result = VerificationEvidenceSchema.safeParse(parsed);
  if (result.success) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
