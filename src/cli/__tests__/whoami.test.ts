/**
 * Phase 30 Plan 07 Task 2 — Subprocess integration tests for `tasks whoami`.
 *
 * Spawns the real CLI via `node tsx/cli src/cli/bin/tasks.ts whoami ...`
 * pointed at a per-test ephemeral Fastify (helpers/logout-server.ts) and
 * a per-test XDG_CONFIG_HOME tmpdir that pre-seeds a credentials file
 * (when applicable).
 *
 * Pattern mirrors src/cli/__tests__/login.test.ts and logout.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startLogoutWhoamiServer, type LogoutWhoamiServer } from './helpers/logout-server.js';

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

function runWhoami(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, 'whoami', ...args], {
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
    `display_name = "${active.display_name ?? 'Stuart Jeff'}"\n` +
    `email = "${active.email ?? 'stuart@woodfiredgames.com'}"\n` +
    `logged_in_at = "${active.logged_in_at ?? '2026-05-23T12:00:00.000Z'}"\n`;
  writeFileSync(credPath, body, { mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(credPath, 0o600);
  }
  return credPath;
}

const TEST_TOKEN = 'wft_pat_TESTTOKEN1234567890';

const STUART_ME = {
  id: 1,
  displayName: 'Stuart Jeff',
  email: 'stuart@woodfiredgames.com',
  isLegacy: false,
  isServiceAccount: false,
};

/**
 * `/me` body for a PAT caller: the server appends the calling token's own
 * name/scopes/binding (src/api/routes/me/profile.ts). The token LIST route
 * `/me/tokens` is session-only and 403s a PAT, so whoami must not depend on it.
 */
function meWithToken(
  id: number,
  name: string,
  lastUsedAt: string | null,
  opts: { scopes?: string[]; projectId?: number | null } = {},
) {
  return {
    ...STUART_ME,
    token: {
      id,
      name,
      scopes: opts.scopes ?? ['write'],
      projectId: opts.projectId ?? null,
      lastUsedAt,
    },
  };
}

// What the real server answers a PAT on the session-only list route.
const TOKENS_SESSION_ONLY = {
  status: 403,
  body: { error: 'session_required', message: 'session required' },
};

describe('tasks whoami (subprocess)', () => {
  let server: LogoutWhoamiServer | null = null;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'wft-whoami-test-'));
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

  it('not logged in (no creds file): exit 1 with "Not logged in. Run: tasks login"', async () => {
    const res = await runWhoami([], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Not logged in');
    expect(res.stderr).toContain('tasks login');
  });

  it('not logged in --json: stdout {event:not_logged_in}', async () => {
    const res = await runWhoami(['--json'], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(1);
    const lines = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const envelope = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(envelope.event).toBe('not_logged_in');
  });

  it('happy path text: prints all 5 labeled lines with the right values', async () => {
    server = await startLogoutWhoamiServer({
      meResponse: {
        status: 200,
        body: meWithToken(17, 'cli-stuart-laptop-2026-05-23', '2026-05-23T12:34:56.000Z'),
      },
      tokensResponse: TOKENS_SESSION_ONLY,
    });
    seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });

    const res = await runWhoami([], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Display name: Stuart Jeff');
    expect(res.stdout).toContain('Email:        stuart@woodfiredgames.com');
    expect(res.stdout).toContain('Active token: cli-stuart-laptop-2026-05-23 (id 17)');
    expect(res.stdout).toContain('Scopes:       [write]');
    expect(res.stdout).not.toContain('Project:');
    expect(res.stderr).not.toContain('warning');
    expect(res.stdout).toContain('Last used:    2026-05-23T12:34:56.000Z');
    expect(res.stdout).toContain(`Server:       ${server.baseUrl}`);

    // Authorization header sent with Bearer prefix.
    const recorded = server.getRequests();
    expect(recorded.me[0]!.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    // The session-only list route is never consulted with a PAT.
    expect(recorded.tokens).toHaveLength(0);
  });

  it('happy path --json: documented envelope shape', async () => {
    server = await startLogoutWhoamiServer({
      meResponse: {
        status: 200,
        body: meWithToken(17, 'cli-stuart-laptop-2026-05-23', '2026-05-23T12:34:56.000Z'),
      },
      tokensResponse: TOKENS_SESSION_ONLY,
    });
    seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });

    const res = await runWhoami(['--json'], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    const lines = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const envelope = JSON.parse(lines[lines.length - 1]!) as {
      user: Record<string, unknown>;
      token?: {
        id: number;
        name: string;
        lastUsedAt: string | null;
        scopes: string[];
        projectId: number | null;
      };
      server: string;
      fallback?: string;
    };
    expect(envelope.user.id).toBe(1);
    expect(envelope.user.displayName).toBe('Stuart Jeff');
    expect(envelope.user.email).toBe('stuart@woodfiredgames.com');
    expect(envelope.token).toBeDefined();
    expect(envelope.token!.id).toBe(17);
    expect(envelope.token!.name).toBe('cli-stuart-laptop-2026-05-23');
    expect(envelope.token!.lastUsedAt).toBe('2026-05-23T12:34:56.000Z');
    expect(envelope.token!.scopes).toEqual(['write']);
    expect(envelope.token!.projectId).toBeNull();
    expect(envelope.server).toBe(server.baseUrl);
    expect(envelope.fallback).toBeUndefined();
  });

  it('/me without a token block (legacy key / older server): omits the token lines', async () => {
    server = await startLogoutWhoamiServer({
      meResponse: { status: 200, body: STUART_ME },
      tokensResponse: TOKENS_SESSION_ONLY,
    });
    seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });

    const res = await runWhoami([], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Display name: Stuart Jeff');
    expect(res.stdout).toContain('Email:        stuart@woodfiredgames.com');
    expect(res.stdout).not.toContain('Active token:');
    expect(res.stdout).not.toContain('Scopes:');
    expect(res.stdout).not.toContain('Last used:');
    expect(res.stdout).toContain(`Server:       ${server.baseUrl}`);

    // --json should also omit the token block.
    const resJson = await runWhoami(['--json'], { XDG_CONFIG_HOME: tmpDir });
    expect(resJson.exitCode).toBe(0);
    const envelope = JSON.parse(resJson.stdout.trim().split('\n').slice(-1)[0]!) as Record<
      string,
      unknown
    >;
    expect(envelope.token).toBeUndefined();
    expect((envelope.user as { id: number }).id).toBe(1);
  });

  it('/me 401 (revoked token): exit 1 with "Stored token is invalid"', async () => {
    server = await startLogoutWhoamiServer({
      meResponse: {
        status: 401,
        body: { error: 'UNAUTHORIZED', message: 'token revoked' },
      },
    });
    seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });

    const res = await runWhoami([], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Stored token is invalid');
    expect(res.stderr).toContain('tasks login');
  });

  it('/me network error: exit 1 with "Could not reach"', async () => {
    const ephemeral = await startLogoutWhoamiServer({});
    const closedUrl = ephemeral.baseUrl;
    await ephemeral.close();

    seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: closedUrl,
    });

    const res = await runWhoami([], { XDG_CONFIG_HOME: tmpDir }, 12_000);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Could not reach');
  });

  it('project-bound token: prints the binding in text and --json', async () => {
    server = await startLogoutWhoamiServer({
      meResponse: {
        status: 200,
        body: meWithToken(17, 'bound-token', null, { scopes: ['read'], projectId: 42 }),
      },
      tokensResponse: TOKENS_SESSION_ONLY,
    });
    seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });

    const res = await runWhoami([], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Scopes:       [read]');
    expect(res.stdout).toContain('Project:      #42');
    expect(res.stdout).toContain('Last used:    (never)');

    const resJson = await runWhoami(['--json'], { XDG_CONFIG_HOME: tmpDir });
    const envelope = JSON.parse(resJson.stdout.trim().split('\n').slice(-1)[0]!) as {
      token: { projectId: number | null; scopes: string[] };
    };
    expect(envelope.token.projectId).toBe(42);
    expect(envelope.token.scopes).toEqual(['read']);
  });

  // Removed in the v2.0 cutover (#802, commit d9ffe56 "make CLI client +
  // credentials Bearer-PAT-only"): the `whoami` command no longer recognizes
  // the legacy `API_KEY` env var, so it no longer emits the "API_KEY env var
  // ignored — credentials file in use" text footer or the `fallback` JSON
  // field. This test asserted that intentionally-removed behavior and is
  // therefore obsolete.

  it('PAT value never appears in stdout or stderr (T-30-07-01)', async () => {
    server = await startLogoutWhoamiServer({
      meResponse: {
        status: 200,
        body: meWithToken(17, 'cli-stuart-laptop-2026-05-23', '2026-05-23T12:34:56.000Z'),
      },
      tokensResponse: TOKENS_SESSION_ONLY,
    });
    seedCredentials(tmpDir, {
      token: TEST_TOKEN,
      token_id: 17,
      server: server.baseUrl,
    });

    const res = await runWhoami(['--json'], { XDG_CONFIG_HOME: tmpDir });
    expect(res.exitCode).toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).not.toContain('wft_pat_');
    expect(combined).not.toContain(TEST_TOKEN);
  });
});
