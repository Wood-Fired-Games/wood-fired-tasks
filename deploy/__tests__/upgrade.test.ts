import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Smoke test for deploy/upgrade.sh
//
// The full upgrade flow needs systemd + a privileged install dir and cannot
// run in CI. Instead we exercise the pieces that CAN regress silently:
//
//   1. The script parses as valid bash (bash -n).
//   2. The pre-flight refuses to run when ./dist/ is missing -- it exits
//      non-zero and tells the operator to run `npm run build`.
//
// These two assertions are enough to keep the most likely regressions
// (syntax breakage, pre-flight bypass) from landing on main unnoticed.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '..', '..');
const UPGRADE_SCRIPT = join(REPO_ROOT, 'deploy', 'upgrade.sh');
const INSTALL_SCRIPT = join(REPO_ROOT, 'deploy', 'install.sh');

describe('deploy/upgrade.sh', () => {
  it('parses as valid bash (bash -n)', () => {
    // bash -n parses the script without executing it. Throws on syntax
    // error; succeeds (exit 0) on a clean parse. Hardens against
    // accidental quoting / heredoc / set-option breakage.
    expect(() => execFileSync('bash', ['-n', UPGRADE_SCRIPT])).not.toThrow();
  });

  it('refuses to run when ./dist/ is missing and tells the operator to build', () => {
    // Run upgrade.sh from a tmpdir that has src/ but no dist/. The pre-flight
    // should reject with a clear "build" message and non-zero exit code.
    //
    // We pass WFT_INSTALL_DIR to a writable tmpdir as well so the script
    // never even thinks about touching /opt/. We also override SOURCE_DIR
    // resolution by invoking the script from the tmpdir but pointing it at
    // a copy of the script that resolves SOURCE_DIR via $(dirname "$0").
    const work = mkdtempSync(join(tmpdir(), 'wft-upgrade-smoke-'));
    try {
      // Lay out the fake "source tree" with src/ but NO dist/.
      mkdirSync(join(work, 'deploy'), { recursive: true });
      mkdirSync(join(work, 'src'), { recursive: true });
      writeFileSync(join(work, 'src', 'placeholder.ts'), '// fixture\n');

      // Copy upgrade.sh into the fake source tree's deploy/ so
      // $(cd "$(dirname "$0")/.." && pwd) resolves to `work`.
      const fakeUpgrade = join(work, 'deploy', 'upgrade.sh');
      const realUpgrade = execFileSync('cat', [UPGRADE_SCRIPT]).toString();
      writeFileSync(fakeUpgrade, realUpgrade, { mode: 0o755 });

      // Point the script at a tmp "install dir" so even if pre-flight is
      // bypassed somehow, nothing destructive happens to /opt/.
      const installDir = join(work, 'install');
      mkdirSync(installDir, { recursive: true });

      let stderr = '';
      let exitCode = 0;
      try {
        execFileSync('bash', [fakeUpgrade], {
          env: {
            ...process.env,
            WFT_INSTALL_DIR: installDir,
            // Skip the script's `exec sudo` re-exec so the pre-flight runs
            // unprivileged, in-process. WITHOUT this the script blocks forever
            // on sudo's /dev/tty password prompt whenever the suite runs under
            // an interactive terminal -- execFileSync is synchronous, so
            // vitest's test timeout can never interrupt it (the hang that
            // wedged a release publish for 100+ minutes). With the re-exec
            // skipped the script reaches its own dist/-missing pre-flight.
            WFT_SKIP_SUDO_REEXEC: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException & {
          status?: number;
          stderr?: Buffer;
          stdout?: Buffer;
        };
        exitCode = e.status ?? -1;
        stderr = `${e.stderr?.toString() ?? ''}${e.stdout?.toString() ?? ''}`;
      }

      // Pre-flight failures exit non-zero. Sudo not being available also
      // exits non-zero -- in both cases the test environment must NOT have
      // succeeded silently.
      expect(exitCode).not.toBe(0);
      // With WFT_SKIP_SUDO_REEXEC the script always reaches its own pre-flight
      // and prints the "Run 'npm run build' before deploying." marker. The
      // sudo-failure alternative is kept as a belt-and-braces fallback for any
      // environment where the re-exec still fires (e.g. a stale script copy).
      const sawBuildHint = /Run 'npm run build' before deploying\./.test(stderr);
      const sawSudoFailure = /sudo:|password is required|terminal is required/.test(stderr);
      expect(sawBuildHint || sawSudoFailure).toBe(true);

      // If the script DID reach its pre-flight, the install dir must not
      // have been mutated (no dist/, no backups/ created).
      if (sawBuildHint) {
        expect(() => statSync(join(installDir, 'dist'))).toThrow();
        expect(() => statSync(join(installDir, 'backups'))).toThrow();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('deploy/install.sh', () => {
  it('parses as valid bash (bash -n) after the upgrade.sh split', () => {
    // The refactor moved app-deploy steps out into upgrade.sh. Catch any
    // accidental syntax breakage introduced by the edit.
    expect(() => execFileSync('bash', ['-n', INSTALL_SCRIPT])).not.toThrow();
  });
});
