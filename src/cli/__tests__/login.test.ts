/**
 * Phase 30 Plan 06 Task 3 — Subprocess integration tests for `tasks login`.
 *
 * Spawns the real CLI binary via `node tsx/cli src/cli/bin/tasks.ts login ...`
 * and points it at a per-test ephemeral Fastify server. Asserts on stdout,
 * stderr, exit code, and the credentials file on disk.
 *
 * Pattern follows src/cli/__tests__/e2e.test.ts. The CLI is invoked with
 * XDG_CONFIG_HOME pointed at a fresh tmp dir per test so each run has an
 * isolated credentials path, and with --no-browser by default so the
 * subprocess doesn't try to actually launch a browser on the test host.
 *
 * The fixture's `interval: 1` (in device-flow-server.ts) keeps wall-clock
 * runtime well under 10s per test even with three polls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import {
  startDeviceFlowServer,
  type DeviceFlowServer,
} from './helpers/device-flow-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const cliEntry = path.join(repoRoot, 'src/cli/bin/tasks.ts');

const requireFromHere = createRequire(import.meta.url);
const tsxCli = requireFromHere.resolve('tsx/cli', { paths: [repoRoot] });

const POSIX = process.platform !== 'win32';

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runLogin(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, 'login', ...args], {
      env: {
        ...process.env,
        ...env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        CI: '1',
      },
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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

const successEnvelope = {
  token: 'wfb_pat_TESTTOKEN1234567890',
  token_type: 'PAT',
  token_id: 42,
  user: {
    id: 7,
    displayName: 'Test User',
    email: 'test@example.com',
    isLegacy: false,
    isServiceAccount: false,
  },
};

describe('tasks login (subprocess)', () => {
  let server: DeviceFlowServer | null = null;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'wfb-login-test-'));
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

  it('happy path: writes credentials file at mode 0600 with the right fields', async () => {
    server = await startDeviceFlowServer({
      tokenResponses: [
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 200, body: successEnvelope },
      ],
    });

    const res = await runLogin(
      ['--no-browser', '--server', server.baseUrl],
      { XDG_CONFIG_HOME: tmpDir },
    );

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('Logged in as Test User');
    expect(res.stderr).toContain('ABCD-EFGH'); // user_code rendered

    const credPath = path.join(tmpDir, 'wood-fired-tasks', 'credentials');
    expect(existsSync(credPath)).toBe(true);
    if (POSIX) {
      const mode = statSync(credPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const body = readFileSync(credPath, 'utf8');
    const parsed = parse(body) as {
      active: {
        token: string;
        token_id: number;
        server: string;
        user_id: number;
        display_name: string;
        email: string;
        logged_in_at: string;
      };
    };
    expect(parsed.active.token).toBe(successEnvelope.token);
    expect(parsed.active.token_id).toBe(42);
    expect(parsed.active.server).toBe(server.baseUrl);
    expect(parsed.active.user_id).toBe(7);
    expect(parsed.active.display_name).toBe('Test User');
    expect(parsed.active.email).toBe('test@example.com');
  });

  it('--json mode emits {event:pending} then {event:logged_in} on stdout', async () => {
    server = await startDeviceFlowServer({
      tokenResponses: [{ status: 200, body: successEnvelope }],
    });

    const res = await runLogin(
      ['--json', '--no-browser', '--server', server.baseUrl],
      { XDG_CONFIG_HOME: tmpDir },
    );

    expect(res.exitCode).toBe(0);
    const lines = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(first.event).toBe('pending');
    expect(first.user_code).toBe('ABCD-EFGH');
    expect(first.verification_uri).toMatch(/auth\/device/);
    expect(last.event).toBe('logged_in');
    expect((last.user as { displayName: string }).displayName).toBe('Test User');
    expect(last.token_id).toBe(42);
  });

  it('expired_token surfaces friendly error and writes NO credentials file', async () => {
    server = await startDeviceFlowServer({
      tokenResponses: [{ status: 400, body: { error: 'expired_token' } }],
    });

    const res = await runLogin(
      ['--no-browser', '--server', server.baseUrl],
      { XDG_CONFIG_HOME: tmpDir },
    );

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Login link expired');
    const credPath = path.join(tmpDir, 'wood-fired-tasks', 'credentials');
    expect(existsSync(credPath)).toBe(false);
  });

  it('network failure surfaces a fetch error and exit 1', async () => {
    // Bind a server then immediately close it so the port is known-closed
    // and ECONNREFUSED is the deterministic outcome on every host. (Port 1
    // surfaces as "bad port" which is a different code path.)
    const ephemeral = await startDeviceFlowServer({ tokenResponses: [] });
    const closedUrl = ephemeral.baseUrl;
    await ephemeral.close();

    const res = await runLogin(
      ['--no-browser', '--server', closedUrl],
      { XDG_CONFIG_HOME: tmpDir },
      10_000,
    );
    expect(res.exitCode).toBe(1);
    // Either /code throws (catch in login.ts → err.message which is
    // node-fetch's "fetch failed" wrapped by requestDeviceCode into
    // "Failed to start device flow: <status>" OR — if fetch itself
    // rejects — the bare "fetch failed" string) OR the first /token poll
    // throws (pollForToken catch → "Could not reach ..."). All three
    // surfaces are acceptable network-failure outcomes; assert on the
    // union.
    const combined = res.stderr;
    expect(
      /Could not reach|Failed to start device flow|fetch failed/.test(combined),
    ).toBe(true);
    // And the credentials file MUST NOT exist.
    const credPath = path.join(tmpDir, 'wood-fired-tasks', 'credentials');
    expect(existsSync(credPath)).toBe(false);
  });

  it('--server flag is stored verbatim in credentials.active.server', async () => {
    server = await startDeviceFlowServer({
      tokenResponses: [{ status: 200, body: successEnvelope }],
    });

    const res = await runLogin(
      ['--no-browser', '--server', server.baseUrl],
      { XDG_CONFIG_HOME: tmpDir },
    );
    expect(res.exitCode).toBe(0);
    const credPath = path.join(tmpDir, 'wood-fired-tasks', 'credentials');
    const body = readFileSync(credPath, 'utf8');
    const parsed = parse(body) as { active: { server: string } };
    expect(parsed.active.server).toBe(server.baseUrl);
  });

  it('--token-name is sent to /auth/device/code in the request body', async () => {
    server = await startDeviceFlowServer({
      tokenResponses: [{ status: 200, body: successEnvelope }],
    });

    const res = await runLogin(
      [
        '--no-browser',
        '--server',
        server.baseUrl,
        '--token-name',
        'cli-testbox-2026-05-22',
      ],
      { XDG_CONFIG_HOME: tmpDir },
    );
    expect(res.exitCode).toBe(0);
    const codeBodies = server.getRequests().code;
    expect(codeBodies.length).toBeGreaterThan(0);
    expect(codeBodies[0]!.token_name).toBe('cli-testbox-2026-05-22');
  });

  it(
    'slow_down handling: --json emits {event:slow_down, interval:10}',
    async () => {
      server = await startDeviceFlowServer({
        tokenResponses: [
          { status: 400, body: { error: 'slow_down' } },
          { status: 200, body: successEnvelope },
        ],
      });

      const res = await runLogin(
        ['--json', '--no-browser', '--server', server.baseUrl],
        { XDG_CONFIG_HOME: tmpDir },
        // Initial interval=1 + slow_down → interval=6 → 6s sleep before
        // second poll. The subprocess timeout (25s) and the vitest test
        // timeout (30s, third arg below) both have to clear this.
        25_000,
      );
      expect(res.exitCode).toBe(0);
      const events = res.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const slowDowns = events.filter((e) => e.event === 'slow_down');
      expect(slowDowns).toHaveLength(1);
      // initial interval=1, slow_down +5 → 6.
      expect(slowDowns[0]!.interval).toBe(6);
      expect(events[events.length - 1]!.event).toBe('logged_in');
    },
    30_000,
  );

  it('--no-browser suppresses the "Opening browser..." stderr line', async () => {
    server = await startDeviceFlowServer({
      tokenResponses: [{ status: 200, body: successEnvelope }],
    });

    const res = await runLogin(
      ['--no-browser', '--server', server.baseUrl],
      { XDG_CONFIG_HOME: tmpDir },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stderr).not.toContain('Opening browser');
    // User code IS still printed inline as the manual-copy fallback.
    expect(res.stderr).toContain('ABCD-EFGH');
  });

  it('PAT value never appears on stdout or stderr (T-30-06-02)', async () => {
    server = await startDeviceFlowServer({
      tokenResponses: [{ status: 200, body: successEnvelope }],
    });

    const res = await runLogin(
      ['--no-browser', '--server', server.baseUrl],
      { XDG_CONFIG_HOME: tmpDir },
    );
    expect(res.exitCode).toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).not.toContain('wfb_pat_');
    expect(combined).not.toContain(successEnvelope.token);

    // Sanity: the token IS in the on-disk credentials file (so the test
    // isn't trivially passing because login wrote nothing).
    const credPath = path.join(tmpDir, 'wood-fired-tasks', 'credentials');
    const body = readFileSync(credPath, 'utf8');
    expect(body).toContain(successEnvelope.token);
  });
});
