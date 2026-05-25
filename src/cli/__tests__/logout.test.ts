/**
 * Phase 30 Plan 07 Task 1 — Subprocess integration tests for `tasks logout`.
 *
 * Spawns the real CLI via `node tsx/cli src/cli/bin/tasks.ts logout ...`
 * pointed at a per-test ephemeral Fastify (helpers/logout-server.ts) and
 * a per-test XDG_CONFIG_HOME tmpdir that pre-seeds a credentials file
 * (when applicable). Asserts on stdout, stderr, exit code, the
 * credentials file on disk after the command, and the captured
 * Authorization header on the server side.
 *
 * Pattern mirrors src/cli/__tests__/login.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  startLogoutWhoamiServer,
  type LogoutWhoamiServer,
} from './helpers/logout-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const cliEntry = path.join(repoRoot, 'src/cli/bin/tasks.ts');

const requireFromHere = createRequire(import.meta.url);
const tsxCli = requireFromHere.resolve('tsx/cli', { paths: [repoRoot] });

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runLogout(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, cliEntry, 'logout', ...args],
      {
        env: {
          ...process.env,
          ...env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          CI: '1',
        },
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code,
      });
    });
  });
}

/**
 * Write a valid TOML credentials file at the XDG location used by the
 * subprocess. Mirrors src/cli/auth/credentials.ts:writeCredentials but
 * inline so the test isn't coupled to that helper's import surface
 * across subprocess boundaries.
 */
function seedCredentials(
  tmpDir: string,
  active: {
    token: string;
    token_id: number;
    server: string;
    user_id?: number;
    display_name?: string;
    email?: string;
    logged_in_at?: string;
  },
): string {
  const dir = path.join(tmpDir, 'wood-fired-tasks');
  mkdirSync(dir, { recursive: true });
  const credPath = path.join(dir, 'credentials');
  const body =
    '# Wood Fired Tasks CLI credentials. Created by `tasks login`.\n' +
    '# Do NOT commit this file to version control.\n\n' +
    '[active]\n' +
    `token = "${active.token}"\n` +
    `token_id = ${active.token_id}\n` +
    `server = "${active.server}"\n` +
    `user_id = ${active.user_id ?? 7}\n` +
    `display_name = "${active.display_name ?? 'Test User'}"\n` +
    `email = "${active.email ?? 'test@example.com'}"\n` +
    `logged_in_at = "${active.logged_in_at ?? '2026-05-23T12:00:00.000Z'}"\n`;
  writeFileSync(credPath, body, { mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(credPath, 0o600);
  }
  return credPath;
}

const TEST_TOKEN = 'wfb_pat_TESTTOKEN1234567890';

describe('tasks logout (subprocess)', () => {
  let server: LogoutWhoamiServer | null = null;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'wfb-logout-test-'));
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('idempotent: no credentials file → exit 0 with "Not logged in"', async () => {
    const res = await runLogout([], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('Not logged in');
    // No credentials file was created or left behind.
    const credPath = path.join(tmpDir, 'wood-fired-tasks', 'credentials');
    expect(existsSync(credPath)).toBe(false);
  });

  it('idempotent --json: no credentials file → {event:logged_out, revoked:false, alreadyLoggedOut:true}', async () => {
    const res = await runLogout(['--json'], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    const lines = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const envelope = JSON.parse(lines[lines.length - 1]!) as Record<
      string,
      unknown
    >;
    expect(envelope.event).toBe('logged_out');
    expect(envelope.revoked).toBe(false);
    expect(envelope.alreadyLoggedOut).toBe(true);
  });

  it('happy path 204: revokes server-side, deletes local file, exit 0', async () => {
    server = await startLogoutWhoamiServer({
      logoutResponse: { status: 204, body: null },
    });
    const credPath = seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });
    expect(existsSync(credPath)).toBe(true);

    const res = await runLogout([], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('Logged out');
    expect(existsSync(credPath)).toBe(false);

    const recorded = server.getRequests().logout;
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.authorization).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it('happy path 204 --json: {event:logged_out, revoked:true, tokenId}', async () => {
    server = await startLogoutWhoamiServer({
      logoutResponse: { status: 204, body: null },
    });
    seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });

    const res = await runLogout(['--json'], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    const lines = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const envelope = JSON.parse(lines[lines.length - 1]!) as Record<
      string,
      unknown
    >;
    expect(envelope.event).toBe('logged_out');
    expect(envelope.revoked).toBe(true);
    expect(envelope.tokenId).toBe(17);
  });

  it('401: token already invalid → local file deleted + friendly message', async () => {
    server = await startLogoutWhoamiServer({
      logoutResponse: {
        status: 401,
        body: { error: 'UNAUTHORIZED', message: 'token revoked' },
      },
    });
    const credPath = seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });

    const res = await runLogout([], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain(
      'server-side token was already invalid',
    );
    expect(existsSync(credPath)).toBe(false);
  });

  it('500: local file still deleted + warning printed (exit 0)', async () => {
    server = await startLogoutWhoamiServer({
      logoutResponse: {
        status: 500,
        body: { error: 'INTERNAL_ERROR', message: 'boom' },
      },
    });
    const credPath = seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });

    const res = await runLogout([], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('Local credentials cleared');
    expect(res.stderr).toContain('17'); // token id surfaced to user
    expect(existsSync(credPath)).toBe(false);
  });

  it('500 --json: warning field is set, revoked=false', async () => {
    server = await startLogoutWhoamiServer({
      logoutResponse: {
        status: 500,
        body: { error: 'INTERNAL_ERROR', message: 'boom' },
      },
    });
    seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });

    const res = await runLogout(['--json'], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    const lines = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const envelope = JSON.parse(lines[lines.length - 1]!) as Record<
      string,
      unknown
    >;
    expect(envelope.event).toBe('logged_out');
    expect(envelope.revoked).toBe(false);
    expect(envelope.tokenId).toBe(17);
    expect(typeof envelope.warning).toBe('string');
    expect((envelope.warning as string).length).toBeGreaterThan(0);
  });

  it('network error: local file deleted, fallback warning printed, exit 0', async () => {
    // Spin up & close a server so we have a known-closed port → deterministic
    // ECONNREFUSED on every host.
    const ephemeral = await startLogoutWhoamiServer({});
    const closedUrl = ephemeral.baseUrl;
    await ephemeral.close();

    const credPath = seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: closedUrl,
    });

    const res = await runLogout([], { XDG_CONFIG_HOME: tmpDir }, 12_000);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('Local credentials cleared');
    expect(existsSync(credPath)).toBe(false);
  });

  it('PAT value never appears in stdout or stderr (T-30-07-01)', async () => {
    server = await startLogoutWhoamiServer({
      logoutResponse: { status: 204, body: null },
    });
    seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });

    const res = await runLogout(['--json'], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).not.toContain('wfb_pat_');
    expect(combined).not.toContain(TEST_TOKEN);
  });
});
