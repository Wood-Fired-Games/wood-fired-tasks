#!/usr/bin/env tsx
/**
 * Self-validate a candidate `verification_evidence` JSON object read from stdin
 * against the authoritative VerificationEvidenceSchema. The tasks-verifier runs
 * this on its OWN output before emitting (see skills/agents/tasks-verifier.md
 * Workflow step 5) to catch the §G parse-failure patterns at the source.
 *
 * Exit 0 + "OK: ..." when valid; exit 1 + "INVALID VerificationEvidence:" when not.
 * Exit 2 if no piped stdin (TTY detected) or stdin emits an error.
 */
import { validateEvidence } from '../src/lib/loop-run/validate-evidence.js';

// Guard: if stdin is a TTY there is nothing to validate — fail fast rather than hang.
if (process.stdin.isTTY) {
  process.stderr.write(
    'validate-evidence: stdin is a TTY (nothing piped). Pipe a JSON object, e.g.:\n' +
      '  echo \'{"verdict":"PASS","checks":[]}\' | npm run -s validate:evidence\n',
  );
  process.exitCode = 2;
  process.exit();
}

process.stdin.on('error', (err: Error) => {
  process.stderr.write(
    `validate-evidence: stdin read error — ${err.message}. Ensure the piped stream is readable.\n`,
  );
  process.exitCode = 2;
  process.exit();
});

const chunks: Buffer[] = [];
process.stdin.on('data', (c: Buffer) => chunks.push(c));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') {
    process.stderr.write(
      'validate-evidence: stdin was empty. Pipe a JSON object, e.g.:\n' +
        '  echo \'{"verdict":"PASS","checks":[]}\' | npm run -s validate:evidence\n',
    );
    process.exitCode = 1;
    return;
  }
  const result = validateEvidence(raw);
  if (result.ok) {
    console.log('OK: parses as VerificationEvidence');
    process.exitCode = 0;
    return;
  }
  console.error('INVALID VerificationEvidence:');
  for (const e of result.errors) console.error(`- ${e}`);
  process.exitCode = 1;
});
