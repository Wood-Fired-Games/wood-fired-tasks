/**
 * Project 29 Phase 4 Task #599 — Subprocess integration tests for
 * `tasks statusline`.
 *
 * Spawns the real CLI via `node tsx/cli src/cli/bin/tasks.ts statusline`,
 * pipes a sample Claude Code status-line JSON on stdin, and asserts the
 * documented behaviors against:
 *
 *   - a per-test XDG_CONFIG_HOME tmpdir that pre-seeds the credentials file
 *     (so the API client can authenticate) and the optional `config` flag,
 *   - a per-test WFT_CACHE_PATH tmpdir holding the count + update caches,
 *   - a per-test cwd tmpdir carrying the `.wft/project` marker (#595) that
 *     links the directory to a numeric project id,
 *   - an ephemeral Fastify server (helpers/statusline-server.ts) standing in
 *     for the REST API, with API_BASE_URL pointed at it.
 *
 * Pattern mirrors src/cli/__tests__/whoami.test.ts (subprocess spawn +
 * ephemeral server + tmpdir) and count-fetcher.test.ts (the counts cache).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startStatuslineServer, type StatuslineServer } from './helpers/statusline-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const cliEntry = path.join(repoRoot, 'src/cli/bin/tasks.ts');

const requireFromHere = createRequire(import.meta.url);
const tsxCli = requireFromHere.resolve('tsx/cli', { paths: [repoRoot] });

const TEST_TOKEN = 'wft_pat_TESTTOKEN1234567890';
const PROJECT_ID = 4242;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Spawn `tasks statusline`, pipe `stdinPayload` on stdin to EOF, and resolve
 * the captured streams + exit code. `env` is merged over a color-disabled,
 * CI-flagged base; pass `XDG_CONFIG_HOME`, `WFT_CACHE_PATH`, `API_BASE_URL`,
 * and any update-check switches per case.
 */
function runStatusline(
  stdinPayload: string,
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, 'statusline'], {
      env: {
        ...process.env,
        ...env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        CI: '1',
      },
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
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

    // Feed the Claude Code status-line JSON on stdin, then EOF.
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

/** Pre-seed a 0o600 credentials file under `$XDG_CONFIG_HOME` for auth. */
function seedCredentials(configHome: string, server: string): void {
  const dir = path.join(configHome, 'wood-fired-tasks');
  mkdirSync(dir, { recursive: true });
  const credPath = path.join(dir, 'credentials');
  const body =
    '# Wood Fired Tasks CLI credentials. Created by `tasks login`.\n\n' +
    '[active]\n' +
    `token = "${TEST_TOKEN}"\n` +
    'token_id = 17\n' +
    `server = "${server}"\n` +
    'user_id = 7\n' +
    'display_name = "Stuart Jeff"\n' +
    'email = "stuart@woodfiredgames.com"\n' +
    'logged_in_at = "2026-05-23T12:00:00.000Z"\n';
  writeFileSync(credPath, body, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(credPath, 0o600);
}

/** Write the `.wft/project` marker (#595) linking `cwd` to a numeric id. */
function seedMarker(cwd: string, projectId: number): void {
  const wftDir = path.join(cwd, '.wft');
  mkdirSync(wftDir, { recursive: true });
  writeFileSync(
    path.join(wftDir, 'project'),
    `# Wood Fired Tasks linked-project marker.\n${projectId}\n`,
    'utf8',
  );
}

/** Pre-seed a FRESH per-project count cache entry (fetchedAt = now). */
function seedCountCache(
  cacheDir: string,
  projectKey: string,
  payload: { projectId: number; projectName: string; open: number; doneClosed: number },
): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, `count-${projectKey}.json`),
    JSON.stringify({ ...payload, fetchedAt: Date.now() }),
    'utf8',
  );
}

/** Pre-seed the update-available cache (#592) with the given availability. */
function seedUpdateCache(cacheDir: string, updateAvailable: boolean): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, 'update-check.json'),
    JSON.stringify({
      latestVersion: '9.9.9',
      currentVersion: '1.0.0',
      updateAvailable,
      fetchedAt: Date.now(),
    }),
    'utf8',
  );
}

describe('tasks statusline (subprocess)', () => {
  let server: StatuslineServer | null = null;
  let root: string;
  let configHome: string;
  let cacheDir: string;
  let workCwd: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wft-statusline-test-'));
    configHome = path.join(root, 'config');
    cacheDir = path.join(root, 'cache');
    workCwd = path.join(root, 'work');
    mkdirSync(configHome, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(workCwd, { recursive: true });
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  /** Base env for a case: auth + cache + API base wired to the tmpdirs. */
  function baseEnv(apiBaseUrl: string): Record<string, string> {
    return {
      XDG_CONFIG_HOME: configHome,
      WFT_CACHE_PATH: cacheDir,
      API_BASE_URL: apiBaseUrl,
    };
  }

  // AC: feeds stdin JSON and asserts the linked-project segment plus exit 0.
  it('linked project: renders the counts segment and exits 0', async () => {
    server = await startStatuslineServer({
      counts: { open: 3, done: 4, closed: 1 }, // doneClosed = 5
      projectId: PROJECT_ID,
      projectName: 'demo-project',
    });
    seedCredentials(configHome, server.baseUrl);
    seedMarker(workCwd, PROJECT_ID);

    const res = await runStatusline(
      JSON.stringify({ cwd: workCwd }),
      // Disable the update hint so the assertion isolates the counts segment.
      { ...baseEnv(server.baseUrl), WFT_NO_UPDATE_CHECK: '1' },
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('demo-project');
    expect(res.stdout).toContain('3 open');
    expect(res.stdout).toContain('5 done');

    // The CLI authenticated with the seeded Bearer PAT.
    const reqs = server.getRequests();
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs[0]!.authorization).toBe(`Bearer ${TEST_TOKEN}`);
  });

  // AC: blank stdout and exit 0 for the unlinked case.
  it('unlinked cwd (no marker, no project match): blank stdout, exit 0', async () => {
    server = await startStatuslineServer({ projectId: PROJECT_ID });
    seedCredentials(configHome, server.baseUrl);
    // No `.wft/project` marker. The repo-name rung lists projects from the
    // server; our server has no /projects list route, so resolution fails
    // gracefully → unlinked.

    const res = await runStatusline(JSON.stringify({ cwd: workCwd }), {
      ...baseEnv(server.baseUrl),
      WFT_NO_UPDATE_CHECK: '1',
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  // AC: no API hit when the cache is fresh.
  it('fresh count cache: renders from cache with ZERO API requests, exit 0', async () => {
    server = await startStatuslineServer({
      counts: { open: 999, done: 999, closed: 999 }, // would differ if hit
      projectId: PROJECT_ID,
      projectName: 'server-name-should-not-appear',
    });
    seedCredentials(configHome, server.baseUrl);
    seedMarker(workCwd, PROJECT_ID);
    // Fresh cache keyed by the numeric project id (cacheKeyFor → String(id)).
    seedCountCache(cacheDir, String(PROJECT_ID), {
      projectId: PROJECT_ID,
      projectName: 'cached-project',
      open: 2,
      doneClosed: 8,
    });

    const res = await runStatusline(JSON.stringify({ cwd: workCwd }), {
      ...baseEnv(server.baseUrl),
      WFT_NO_UPDATE_CHECK: '1',
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('cached-project');
    expect(res.stdout).toContain('2 open');
    expect(res.stdout).toContain('8 done');
    // The decisive assertion: a FRESH cache must not touch the network.
    expect(server.getRequests()).toHaveLength(0);
  });

  // AC: graceful exit 0 when the server is unreachable (no fresh cache).
  it('server unreachable on refresh: degrades to exit 0 (no crash)', async () => {
    // Stand up then immediately close a server to get an unbound URL.
    const ephemeral = await startStatuslineServer({ projectId: PROJECT_ID });
    const deadUrl = ephemeral.baseUrl;
    await ephemeral.close();

    seedCredentials(configHome, deadUrl);
    seedMarker(workCwd, PROJECT_ID);
    // No count cache → the render path must refresh, fail to connect, and
    // degrade to a blank counts segment without changing the exit code.

    const res = await runStatusline(
      JSON.stringify({ cwd: workCwd }),
      { ...baseEnv(deadUrl), WFT_NO_UPDATE_CHECK: '1' },
      13_000,
    );

    expect(res.exitCode).toBe(0);
    // Counts could not resolve → segment omitted (and the hint is disabled).
    expect(res.stdout.trim()).toBe('');
  });

  // AC: update-available hint appears when the update-check cache says available.
  it('update hint shows when the cache says an update is available', async () => {
    server = await startStatuslineServer({ projectId: PROJECT_ID });
    seedCredentials(configHome, server.baseUrl);
    // Unlinked cwd so only the update-hint segment is in play.
    seedUpdateCache(cacheDir, true);

    const res = await runStatusline(JSON.stringify({ cwd: workCwd }), {
      ...baseEnv(server.baseUrl),
      // Feature ON: env explicitly forces it on, overriding any config.
      WFT_NO_UPDATE_CHECK: '0',
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('/tasks:update');
  });

  // AC: update hint absent when disabled via WFT_NO_UPDATE_CHECK.
  it('update hint absent when disabled via WFT_NO_UPDATE_CHECK=1', async () => {
    server = await startStatuslineServer({ projectId: PROJECT_ID });
    seedCredentials(configHome, server.baseUrl);
    // Cache DOES say an update is available — only the env switch suppresses it.
    seedUpdateCache(cacheDir, true);

    const res = await runStatusline(JSON.stringify({ cwd: workCwd }), {
      ...baseEnv(server.baseUrl),
      WFT_NO_UPDATE_CHECK: '1',
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('/tasks:update');
    expect(res.stdout.trim()).toBe('');
  });
});
