/**
 * Test-only harness for booting a REAL, dockerized Helix Core (`p4d`) server
 * and provisioning `p4` client workspaces against it — support code for
 * `../perforce-real-p4d.test.ts` (task #1563).
 *
 * Nothing here is part of the production adapter. `PerforceBackend` (the code
 * under test) only ever spawns `p4` through `execScm` (`../../exec.ts`), which
 * inherits `process.env` for `P4PORT`/`P4USER`/`P4CLIENT`/`P4TICKETS`. This
 * module's job is everything a real operator would already have in place
 * *before* the adapter runs: a reachable server, a logged-in ticket, and a
 * client workspace. Where this harness itself needs to talk to `p4` (creating
 * workspaces, seeding baseline content, or acting as a second/concurrent
 * client to force a submit conflict) it uses `node:child_process.spawnSync`
 * directly — deliberately NOT `execScm` — since that traffic is test setup,
 * not the adapter surface under test.
 *
 * The `sourcegraph/helix-p4d` image ships a preconfigured `admin` /
 * `pass12349ers` superuser and exposes the server on container port 1666
 * (see the image's `docker inspect` output — `P4USER=admin`,
 * `P4PASSWD=pass12349ers`, `P4PORT=1666`). Those are passed explicitly on
 * `docker run` rather than relied on implicitly, so a future image update
 * that changes its defaults fails loudly (boot/login error) instead of
 * silently drifting.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';

/** Only known-good image for this harness — `perforce/helix-p4d` does not exist on Docker Hub (verified). */
const P4D_IMAGE = 'sourcegraph/helix-p4d:latest';
const P4D_ADMIN_USER = 'admin';
const P4D_ADMIN_PASSWORD = 'pass12349ers';
const READINESS_TIMEOUT_MS = 60_000;
const READINESS_POLL_INTERVAL_MS = 1_000;

/** True when `docker --version` runs successfully; `env` is injectable so the "docker missing" path is testable. */
export function dockerAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const res = spawnSync('docker', ['--version'], { env, timeout: 5_000, encoding: 'utf8' });
    return res.status === 0 && !res.error;
  } catch {
    return false;
  }
}

/** True when `p4 -V` runs successfully; `env` is injectable for the same reason as {@link dockerAvailable}. */
export function p4Available(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const res = spawnSync('p4', ['-V'], { env, timeout: 5_000, encoding: 'utf8' });
    return res.status === 0 && !res.error;
  } catch {
    return false;
  }
}

/** A booted, logged-in p4d server this process can drive. */
export interface P4dServer {
  /** Host port mapped to the container's 1666. */
  port: number;
  /** `docker` container id, for teardown. */
  containerId: string;
  /** `P4TICKETS` file already holding a valid `admin` ticket for this server. */
  ticketsFile: string;
}

/** A provisioned `p4` client workspace. */
export interface P4Workspace {
  name: string;
  root: string;
}

/** Ask the OS for a free TCP port by binding to port 0 and reading it back. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() =>
        port > 0 ? resolve(port) : reject(new Error('could not allocate a free port')),
      );
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Boot a fresh `sourcegraph/helix-p4d` container, wait for it to accept `p4
 * info`, then log the `admin` superuser in so its ticket is cached in a
 * fresh, per-boot `P4TICKETS` file. Throws on any failure (image pull,
 * container boot, readiness timeout, login) — callers that gate this behind
 * `WFG_TESTS_REAL_P4` should let that failure propagate out of `beforeAll`
 * rather than swallow it: the operator explicitly asked for the real suite.
 */
export async function bootP4d(): Promise<P4dServer> {
  const port = await getFreePort();
  const run = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '-p',
      `${port}:1666`,
      '-e',
      `P4USER=${P4D_ADMIN_USER}`,
      '-e',
      `P4PASSWD=${P4D_ADMIN_PASSWORD}`,
      P4D_IMAGE,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (run.status !== 0 || !run.stdout.trim()) {
    throw new Error(
      `bootP4d: \`docker run\` failed (exit ${run.status ?? 'null'}): ${run.stderr || run.stdout}`,
    );
  }
  const containerId = run.stdout.trim();
  const ticketsFile = `/tmp/wft-p4tickets-${containerId.slice(0, 12)}`;

  // Readiness is NOT "p4 info succeeds" — the image's init.sh accepts
  // connections before it has finished creating the `admin` user, so an
  // early `info` can succeed while `login` still fails with "User admin
  // doesn't exist." Poll on the login itself succeeding — that is the only
  // signal that server init AND user provisioning are both done.
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastFailure = '';
  let ready = false;
  while (Date.now() < deadline) {
    const login = spawnSync('p4', ['-p', `localhost:${port}`, '-u', P4D_ADMIN_USER, 'login'], {
      encoding: 'utf8',
      input: `${P4D_ADMIN_PASSWORD}\n`,
      env: { ...process.env, P4TICKETS: ticketsFile },
      timeout: 5_000,
    });
    if (login.status === 0) {
      ready = true;
      break;
    }
    lastFailure = login.stderr || login.stdout;
    await delay(READINESS_POLL_INTERVAL_MS);
  }
  if (!ready) {
    spawnSync('docker', ['stop', containerId], { timeout: 15_000 });
    throw new Error(
      `bootP4d: p4d on localhost:${port} did not become ready (admin login) within ${READINESS_TIMEOUT_MS}ms: ${lastFailure}`,
    );
  }

  return { port, containerId, ticketsFile };
}

/** Kill-safe teardown — best-effort, never throws (the container is `--rm` so `stop` also removes it). */
export function stopP4d(server: P4dServer): void {
  try {
    spawnSync('docker', ['stop', server.containerId], { timeout: 15_000 });
  } catch {
    // best-effort teardown — nothing more we can do from a test process.
  }
}

/**
 * The env overrides the ADAPTER (via `execScm` → `process.env`) needs to talk
 * to `server` as `workspace`. Callers save/restore `process.env` around the
 * window these are applied — `execScm` has no per-call env override, it only
 * ever inherits `process.env` (§6.1), so this is the sole channel.
 *
 * Includes `PWD`: the real `p4` client trusts `$PWD` (not just the process's
 * actual `getcwd()`) to resolve relative filespecs against a client's root —
 * confirmed empirically: a stale `PWD` inherited from the outer test-runner
 * shell makes `p4 reconcile <relative-path>` resolve against the WRONG
 * directory and fail with "Path ... is not under client's root ...", even
 * though `execScm` correctly `spawn()`s with `cwd: ctx.repo`. In normal CLI
 * usage this never surfaces (the process's actual `PWD` already matches
 * `ctx.repo`, since that's where the command was invoked from); the vitest
 * process here inherits an unrelated `PWD`, so this harness must correct it
 * explicitly whenever it points the adapter at a workspace.
 */
export function p4Env(server: P4dServer, workspace: P4Workspace): NodeJS.ProcessEnv {
  return {
    P4PORT: `localhost:${server.port}`,
    P4USER: P4D_ADMIN_USER,
    P4TICKETS: server.ticketsFile,
    P4CLIENT: workspace.name,
    PWD: workspace.root,
  };
}

/**
 * Create a `p4` client workspace named `name`, rooted at `root`, mapped
 * `//depot/... //<name>/...`. Uses `allwrite clobber` client options so a
 * plain `fs.writeFileSync` against an already-synced file is enough to make
 * it dirty for `p4 reconcile`/`p4 status` to discover — the exact allwrite
 * scenario `PerforceBackend.status()`'s doc comment (§3.5) describes, and
 * what lets this harness edit files without shelling out to `p4 edit` first.
 */
export function createWorkspace(server: P4dServer, name: string, root: string): P4Workspace {
  mkdirSync(root, { recursive: true });
  const workspace: P4Workspace = { name, root };
  const env = { ...process.env, ...p4Env(server, workspace) };

  const form = spawnSync('p4', ['client', '-o', name], { encoding: 'utf8', env, timeout: 10_000 });
  if (form.status !== 0) {
    throw new Error(
      `createWorkspace(${name}): \`p4 client -o\` failed: ${form.stderr || form.stdout}`,
    );
  }
  const rewritten = form.stdout
    .replace(/^Root:.*$/m, `Root: ${root}`)
    .replace(
      /^Options:.*$/m,
      'Options: allwrite clobber nocompress unlocked nomodtime normdir noaltsync',
    )
    .replace(/^View:[\s\S]*$/m, `View:\n\t//depot/... //${name}/...`);

  const create = spawnSync('p4', ['client', '-i'], {
    encoding: 'utf8',
    env,
    input: rewritten,
    timeout: 10_000,
  });
  if (create.status !== 0) {
    throw new Error(
      `createWorkspace(${name}): \`p4 client -i\` failed: ${create.stderr || create.stdout}`,
    );
  }
  return workspace;
}

/** Structured result of a harness-only, non-adapter `p4` invocation. */
export interface RawP4Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a `p4` command OUTSIDE the adapter under test — this harness acting as
 * an operator or a second, concurrent client. Never routes through
 * `execScm`; callers pass an explicit `env` (typically {@link p4Env} merged
 * onto `process.env`) rather than relying on ambient state.
 */
export function rawP4(
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): RawP4Result {
  const res = spawnSync('p4', args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}
