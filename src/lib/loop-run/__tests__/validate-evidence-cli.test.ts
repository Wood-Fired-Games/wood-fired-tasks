import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Resolve repo root from this file's location (src/lib/loop-run/__tests__/)
const REPO_ROOT = resolve(import.meta.dirname, '../../../../');
const SCRIPT = resolve(REPO_ROOT, 'scripts/validate-evidence.ts');

/** Spawn `npx tsx <script>` with the given stdin string and collect results. */
function runCli(
  stdinData: string | null,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve_) => {
    const child = execFile('npx', ['tsx', SCRIPT], { cwd: REPO_ROOT }, (err, stdout, stderr) => {
      resolve_({
        exitCode: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
        stdout,
        stderr,
      });
    });
    if (stdinData !== null) {
      child.stdin!.write(stdinData);
    }
    child.stdin!.end();
  });
}

const VALID_EVIDENCE = JSON.stringify({
  verdict: 'PASS',
  checks: [{ name: 'x', status: 'PASS', evidence_url_or_text: 'y' }],
});

describe('validate-evidence CLI (spawn)', () => {
  it('valid evidence → exit 0 + OK: prefix on stdout', async () => {
    const { exitCode, stdout } = await runCli(VALID_EVIDENCE);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^OK:/);
  }, 20000);

  it('schema-invalid JSON → exit 1 + INVALID VerificationEvidence: prefix on stderr', async () => {
    const invalid = JSON.stringify({ verdict: 'NOT_A_VERDICT', checks: [] });
    const { exitCode, stderr } = await runCli(invalid);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/^INVALID VerificationEvidence:/m);
  }, 20000);

  it('non-JSON input → exit 1', async () => {
    const { exitCode, stderr } = await runCli('this is not json at all');
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/^INVALID VerificationEvidence:/m);
  }, 20000);

  it('empty stdin → exit 1', async () => {
    const { exitCode, stderr } = await runCli('');
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/empty/i);
  }, 20000);
});
