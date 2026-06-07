import { Command } from 'commander';
import Database from '../../db/driver.js';
import { statfs } from 'fs';
import { promisify } from 'util';
import { dirname } from 'path';
import { colorSuccess, colorError, colorWarn, colorInfo } from '../output/formatters.js';
import { jsonOutput } from '../output/json-output.js';
import '../config/env.js';
import { configSchema } from '../../config/env.js';
import { probeOidcState, type OidcProbe, type OidcState } from './setup.js';

const statfsAsync = promisify(statfs);

/**
 * OIDC readiness probe seam (task #812). Injectable so the doctor test can
 * drive the ready / disabled / degraded / unreachable branches without a live
 * server. Defaults to the same `GET /health/detailed` probe `setup --remote`
 * uses, so the CLI has ONE source of truth for the OIDC state shape.
 */
export type DoctorOidcProbe = OidcProbe;

/**
 * Resolved OIDC readiness state for the doctor line.
 *  - `ready`    → the remote server's OIDC login is up.
 *  - `disabled` → the remote server has OIDC turned off (PAT-only); fine.
 *  - `degraded` → OIDC configured but discovery is failing (login is down).
 *  - `unreachable` → the probe could not determine the state (network/non-2xx).
 *  - `not-configured` → no remote URL is configured, so OIDC is N/A locally.
 */
export type OidcReadiness = OidcState | 'unreachable' | 'not-configured';

/**
 * Format bytes as human-readable GB or MB string.
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface OidcReadinessResult {
  /** Resolved readiness state. */
  state: OidcReadiness;
  /** Single-line status message for the human-readable output. */
  message: string;
  /** Remediation hint shown on a non-ready state; undefined when ready/N-A. */
  remediation?: string;
  /** True when this state must fail the overall doctor run (exit non-zero). */
  blocking: boolean;
}

/**
 * Evaluate OIDC readiness for `tasks doctor` (task #812).
 *
 * Resolves to one of ready / disabled / degraded / unreachable / not-configured
 * and decides whether the state is BLOCKING (forces a non-zero exit):
 *  - `not-configured` → no remote URL, OIDC is N/A locally; never blocking.
 *  - `ready`          → login is up; never blocking.
 *  - `disabled`       → server is PAT-only by design; never blocking.
 *  - `degraded`       → blocking ONLY when OIDC is required (login is down but
 *                       the deployment depends on it).
 *  - `unreachable`    → the server could not be probed; always blocking (a
 *                       remote URL was configured but we can't reach it).
 *
 * The probe is injected so tests drive each branch without a live server.
 */
export async function evaluateOidcReadiness(
  baseUrl: string | undefined,
  required: boolean,
  probe: DoctorOidcProbe,
): Promise<OidcReadinessResult> {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    return {
      state: 'not-configured',
      message: 'No remote server configured (set WFT_API_URL to probe OIDC)',
      blocking: false,
    };
  }

  const result = await probe(baseUrl);

  if (!result.ok) {
    return {
      state: 'unreachable',
      message: `Could not probe ${baseUrl} (${result.reason})`,
      remediation:
        'Verify the server is running and WFT_API_URL is correct, then re-run `tasks doctor`.',
      blocking: true,
    };
  }

  switch (result.oidc) {
    case 'ready':
      return { state: 'ready', message: 'OIDC login is ready', blocking: false };
    case 'disabled':
      return {
        state: 'disabled',
        message: 'OIDC login is disabled (server is PAT-only)',
        remediation:
          'Browser login is unavailable; authenticate with a personal access token via `tasks setup --remote <url> --token <pat>`.',
        blocking: false,
      };
    case 'degraded':
      return {
        state: 'degraded',
        message: 'OIDC login is degraded (configured but discovery is failing)',
        remediation: required
          ? 'OIDC is required but discovery is failing; check the issuer/network on the server, then re-run `tasks doctor`.'
          : 'Browser login is down; fall back to a personal access token, or fix the OIDC issuer on the server.',
        blocking: required,
      };
  }
}

/**
 * Injectable OIDC probe default (task #812). The doctor test overrides this to
 * drive ready / disabled / degraded / unreachable branches without a live
 * server. Production uses the real `GET /health/detailed` probe from setup.ts.
 */
export const doctorOidcDefaults: { probe: DoctorOidcProbe } = { probe: probeOidcState };

export const doctorCommand = new Command('doctor')
  .description('Run diagnostics: DB connectivity, disk space, config validity, and OIDC readiness')
  .action(async () => {
    const dbPath = process.env['DATABASE_PATH'] || './data/tasks.db';

    const program = doctorCommand.parent;
    const isJsonMode = program?.optsWithGlobals()?.['json'] || false;

    // --- Check 1: Database connectivity ---
    let dbStatus: 'PASS' | 'FAIL' = 'FAIL';
    let dbMessage = '';

    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        db.prepare('SELECT 1').get();
        // Check WAL mode
        const journalMode = db.pragma('journal_mode', { simple: true }) as string;
        dbStatus = 'PASS';
        dbMessage =
          journalMode === 'wal' ? 'Connected (SQLite WAL mode)' : `Connected (${journalMode} mode)`;
      } finally {
        db.close();
      }
    } catch (error) {
      dbStatus = 'FAIL';
      if (error instanceof Error) {
        dbMessage = error.message.includes('ENOENT')
          ? `Database not found at ${dbPath}`
          : `Connection failed: ${error.message}`;
      } else {
        dbMessage = `Connection failed: unknown error`;
      }
    }

    // --- Check 2: Disk space ---
    let diskStatus: 'PASS' | 'WARN' | 'FAIL' = 'PASS';
    let diskMessage = '';
    let diskFree = 0;
    let diskTotal = 0;
    let diskFreePercent = '0.0';

    try {
      const stats = await statfsAsync(dirname(dbPath));
      diskFree = stats.bavail * stats.bsize;
      diskTotal = stats.blocks * stats.bsize;
      diskFreePercent = ((diskFree / diskTotal) * 100).toFixed(1);
      const freeNum = parseFloat(diskFreePercent);

      if (freeNum < 5) {
        diskStatus = 'FAIL';
      } else if (freeNum < 10) {
        diskStatus = 'WARN';
      } else {
        diskStatus = 'PASS';
      }
      diskMessage = `${diskFreePercent}% free (${formatBytes(diskFree)} / ${formatBytes(diskTotal)})`;
    } catch (error) {
      diskStatus = 'FAIL';
      diskMessage =
        error instanceof Error ? `Disk check failed: ${error.message}` : 'Disk check failed';
    }

    // --- Check 3: Config validity ---
    let configStatus: 'PASS' | 'FAIL' = 'PASS';
    let configMessage = '';
    let configErrors: Array<{ path: string; message: string }> = [];

    const result = configSchema.safeParse(process.env);
    if (result.success) {
      configStatus = 'PASS';
      configMessage = 'All required variables present';
    } else {
      configStatus = 'FAIL';
      configErrors = result.error.issues.map((issue) => ({
        path: issue.path.join('.') || String(issue.path[0] ?? 'unknown'),
        message: issue.message,
      }));
      configMessage = `${configErrors.length} issue(s)`;
    }

    // --- Check 4: OIDC readiness (task #812) ---
    // Probe the remote server's /health/detailed for its OIDC state when a
    // remote URL is configured. `--remote <url>` (global) wins over WFT_API_URL.
    const globalOpts = program?.optsWithGlobals() ?? {};
    const baseUrl =
      (typeof globalOpts['remote'] === 'string' && globalOpts['remote'].length > 0
        ? (globalOpts['remote'] as string)
        : undefined) ?? process.env['WFT_API_URL'];
    // OIDC is "required" when the operator declares it via WFT_OIDC_REQUIRED
    // (any truthy value except 0/false). A degraded server is then blocking.
    const oidcRequiredRaw = process.env['WFT_OIDC_REQUIRED'];
    const oidcRequired =
      typeof oidcRequiredRaw === 'string' &&
      oidcRequiredRaw.length > 0 &&
      !/^(0|false|no)$/i.test(oidcRequiredRaw);

    const oidc = await evaluateOidcReadiness(baseUrl, oidcRequired, doctorOidcDefaults.probe);

    // --- Set exit code if any check fails ---
    if (dbStatus === 'FAIL' || diskStatus === 'FAIL' || configStatus === 'FAIL' || oidc.blocking) {
      process.exitCode = 1;
    }

    // --- Output ---
    if (isJsonMode) {
      jsonOutput({
        database: { status: dbStatus, message: dbMessage },
        disk: {
          status: diskStatus,
          free: diskFree,
          total: diskTotal,
          freePercent: diskFreePercent,
        },
        config: { status: configStatus, errors: configErrors },
        oidc: {
          state: oidc.state,
          message: oidc.message,
          blocking: oidc.blocking,
          ...(oidc.remediation !== undefined && { remediation: oidc.remediation }),
        },
      });
    } else {
      const dbLabel = dbStatus === 'PASS' ? colorSuccess('[PASS]') : colorError('[FAIL]');

      const diskLabel =
        diskStatus === 'PASS'
          ? colorSuccess('[PASS]')
          : diskStatus === 'WARN'
            ? colorWarn('[WARN]')
            : colorError('[FAIL]');

      const configLabel = configStatus === 'PASS' ? colorSuccess('[PASS]') : colorError('[FAIL]');

      console.log(`Database:  ${dbLabel} ${dbMessage}`);

      console.log(`Disk:      ${diskLabel} ${diskMessage}`);

      if (configStatus === 'PASS') {
        console.log(`Config:    ${configLabel} ${configMessage}`);
      } else {
        console.log(`Config:    ${configLabel} ${configMessage}:`);
        for (const err of configErrors) {
          console.log(`           - ${err.path}: ${err.message}`);
        }
      }

      // OIDC readiness line (task #812). A single line that resolves to one of
      // ready / disabled / degraded / unreachable / not-configured, with a
      // remediation hint on any non-ready state.
      const oidcLabel =
        oidc.state === 'ready'
          ? colorSuccess('[PASS]')
          : oidc.state === 'not-configured'
            ? colorInfo('[N/A] ')
            : oidc.blocking
              ? colorError('[FAIL]')
              : colorWarn('[WARN]');
      console.log(`OIDC:      ${oidcLabel} ${oidc.message}`);
      if (oidc.remediation !== undefined) {
        console.log(`           - ${oidc.remediation}`);
      }
    }
  });
