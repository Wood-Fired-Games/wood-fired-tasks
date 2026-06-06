/**
 * End-to-end CLI tests against a real HTTP server and the real CLI binary.
 *
 * Most CLI tests in this directory mock out the API client so they exercise
 * only the Commander wiring. Task #208 closes that gap by spawning the
 * actual CLI as a child process and pointing it at a `createServer` instance
 * that is bound to an ephemeral loopback port.
 *
 * - Server uses `:memory:` SQLite so no on-disk state leaks between runs.
 * - Each CLI invocation runs in `--json` mode, parses stdout, asserts the
 *   JSON envelope shape, and asserts exit code 0.
 * - One negative path uses a bogus Bearer token and asserts the CLI exits
 *   with `CliExitCodes.GENERAL_ERROR` (1) per `src/utils/exit-codes.ts`.
 *
 * The CLI is invoked via `node` with `tsx/cli` as the loader so we do not
 * depend on `dist/` being built. `tsx` ships in devDependencies.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../index.js';
import { seedAuth } from '../../api/__tests__/helpers/auth.js';

// v2.0 cutover (#799/#800/#802): the X-API-Key strategy and the API_KEYS
// config field were removed server-side, and the CLI is now Bearer-PAT-only —
// it no longer reads the legacy `API_KEY` env var. The CLI authenticates
// exclusively via the on-disk credentials file (a Bearer PAT), so this e2e
// test seeds a real PAT on the server and points the child CLI at a
// credentials file via WFT_CREDENTIALS_PATH (written per-spawn below).
// Suppress noisy server logs in test output. `fatal` is the highest pino
// level so request logging is silenced; the schema rejects `silent`.
process.env.LOG_LEVEL = 'fatal';
// Disable swagger UI in tests to avoid the per-route emit logging.
process.env.NODE_ENV = 'test';

// Import after env is set so the lazy config proxy sees our API_KEYS.
const { createServer } = await import('../../api/server.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const cliEntry = path.join(repoRoot, 'src/cli/bin/tasks.ts');

// Resolve `tsx/cli` from the worktree root so we always pick up the
// devDependency rather than any globally installed copy. Using `node` +
// `tsx/cli` avoids any dependency on `dist/` being built ahead of time.
const requireFromHere = createRequire(import.meta.url);
const tsxCli = requireFromHere.resolve('tsx/cli', { paths: [repoRoot] });

// Per-suite temp dir holding the per-spawn credentials files. Created in
// beforeAll, removed in afterAll.
const credsDir = mkdtempSync(path.join(tmpdir(), 'wft-e2e-creds-'));

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Write a minimal Bearer-PAT credentials TOML file the child CLI can read via
 * WFT_CREDENTIALS_PATH. The CLI's `resolveAuth` only reads `active.token` (and
 * `readCredentials` validates the full shape), so we supply a schema-valid
 * envelope. Mode 0o600 is required — `readCredentials` refuses group/other
 * bits.
 */
function writeCredsFile(filePath: string, token: string, server: string): void {
  const body =
    '# e2e test credentials\n' +
    '[active]\n' +
    `token = ${JSON.stringify(token)}\n` +
    'token_id = 1\n' +
    `server = ${JSON.stringify(server)}\n` +
    'user_id = 1\n' +
    'display_name = "e2e-test-user"\n' +
    'logged_in_at = "2026-01-01T00:00:00.000Z"\n';
  writeFileSync(filePath, body, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

/**
 * Spawn the real CLI binary as a child process.
 *
 * - `args` is appended verbatim after the `tasks.ts` entry.
 * - The child inherits the parent env, then overrides `API_BASE_URL` and
 *   points `WFT_CREDENTIALS_PATH` at a per-spawn credentials file carrying
 *   `token` as the Bearer PAT (v2.0: the CLI is Bearer-PAT-only; `API_KEY`
 *   env is no longer consulted).
 * - stdout/stderr are captured to strings; exit code is returned. A hard
 *   10s wall-clock timeout guards against hangs.
 */
function runCli(
  args: string[],
  env: Record<string, string>,
  baseUrl: string,
  token: string,
): Promise<RunResult> {
  const credsPath = path.join(credsDir, `creds-${Math.random().toString(36).slice(2)}.toml`);
  writeCredsFile(credsPath, token, baseUrl);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
      env: {
        ...process.env,
        ...env,
        API_BASE_URL: baseUrl,
        // v2.0: authenticate via the on-disk credentials file (Bearer PAT).
        WFT_CREDENTIALS_PATH: credsPath,
        // Force non-TTY so the spinner/prompt code paths stay quiet and
        // the JSON envelope is the only thing on stdout.
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
      reject(new Error(`CLI did not exit within 10s for args=${args.join(' ')}`));
    }, 10_000);

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
 * Pull the first JSON object out of stdout. The CLI's `jsonOutput` writes a
 * single pretty-printed envelope followed by `\n`. We tolerate any trailing
 * whitespace.
 */
function parseJsonEnvelope(stdout: string): {
  success: boolean;
  data: unknown;
  metadata?: Record<string, unknown>;
} {
  const trimmed = stdout.trim();
  // Defensive: if the spinner ever leaks output ahead of the envelope,
  // locate the first `{` and parse from there.
  const start = trimmed.indexOf('{');
  if (start < 0) {
    throw new Error(`No JSON object in stdout: ${JSON.stringify(stdout)}`);
  }
  return JSON.parse(trimmed.slice(start));
}

describe('CLI end-to-end (real binary, real server)', () => {
  let server: FastifyInstance;
  let app: App;
  let baseUrl: string;
  let projectId: number;
  // Raw Bearer PAT seeded against the server's DB; used for every happy-path
  // CLI invocation. The negative-path test passes a bogus token instead.
  let TEST_TOKEN: string;

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    // v2.0: seed a real PAT and authenticate the CLI via Bearer.
    TEST_TOKEN = seedAuth(app.db).token;
    // Bind to an ephemeral loopback port — the kernel assigns a free port,
    // so two parallel test files (if `fileParallelism` is ever re-enabled)
    // won't collide. With the current vitest.config.ts the test suite is
    // serial, which keeps this test hermetic regardless.
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    // Fastify v5 returns the bound address string when the listen promise
    // resolves; e.g. "http://127.0.0.1:43219".
    baseUrl = address;
  }, 30_000);

  afterAll(async () => {
    await server.close();
    app.dispose();
    rmSync(credsDir, { recursive: true, force: true });
  });

  it('project-create returns a JSON envelope with an id', async () => {
    const res = await runCli(
      ['--json', 'project-create', '--name', 'e2e-test'],
      {},
      baseUrl,
      TEST_TOKEN,
    );
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    expect(env.success).toBe(true);
    expect(env.metadata?.id).toEqual(expect.any(Number));
    projectId = env.metadata!.id as number;
    expect(projectId).toBeGreaterThan(0);
  });

  it('project-list returns an array of projects', async () => {
    const res = await runCli(['--json', 'project-list'], {}, baseUrl, TEST_TOKEN);
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    expect(env.success).toBe(true);
    expect(Array.isArray(env.data)).toBe(true);
    expect((env.data as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('project-show returns the requested project', async () => {
    const res = await runCli(
      ['--json', 'project-show', String(projectId)],
      {},
      baseUrl,
      TEST_TOKEN,
    );
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    expect(env.success).toBe(true);
    const project = (env.data as { project: { id: number; name: string } }).project;
    expect(project.id).toBe(projectId);
    expect(project.name).toBe('e2e-test');
  });

  let createdTaskId: number;

  it('create returns a task with an id', async () => {
    const res = await runCli(
      [
        '--json',
        'create',
        '--title',
        'e2e task',
        '--project',
        String(projectId),
        '--created-by',
        'e2e-user',
        '--priority',
        'high',
      ],
      {},
      baseUrl,
      TEST_TOKEN,
    );
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    expect(env.success).toBe(true);
    const task = (env.data as { task: { id: number; title: string; priority: string } }).task;
    expect(task.id).toEqual(expect.any(Number));
    expect(task.title).toBe('e2e task');
    expect(task.priority).toBe('high');
    createdTaskId = task.id;
  });

  it('list returns the freshly-created task', async () => {
    const res = await runCli(
      ['--json', 'list', '--project', String(projectId)],
      {},
      baseUrl,
      TEST_TOKEN,
    );
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    expect(env.success).toBe(true);
    expect(Array.isArray(env.data)).toBe(true);
    const ids = (env.data as Array<{ id: number }>).map((t) => t.id);
    expect(ids).toContain(createdTaskId);
  });

  it('list --search filters by query (search/my-work surrogate)', async () => {
    const res = await runCli(['--json', 'list', '--search', 'e2e task'], {}, baseUrl, TEST_TOKEN);
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    expect(env.success).toBe(true);
    const matches = (env.data as Array<{ id: number; title: string }>).filter(
      (t) => t.id === createdTaskId,
    );
    expect(matches.length).toBe(1);
  });

  it('show returns full task detail by id', async () => {
    const res = await runCli(['--json', 'show', String(createdTaskId)], {}, baseUrl, TEST_TOKEN);
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    expect(env.success).toBe(true);
    const task = (env.data as { task: { id: number; status: string } }).task;
    expect(task.id).toBe(createdTaskId);
    expect(['open', 'in_progress']).toContain(task.status);
  });

  it('claim atomically assigns the task and flips status', async () => {
    const res = await runCli(
      ['--json', 'claim', String(createdTaskId), '--assignee', 'e2e-bot'],
      {},
      baseUrl,
      TEST_TOKEN,
    );
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    expect(env.success).toBe(true);
    const task = (env.data as { task: { id: number; assignee: string; status: string } }).task;
    expect(task.id).toBe(createdTaskId);
    expect(task.assignee).toBe('e2e-bot');
    expect(task.status).toBe('in_progress');
  });

  it('update transitions a task to done (done surrogate)', async () => {
    const res = await runCli(
      ['--json', 'update', String(createdTaskId), '--status', 'done'],
      {},
      baseUrl,
      TEST_TOKEN,
    );
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    expect(env.success).toBe(true);
    const task = (env.data as { task: { id: number; status: string } }).task;
    expect(task.id).toBe(createdTaskId);
    expect(task.status).toBe('done');
  });

  it('comment-add attaches a comment to the task', async () => {
    const res = await runCli(
      [
        '--json',
        'comment-add',
        String(createdTaskId),
        '--author',
        'e2e-bot',
        '--content',
        'looks good',
      ],
      {},
      baseUrl,
      TEST_TOKEN,
    );
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    expect(env.success).toBe(true);
    const comment = (env.data as { comment: { id: number; content: string } }).comment;
    expect(comment.id).toEqual(expect.any(Number));
    expect(comment.content).toBe('looks good');
  });

  it('comment-list returns the comments for the task', async () => {
    const res = await runCli(
      ['--json', 'comment-list', String(createdTaskId)],
      {},
      baseUrl,
      TEST_TOKEN,
    );
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    expect(env.success).toBe(true);
    expect(Array.isArray(env.data)).toBe(true);
    const contents = (env.data as Array<{ content: string }>).map((c) => c.content);
    expect(contents).toContain('looks good');
  });

  it('dep-add + dep-list wire one task to block another', async () => {
    // Create a second task to wire as the blocker. (`createdTaskId` is now
    // `done`, but the dependency API only cares about row presence, not
    // status, so this is fine.)
    const addRes = await runCli(
      [
        '--json',
        'create',
        '--title',
        'blocker',
        '--project',
        String(projectId),
        '--created-by',
        'e2e-user',
      ],
      {},
      baseUrl,
      TEST_TOKEN,
    );
    expect(addRes.exitCode).toBe(0);
    const blockerId = (parseJsonEnvelope(addRes.stdout).data as { task: { id: number } }).task.id;

    const depAdd = await runCli(
      ['--json', 'dep-add', String(blockerId), String(createdTaskId)],
      {},
      baseUrl,
      TEST_TOKEN,
    );
    expect(depAdd.exitCode).toBe(0);
    const addEnv = parseJsonEnvelope(depAdd.stdout);
    expect(addEnv.success).toBe(true);

    const depList = await runCli(
      ['--json', 'dep-list', String(blockerId)],
      {},
      baseUrl,
      TEST_TOKEN,
    );
    expect(depList.exitCode).toBe(0);
    const listEnv = parseJsonEnvelope(depList.stdout);
    expect(listEnv.success).toBe(true);
    // dep-list emits `{ blocks: [...], blocked_by: [...] }`. Whatever the
    // exact shape, the blocker should appear somewhere.
    const serialized = JSON.stringify(listEnv.data);
    expect(serialized).toContain(String(createdTaskId));
  });

  it('health returns the public health envelope', async () => {
    const res = await runCli(['--json', 'health'], {}, baseUrl, TEST_TOKEN);
    expect(res.exitCode).toBe(0);
    const env = parseJsonEnvelope(res.stdout);
    // health command writes `jsonOutput(health)` — `data` IS the health
    // payload (no envelope nesting).
    expect(env.success).toBe(true);
    expect((env.data as { status: string }).status).toBe('healthy');
  });

  // ── Failure path ────────────────────────────────────────────
  it('exits with CliExitCodes.GENERAL_ERROR (1) when the Bearer token is wrong', async () => {
    const res = await runCli(
      ['--json', 'list', '--project', String(projectId)],
      {},
      baseUrl,
      'this-key-is-not-registered-on-the-server',
    );
    // CLI surfaces ApiClientError → handleError → exitCode=1.
    expect(res.exitCode).toBe(1);
    // The CLI should NOT have written a success envelope to stdout. It
    // logs to stderr instead.
    expect(res.stderr).toMatch(/401|Unauthorized|Error/i);
  });
});
