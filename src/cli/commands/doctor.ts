import { Command } from 'commander';
import Database from '../../db/driver.js';
import { statfs, existsSync, readFileSync, statSync } from 'fs';
import { promisify } from 'util';
import { dirname } from 'path';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { colorSuccess, colorError, colorWarn, colorInfo } from '../output/formatters.js';
import { jsonOutput } from '../output/json-output.js';
import '../config/env.js';
import { configSchema } from '../../config/env.js';
import { probeOidcState, type OidcProbe, type OidcState } from './setup.js';
import { getCredentialsPath } from '../auth/credentials.js';
import { PAT_PREFIX } from '../../services/pat-hash.js';

const statfsAsync = promisify(statfs);

const POSIX = process.platform !== 'win32';

/**
 * PAT shape check (task #813). A Personal Access Token is
 * `wft_pat_<32 chars RFC 4648 base32 (A-Z, 2-7)>` — the SAME shape the server's
 * PAT auth strategy validates (`src/api/plugins/auth/strategies/pat.ts`) and the
 * minter emits (`src/services/pat-hash.ts`). The legacy-credential detector
 * reuses this so a value that ISN'T PAT-shaped is flagged as a legacy key.
 */
const PAT_BODY_PATTERN = /^[A-Z2-7]{32}$/;
export function isPatShaped(value: string): boolean {
  if (!value.startsWith(PAT_PREFIX)) return false;
  return PAT_BODY_PATTERN.test(value.slice(PAT_PREFIX.length));
}

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

// ── Legacy-credential detection (task #813) ──────────────────────────────

/**
 * One flagged legacy-shaped credential.
 *  - `source`      — where the value was found (env var name, or the
 *                    `~/.claude.json` MCP entry path).
 *  - `message`     — human-readable one-liner for the doctor output.
 *  - `remediation` — how to remove it and migrate to a PAT.
 */
export interface LegacyCredentialFinding {
  source: string;
  message: string;
  remediation: string;
}

export interface LegacyCredentialResult {
  /** PASS when nothing legacy is present; FAIL when at least one is flagged. */
  status: 'PASS' | 'FAIL';
  findings: LegacyCredentialFinding[];
  /** True when any finding is present — a flagged legacy credential blocks. */
  blocking: boolean;
}

/**
 * Best-effort read of `WFT_API_KEY` from the remote MCP entry in
 * `~/.claude.json` (`mcpServers[*].env.WFT_API_KEY`). `setup --remote` stows the
 * token there, so a stale legacy key can hide in the JSON even when the env is
 * clean. Returns the first WFT_API_KEY value found across all server entries, or
 * null. Never throws — a missing/malformed file just yields null.
 */
export function readClaudeJsonApiKey(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8');
    if (raw.trim().length === 0) return null;
    const parsed = JSON.parse(raw) as unknown;
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    if (typeof servers !== 'object' || servers === null) return null;
    for (const entry of Object.values(servers as Record<string, unknown>)) {
      const env = (entry as { env?: unknown } | null)?.env;
      if (typeof env === 'object' && env !== null) {
        const key = (env as Record<string, unknown>)['WFT_API_KEY'];
        if (typeof key === 'string' && key.length > 0) return key;
      }
    }
  } catch {
    // Unreadable / malformed claude.json is not this check's concern.
    return null;
  }
  return null;
}

/**
 * Detect legacy-shaped credentials (task #813):
 *   - a non-PAT `WFT_API_KEY` (from env OR `~/.claude.json`), and
 *   - any `API_KEYS` env var (the removed v1.x server-side key list).
 *
 * A PAT-shaped `WFT_API_KEY` is fine (that's how the bridge authenticates) and
 * is NOT flagged. Any flagged finding is BLOCKING (forces a non-zero exit) — a
 * legacy credential silently keeps working against an old server and masks the
 * PAT migration, so the operator must be told to remove it.
 *
 * `claudeJsonPath` is injected so the test can point at a fixture.
 */
export function detectLegacyCredentials(
  env: NodeJS.ProcessEnv,
  claudeJsonPath: string,
): LegacyCredentialResult {
  const findings: LegacyCredentialFinding[] = [];

  // 1. WFT_API_KEY from the environment — flag only when it isn't PAT-shaped.
  const envApiKey = env['WFT_API_KEY'];
  if (typeof envApiKey === 'string' && envApiKey.length > 0 && !isPatShaped(envApiKey)) {
    findings.push({
      source: 'env WFT_API_KEY',
      message: 'WFT_API_KEY (env) is not a personal access token',
      remediation:
        'Unset the legacy WFT_API_KEY env var and authenticate with a PAT via `tasks login` (or `tasks setup --remote <url> --token <pat>`).',
    });
  }

  // 2. WFT_API_KEY hiding in ~/.claude.json — flag only when not PAT-shaped.
  const jsonApiKey = readClaudeJsonApiKey(claudeJsonPath);
  if (jsonApiKey !== null && !isPatShaped(jsonApiKey)) {
    findings.push({
      source: `claude.json WFT_API_KEY (${claudeJsonPath})`,
      message: `WFT_API_KEY in ${claudeJsonPath} is not a personal access token`,
      remediation:
        'Re-run `tasks setup --remote <url> --token <pat>` to replace the legacy key in ~/.claude.json with a PAT.',
    });
  }

  // 3. API_KEYS env — the removed v1.x server-side key list. Any value is legacy.
  const apiKeys = env['API_KEYS'];
  if (typeof apiKeys === 'string' && apiKeys.length > 0) {
    findings.push({
      source: 'env API_KEYS',
      message: 'API_KEYS env var is set (removed in v2.0)',
      remediation:
        'Unset API_KEYS; the server no longer uses a static key list — mint per-user PATs instead.',
    });
  }

  return {
    status: findings.length > 0 ? 'FAIL' : 'PASS',
    findings,
    blocking: findings.length > 0,
  };
}

// ── Credentials-file check (task #813) ───────────────────────────────────

/**
 * Result of the credentials-file check (task #813). PASS/WARN/FAIL:
 *  - WARN  → no credentials file exists yet (not an error; you may not have
 *            logged in). Never blocking.
 *  - FAIL  → file exists but is mode != 0600 (POSIX), or its body is not
 *            well-formed TOML. Always blocking.
 *  - PASS  → file exists, is 0600, and parses as TOML. `reachable`/`server`
 *            annotate the reachability sub-probe (non-blocking on failure —
 *            the server can simply be down).
 */
export interface CredentialsFileResult {
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  remediation?: string;
  blocking: boolean;
  /** Server URL parsed from the file's `[active].server`, when present. */
  server?: string;
  /** Reachability of `server`: undefined when not probed. */
  reachable?: boolean;
}

/** Injectable server-reachability probe so the test drives it without a server. */
export type ReachabilityProbe = (baseUrl: string) => Promise<boolean>;

/**
 * Default reachability probe: `GET <server>/health` and treat any HTTP response
 * (even non-2xx) as "reachable". Network errors → not reachable. Best-effort and
 * never throws.
 */
export async function defaultReachabilityProbe(baseUrl: string): Promise<boolean> {
  try {
    const url = new URL('/health', baseUrl).toString();
    // Bound the probe: a server that accepts the connection but never responds
    // must not hang `tasks doctor` forever — surface it as "not reachable".
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Injectable reachability default (task #813). The doctor test overrides this.
 */
export const doctorReachabilityDefaults: { probe: ReachabilityProbe } = {
  probe: defaultReachabilityProbe,
};

/**
 * Validate the CLI credentials file (task #813): it must be mode 0600 on POSIX,
 * well-formed TOML, and — best-effort — its `server` should be reachable.
 *
 * Blocking rules:
 *  - missing file        → WARN, non-blocking (you may simply not be logged in).
 *  - mode != 0600 (POSIX) → FAIL, blocking (a world/group-readable secret).
 *  - malformed TOML      → FAIL, blocking.
 *  - unreachable server  → still PASS (non-blocking); the server may be down.
 */
export async function checkCredentialsFile(
  filePath: string,
  probe: ReachabilityProbe,
): Promise<CredentialsFileResult> {
  if (!existsSync(filePath)) {
    return {
      status: 'WARN',
      message: `No credentials file at ${filePath}`,
      remediation: 'Run `tasks login` (or `tasks setup --remote <url>`) to authenticate.',
      blocking: false,
    };
  }

  // Permission check (POSIX). Any group/other bit set → insecure.
  if (POSIX) {
    let mode: number;
    try {
      // existsSync passed above, but stat can still throw on a dangling symlink,
      // an EACCES parent dir, ELOOP, etc. Treat any stat failure as a blocking
      // FAIL with the underlying reason rather than crashing the whole doctor.
      mode = statSync(filePath).mode & 0o777;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'FAIL',
        message: `Could not stat credentials file ${filePath}: ${msg}`,
        remediation:
          'Verify the file (and its parent directory) is accessible and not a broken symlink.',
        blocking: true,
      };
    }
    if ((mode & 0o077) !== 0) {
      const octal = mode.toString(8).padStart(3, '0');
      return {
        status: 'FAIL',
        message: `Credentials file ${filePath} has insecure permissions (mode ${octal}, expected 600)`,
        remediation: `Run: chmod 600 ${filePath}`,
        blocking: true,
      };
    }
  }

  // Well-formed TOML check.
  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(filePath, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'FAIL',
      message: `Credentials file ${filePath} is malformed TOML: ${msg}`,
      remediation: 'Run `tasks login` to regenerate the credentials file.',
      blocking: true,
    };
  }

  // Best-effort reachability of the recorded server. Never blocking.
  const server = (parsed as { active?: { server?: unknown } } | null)?.active?.server;
  if (typeof server === 'string' && server.length > 0) {
    const reachable = await probe(server);
    return {
      status: 'PASS',
      message: reachable
        ? `Credentials file OK (0600, valid TOML); server ${server} reachable`
        : `Credentials file OK (0600, valid TOML); server ${server} unreachable`,
      ...(reachable
        ? {}
        : { remediation: `Could not reach ${server}; verify the server is running.` }),
      blocking: false,
      server,
      reachable,
    };
  }

  return {
    status: 'PASS',
    message: `Credentials file OK (0600, valid TOML)`,
    blocking: false,
  };
}

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

    // --- Check 5: Legacy-credential detector (task #813) ---
    // Flag a non-PAT WFT_API_KEY (env or ~/.claude.json) and any API_KEYS env
    // var. Any flagged finding is BLOCKING.
    const claudeJsonPath =
      process.env['WFT_CLAUDE_JSON_PATH'] || path.join(os.homedir(), '.claude.json');
    const legacy = detectLegacyCredentials(process.env, claudeJsonPath);

    // --- Check 6: Credentials file (task #813) ---
    // Validate 0600 mode, well-formed TOML, and (best-effort) server reachability.
    const credentials = await checkCredentialsFile(
      getCredentialsPath(),
      doctorReachabilityDefaults.probe,
    );

    // --- Set exit code if any check fails ---
    if (
      dbStatus === 'FAIL' ||
      diskStatus === 'FAIL' ||
      configStatus === 'FAIL' ||
      oidc.blocking ||
      legacy.blocking ||
      credentials.blocking
    ) {
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
        legacyCredentials: {
          status: legacy.status,
          blocking: legacy.blocking,
          findings: legacy.findings,
        },
        credentialsFile: {
          status: credentials.status,
          message: credentials.message,
          blocking: credentials.blocking,
          ...(credentials.remediation !== undefined && { remediation: credentials.remediation }),
          ...(credentials.server !== undefined && { server: credentials.server }),
          ...(credentials.reachable !== undefined && { reachable: credentials.reachable }),
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

      // Legacy-credential detector (task #813). PASS when clean; FAIL (blocking)
      // when any legacy-shaped credential is present, with per-finding hints.
      const legacyLabel = legacy.status === 'PASS' ? colorSuccess('[PASS]') : colorError('[FAIL]');
      const legacyMessage =
        legacy.status === 'PASS'
          ? 'No legacy credentials detected'
          : `${legacy.findings.length} legacy credential(s) detected`;
      console.log(`Legacy:    ${legacyLabel} ${legacyMessage}`);
      for (const finding of legacy.findings) {
        console.log(`           - ${finding.message}`);
        console.log(`             ${finding.remediation}`);
      }

      // Credentials file check (task #813).
      const credLabel =
        credentials.status === 'PASS'
          ? colorSuccess('[PASS]')
          : credentials.status === 'WARN'
            ? colorWarn('[WARN]')
            : colorError('[FAIL]');
      console.log(`Creds:     ${credLabel} ${credentials.message}`);
      if (credentials.remediation !== undefined) {
        console.log(`           - ${credentials.remediation}`);
      }
    }
  });
