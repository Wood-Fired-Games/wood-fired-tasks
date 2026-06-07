/**
 * In-process tests for src/cli/commands/doctor.ts (task #249).
 *
 * Drives database / disk / config checks across PASS, WARN, FAIL branches,
 * plus the --json output path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import Database from '../../db/driver.js';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../config/env.js', () => ({}));

describe('doctor command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let dbPath: string;
  let credsPath: string;
  let claudeJsonPath: string;
  const savedDbPath = process.env.DATABASE_PATH;
  const savedApiKeys = process.env.API_KEYS;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedApiUrl = process.env.WFT_API_URL;
  const savedOidcRequired = process.env.WFT_OIDC_REQUIRED;
  const savedApiKey = process.env.WFT_API_KEY;
  const savedCredsPath = process.env.WFT_CREDENTIALS_PATH;
  const savedClaudeJsonPath = process.env.WFT_CLAUDE_JSON_PATH;

  async function buildProgram() {
    const { doctorCommand } = await import('../commands/doctor.js');
    const p = new Command();
    p.option('--json', 'Output as JSON');
    p.addCommand(doctorCommand);
    return p;
  }

  /**
   * Override the injectable OIDC probe (task #812) so the OIDC readiness branch
   * is driven without a live server.
   */
  async function setOidcProbe(
    probe: (
      baseUrl: string,
    ) => Promise<
      { ok: true; oidc: 'ready' | 'disabled' | 'degraded' } | { ok: false; reason: string }
    >,
  ) {
    const { doctorOidcDefaults } = await import('../commands/doctor.js');
    doctorOidcDefaults.probe = probe;
  }

  /**
   * Override the injectable credentials-file server-reachability probe (task
   * #813) so the credentials check never touches the network.
   */
  async function setReachabilityProbe(probe: (baseUrl: string) => Promise<boolean>) {
    const { doctorReachabilityDefaults } = await import('../commands/doctor.js');
    doctorReachabilityDefaults.probe = probe;
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wft-doctor-'));
    dbPath = join(tmpDir, 'tasks.db');
    credsPath = join(tmpDir, 'credentials');
    claudeJsonPath = join(tmpDir, 'claude.json');

    // A trivial valid DB.
    const db = new Database(dbPath);
    db.exec('CREATE TABLE thing (id INTEGER)');
    db.close();

    process.env.DATABASE_PATH = dbPath;
    process.env.NO_COLOR = '1';
    process.env.NODE_ENV = 'test';
    // Default: no remote configured → OIDC line resolves to not-configured
    // (non-blocking) unless a test opts in by setting WFT_API_URL.
    delete process.env.WFT_API_URL;
    delete process.env.WFT_OIDC_REQUIRED;
    // task #813: isolate credential surfaces so the legacy detector + creds
    // file check never touch the real machine. No env keys, creds file and
    // claude.json point at (absent) tmp paths by default.
    delete process.env.WFT_API_KEY;
    delete process.env.API_KEYS;
    process.env.WFT_CREDENTIALS_PATH = credsPath;
    process.env.WFT_CLAUDE_JSON_PATH = claudeJsonPath;

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.exitCode = 0;
    // Default reachability probe: pretend reachable (overridden per-test).
    await setReachabilityProbe(async () => true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    stdoutSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }
    if (savedApiKeys === undefined) {
      delete process.env.API_KEYS;
    } else {
      process.env.API_KEYS = savedApiKeys;
    }
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
    if (savedApiUrl === undefined) {
      delete process.env.WFT_API_URL;
    } else {
      process.env.WFT_API_URL = savedApiUrl;
    }
    if (savedOidcRequired === undefined) {
      delete process.env.WFT_OIDC_REQUIRED;
    } else {
      process.env.WFT_OIDC_REQUIRED = savedOidcRequired;
    }
    if (savedApiKey === undefined) {
      delete process.env.WFT_API_KEY;
    } else {
      process.env.WFT_API_KEY = savedApiKey;
    }
    if (savedCredsPath === undefined) {
      delete process.env.WFT_CREDENTIALS_PATH;
    } else {
      process.env.WFT_CREDENTIALS_PATH = savedCredsPath;
    }
    if (savedClaudeJsonPath === undefined) {
      delete process.env.WFT_CLAUDE_JSON_PATH;
    } else {
      process.env.WFT_CLAUDE_JSON_PATH = savedClaudeJsonPath;
    }
    delete process.env.NO_COLOR;
    process.exitCode = 0;
  });

  it('reports all PASS when DB exists and config is valid', async () => {
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Database:\s+\[PASS\]/);
    expect(logged).toMatch(/Disk:\s+\[(PASS|WARN|FAIL)\]/);
    expect(logged).toMatch(/Config:\s+\[PASS\]/);
  });

  it('reports DB FAIL when database file is missing', async () => {
    rmSync(dbPath);
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Database:\s+\[FAIL\]/);
    // better-sqlite3 surfaces this either as "ENOENT"-style not-found, or as
    // a generic connection failure (depending on the platform).
    expect(logged).toMatch(/(Database not found at|Connection failed)/);
    expect(process.exitCode).toBe(1);
  });

  it('reports Disk FAIL when DB dir is unreachable', async () => {
    // Point at a path under a non-existent directory so statfs rejects.
    process.env.DATABASE_PATH = '/non/existent/path/tasks.db';
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Disk:\s+\[FAIL\]/);
    expect(process.exitCode).toBe(1);
  });

  it('config still PASSES when API_KEYS is absent (removed in v2.0 #800)', async () => {
    delete process.env.API_KEYS;
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Config:\s+\[PASS\]/);
    expect(logged).not.toContain('API_KEYS');
  });

  it('outputs JSON envelope when --json is set', async () => {
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', '--json', 'doctor']);
    expect(stdoutSpy).toHaveBeenCalled();
    const written = stdoutSpy.mock.calls[0][0] as string;
    const env = JSON.parse(written);
    expect(env.success).toBe(true);
    expect(env.data.database.status).toBe('PASS');
    expect(env.data.disk.status).toMatch(/^(PASS|WARN|FAIL)$/);
    expect(env.data.config.status).toBe('PASS');
    expect(env.data.config.errors).toEqual([]);
  });

  it('JSON config status is PASS with an empty error array when API_KEYS is absent', async () => {
    delete process.env.API_KEYS;
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', '--json', 'doctor']);
    const written = stdoutSpy.mock.calls[0][0] as string;
    const env = JSON.parse(written);
    expect(env.data.config.status).toBe('PASS');
    expect(env.data.config.errors).toEqual([]);
  });

  // ── OIDC readiness (task #812) ──────────────────────────────

  it('OIDC line is not-configured (non-blocking) when no remote URL is set', async () => {
    // beforeEach already deletes WFT_API_URL, so the probe must NOT run.
    let probed = false;
    await setOidcProbe(async () => {
      probed = true;
      return { ok: true, oidc: 'ready' };
    });
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/OIDC:\s+\[N\/A\]/);
    expect(logged).toMatch(/No remote server configured/);
    expect(probed).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('OIDC line resolves to ready and exits zero when the server reports ready', async () => {
    process.env.WFT_API_URL = 'http://oidc-test.local:3000';
    await setOidcProbe(async () => ({ ok: true, oidc: 'ready' }));
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/OIDC:\s+\[PASS\]/);
    expect(logged).toMatch(/OIDC login is ready/);
    expect(process.exitCode).toBe(0);
  });

  it('OIDC line resolves to disabled (non-blocking, exits zero) with a PAT remediation hint', async () => {
    process.env.WFT_API_URL = 'http://oidc-test.local:3000';
    await setOidcProbe(async () => ({ ok: true, oidc: 'disabled' }));
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/OIDC:\s+\[WARN\]/);
    expect(logged).toMatch(/OIDC login is disabled/);
    expect(logged).toMatch(/personal access token/);
    expect(process.exitCode).toBe(0);
  });

  it('OIDC degraded is non-blocking (exits zero) when OIDC is not required', async () => {
    process.env.WFT_API_URL = 'http://oidc-test.local:3000';
    await setOidcProbe(async () => ({ ok: true, oidc: 'degraded' }));
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/OIDC:\s+\[WARN\]/);
    expect(logged).toMatch(/OIDC login is degraded/);
    expect(process.exitCode).toBe(0);
  });

  it('OIDC degraded BLOCKS (exits non-zero) when WFT_OIDC_REQUIRED is set', async () => {
    process.env.WFT_API_URL = 'http://oidc-test.local:3000';
    process.env.WFT_OIDC_REQUIRED = '1';
    await setOidcProbe(async () => ({ ok: true, oidc: 'degraded' }));
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/OIDC:\s+\[FAIL\]/);
    expect(logged).toMatch(/OIDC login is degraded/);
    expect(logged).toMatch(/OIDC is required/);
    expect(process.exitCode).toBe(1);
  });

  it('OIDC unreachable BLOCKS (exits non-zero) when the probe fails', async () => {
    process.env.WFT_API_URL = 'http://oidc-test.local:3000';
    await setOidcProbe(async () => ({ ok: false, reason: 'connection refused' }));
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/OIDC:\s+\[FAIL\]/);
    expect(logged).toMatch(/Could not probe/);
    expect(logged).toMatch(/connection refused/);
    expect(process.exitCode).toBe(1);
  });

  it('--json envelope includes the resolved OIDC state and blocking flag', async () => {
    process.env.WFT_API_URL = 'http://oidc-test.local:3000';
    await setOidcProbe(async () => ({ ok: true, oidc: 'degraded' }));
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', '--json', 'doctor']);
    const written = stdoutSpy.mock.calls[0][0] as string;
    const env = JSON.parse(written);
    expect(env.data.oidc.state).toBe('degraded');
    expect(env.data.oidc.blocking).toBe(false);
    expect(typeof env.data.oidc.remediation).toBe('string');
  });

  // ── Legacy-credential detection (task #813) ──────────────────

  it('flags a non-PAT WFT_API_KEY (env) and exits non-zero with remediation', async () => {
    process.env.WFT_API_KEY = 'legacy-raw-secret-not-a-pat';
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Legacy:\s+\[FAIL\]/);
    expect(logged).toMatch(/WFT_API_KEY \(env\) is not a personal access token/);
    expect(logged).toMatch(/Unset the legacy WFT_API_KEY/);
    expect(process.exitCode).toBe(1);
  });

  it('does NOT flag a PAT-shaped WFT_API_KEY (env) and exits zero', async () => {
    // wft_pat_ + 32 chars of RFC 4648 base32 (A-Z, 2-7).
    process.env.WFT_API_KEY = 'wft_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Legacy:\s+\[PASS\]/);
    expect(logged).toMatch(/No legacy credentials detected/);
    expect(process.exitCode).toBe(0);
  });

  it('flags any API_KEYS env var and exits non-zero with remediation', async () => {
    process.env.API_KEYS = 'key1,key2';
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Legacy:\s+\[FAIL\]/);
    expect(logged).toMatch(/API_KEYS env var is set/);
    expect(logged).toMatch(/Unset API_KEYS/);
    expect(process.exitCode).toBe(1);
  });

  it('flags a non-PAT WFT_API_KEY hiding in ~/.claude.json', async () => {
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({
        mcpServers: {
          'wood-fired-tasks-remote': {
            type: 'stdio',
            command: 'tasks-client',
            env: { WFT_API_URL: 'http://x.local', WFT_API_KEY: 'legacy-json-secret' },
          },
        },
      }),
    );
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Legacy:\s+\[FAIL\]/);
    expect(logged).toMatch(/is not a personal access token/);
    expect(process.exitCode).toBe(1);
  });

  it('--json envelope reports legacyCredentials findings and blocking flag', async () => {
    process.env.API_KEYS = 'key1';
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', '--json', 'doctor']);
    const written = stdoutSpy.mock.calls[0][0] as string;
    const env = JSON.parse(written);
    expect(env.data.legacyCredentials.status).toBe('FAIL');
    expect(env.data.legacyCredentials.blocking).toBe(true);
    expect(env.data.legacyCredentials.findings.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
  });

  // ── Credentials-file check (task #813) ───────────────────────

  it('credentials file check WARNs (non-blocking) when no file exists', async () => {
    // beforeEach points WFT_CREDENTIALS_PATH at an absent tmp file.
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Creds:\s+\[WARN\]/);
    expect(logged).toMatch(/No credentials file/);
    expect(process.exitCode).toBe(0);
  });

  it('credentials file PASSES when mode 0600 and valid TOML', async () => {
    writeFileSync(
      credsPath,
      '[active]\ntoken = "wft_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"\n' +
        'token_id = 1\nserver = "http://creds.local:3000"\nuser_id = 1\n' +
        'display_name = "Tester"\nlogged_in_at = "2026-01-01T00:00:00Z"\n',
      { mode: 0o600 },
    );
    chmodSync(credsPath, 0o600);
    await setReachabilityProbe(async () => true);
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Creds:\s+\[PASS\]/);
    expect(logged).toMatch(/reachable/);
    expect(process.exitCode).toBe(0);
  });

  it('credentials file FAILS (blocking) when mode is not 0600', async () => {
    // POSIX-only assertion; skip on Windows where mode bits differ.
    if (process.platform === 'win32') return;
    writeFileSync(credsPath, '[active]\ntoken = "x"\n', { mode: 0o644 });
    chmodSync(credsPath, 0o644);
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Creds:\s+\[FAIL\]/);
    expect(logged).toMatch(/insecure permissions/);
    expect(logged).toMatch(/chmod 600/);
    expect(process.exitCode).toBe(1);
  });

  it('credentials file FAILS (blocking) when TOML is malformed', async () => {
    writeFileSync(credsPath, 'this is = = not valid toml ][', { mode: 0o600 });
    chmodSync(credsPath, 0o600);
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', 'doctor']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/Creds:\s+\[FAIL\]/);
    expect(logged).toMatch(/malformed TOML/);
    expect(process.exitCode).toBe(1);
  });

  it('--json envelope reports credentialsFile status and blocking flag', async () => {
    writeFileSync(credsPath, 'broken = = toml', { mode: 0o600 });
    chmodSync(credsPath, 0o600);
    const program = await buildProgram();
    await program.parseAsync(['node', 'tasks', '--json', 'doctor']);
    const written = stdoutSpy.mock.calls[0][0] as string;
    const env = JSON.parse(written);
    expect(env.data.credentialsFile.status).toBe('FAIL');
    expect(env.data.credentialsFile.blocking).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
