#!/usr/bin/env tsx
/**
 * Self-validate a candidate `verification_evidence` JSON object read from stdin
 * against the authoritative VerificationEvidenceSchema. The tasks-verifier runs
 * this on its OWN output before emitting (see skills/agents/tasks-verifier.md
 * Workflow step 5) to catch the §G parse-failure patterns at the source.
 *
 * Exit 0 + "OK: ..." when valid; exit 1 + "INVALID ..." (errors on stderr) when not.
 */
import { validateEvidence } from '../src/lib/loop-run/validate-evidence.js';

const chunks: Buffer[] = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const result = validateEvidence(Buffer.concat(chunks).toString('utf8'));
  if (result.ok) {
    console.log('OK: parses as VerificationEvidence');
    process.exit(0);
  }
  console.error('INVALID VerificationEvidence:');
  for (const e of result.errors) console.error(`- ${e}`);
  process.exit(1);
});
