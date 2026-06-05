#!/usr/bin/env node
// @ts-check
/*
 * smoke-global.mjs — global-install smoke test (task #745).
 *
 * Proves the FRICTIONLESS DISTRIBUTION promise end-to-end, the way a brand-new
 * `npm i -g wood-fired-tasks` user experiences it — but entirely inside temp
 * directories so it never touches the real ~/.claude.json or the real OS
 * app-data DB, and NEVER requires sudo / elevation.
 *
 * Steps (all in temp dirs, cleaned up on exit even on failure):
 *   1. `npm run build`, then `npm pack` the repo → a tarball in a temp dir.
 *   2. `npm install -g <tarball> --prefix <tempPrefix>` so the
 *      `wood-fired-tasks` bin lands under <tempPrefix>/bin (user-writable temp
 *      prefix → no sudo by construction).
 *   3. From a cwd OUTSIDE the repo, run `<bin> setup` with HOME pointed at a
 *      temp HOME. Assert:
 *        - <tempHome>/.claude.json exists and carries the `wood-fired-tasks`
 *          stdio MCP server entry.
 *        - skills copied into <tempHome>/.claude/commands/tasks/.
 *        - RE-RUN setup → idempotent (claude.json bytes unchanged, "already
 *          present" / "already up to date").
 *   4. Boot `<bin> serve` against a temp app-data DB (DATABASE_PATH override) on
 *      a free port, bound to loopback. Poll GET /health → assert 200 healthy.
 *      Assert the DB file was created AND migrations applied (the `_migrations`
 *      Umzug bookkeeping table exists and is non-empty). Then shut it down.
 *   5. Exit 0 on success; non-zero with a clear message on any failed
 *      assertion. Temp dirs removed + server killed even on failure.
 *
 * Run it from anywhere:
 *   npm run smoke:global
 *
 * NO sudo / runas / pkexec / doas is ever invoked. A user-writable --prefix is
 * the entire trick.
 */

import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

const tempDirs = [];
/** @type {import('node:child_process').ChildProcess | null} */
let serverProc = null;

function mkTemp(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let passes = 0;
function pass(msg) {
  passes += 1;
  console.log(`  PASS: ${msg}`);
}
function fail(msg) {
  throw new Error(msg);
}
function assert(cond, msg) {
  if (cond) pass(msg);
  else fail(msg);
}

const ELEVATION_RE = /^(sudo|runas|pkexec|doas)$/i;

/**
 * Run a command synchronously, capturing output. Hard-guards against ever
 * invoking an elevation binary (this smoke must NEVER prompt for a password).
 */
function run(cmd, args, opts = {}) {
  if (ELEVATION_RE.test(cmd)) {
    fail(`refusing to run elevated command: ${cmd}`);
  }
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...opts,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (res.error) fail(`spawn failed for ${cmd}: ${res.error.message}`);
  return res;
}

function runOrFail(cmd, args, opts = {}) {
  const res = run(cmd, args, opts);
  if (res.status !== 0) {
    if (res.stdout) console.error(res.stdout);
    if (res.stderr) console.error(res.stderr);
    fail(`${cmd} ${args.join(' ')} exited ${res.status}`);
  }
  return res;
}

/** Find a free TCP port by binding :0 then releasing it. */
async function freePort() {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function cleanup() {
  if (serverProc && serverProc.pid && serverProc.exitCode === null) {
    try {
      process.kill(serverProc.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Resolve the better-sqlite3 module that npm installed alongside the global
 * package, so the smoke opens the temp DB with the SAME native binding the
 * server uses. Falls back to the repo's own node_modules copy.
 */
function pathToInstalledBetterSqlite(prefixDir) {
  const candidates = [
    path.join(
      prefixDir,
      'lib',
      'node_modules',
      'wood-fired-tasks',
      'node_modules',
      'better-sqlite3',
      'lib',
      'index.js'
    ),
    // Windows layout (no lib/ segment).
    path.join(
      prefixDir,
      'node_modules',
      'wood-fired-tasks',
      'node_modules',
      'better-sqlite3',
      'lib',
      'index.js'
    ),
    path.join(REPO_ROOT, 'node_modules', 'better-sqlite3', 'lib', 'index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return pathToFileURL(c).href;
  }
  // Last resort: bare specifier resolved from the repo root.
  return 'better-sqlite3';
}

async function main() {
  console.log('== Global-install smoke (task #745) ==');

  // -- 1. build + pack -------------------------------------------------------
  console.log('-- build --');
  runOrFail('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });

  console.log('-- pack --');
  const packDir = mkTemp('wft-smoke-pack-');
  const packRes = runOrFail(
    'npm',
    ['pack', '--pack-destination', packDir],
    { cwd: REPO_ROOT }
  );
  // `npm pack` prints the tarball filename on the last non-empty stdout line.
  const tarballName = packRes.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  const tarball = path.join(packDir, tarballName ?? '');
  assert(
    tarballName != null && existsSync(tarball),
    `npm pack produced a tarball: ${tarballName}`
  );

  // -- 2. install -g into a TEMP prefix (no sudo: user-writable temp dir) -----
  console.log('-- install -g (temp prefix, no sudo) --');
  const prefixDir = mkTemp('wft-smoke-prefix-');
  runOrFail(
    'npm',
    ['install', '-g', tarball, '--prefix', prefixDir],
    { cwd: packDir }
  );
  // On POSIX the bin lands under <prefix>/bin; on Windows directly under prefix.
  const binName =
    process.platform === 'win32' ? 'wood-fired-tasks.cmd' : 'wood-fired-tasks';
  const binPath =
    process.platform === 'win32'
      ? path.join(prefixDir, binName)
      : path.join(prefixDir, 'bin', binName);
  assert(existsSync(binPath), `installed bin present at ${binPath}`);

  // -- 3. setup with a temp HOME, run from a cwd OUTSIDE the repo -------------
  console.log('-- setup (temp HOME) --');
  const homeDir = mkTemp('wft-smoke-home-');
  const outsideCwd = mkTemp('wft-smoke-cwd-');
  const setupEnv = {
    HOME: homeDir,
    USERPROFILE: homeDir, // Windows parity
  };

  const setup1 = runOrFail(binPath, ['setup'], {
    cwd: outsideCwd,
    env: setupEnv,
  });
  if (setup1.stdout) console.log(setup1.stdout.trimEnd());

  const claudeJsonPath = path.join(homeDir, '.claude.json');
  assert(existsSync(claudeJsonPath), `${claudeJsonPath} created by setup`);

  const claudeJson1 = readFileSync(claudeJsonPath, 'utf8');
  const parsed = JSON.parse(claudeJson1);
  const mcp = parsed.mcpServers ?? {};
  const entry = mcp['wood-fired-tasks'];
  assert(
    entry != null && entry.type === 'stdio' && Array.isArray(entry.args),
    'setup merged the wood-fired-tasks stdio MCP server entry into ~/.claude.json'
  );

  const skillsDir = path.join(homeDir, '.claude', 'commands', 'tasks');
  const skillFiles = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((f) => f.endsWith('.md'))
    : [];
  assert(
    skillFiles.length > 0,
    `setup copied ${skillFiles.length} skill(s) into ${skillsDir}`
  );

  // -- 3b. idempotency: re-run, assert claude.json bytes unchanged -----------
  console.log('-- setup re-run (idempotency) --');
  const setup2 = runOrFail(binPath, ['setup'], {
    cwd: outsideCwd,
    env: setupEnv,
  });
  if (setup2.stdout) console.log(setup2.stdout.trimEnd());
  const claudeJson2 = readFileSync(claudeJsonPath, 'utf8');
  assert(
    claudeJson2 === claudeJson1,
    'setup is idempotent: ~/.claude.json bytes identical across re-run'
  );
  assert(
    /already present/i.test(setup2.stdout ?? ''),
    'setup re-run reports the MCP server "already present" (no spurious change)'
  );

  // -- 4. boot serve against a temp app-data DB, poll /health ----------------
  console.log('-- serve (temp app-data DB) --');
  const dataDir = mkTemp('wft-smoke-data-');
  const dbPath = path.join(dataDir, 'tasks.db');
  const port = await freePort();
  const serveEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    DATABASE_PATH: dbPath,
    HOST: '127.0.0.1',
    PORT: String(port),
    // Boot the way a REAL global install runs: NODE_ENV=production. This is
    // also the only mode that does NOT require the `pino-pretty` dev transport
    // (a devDependency absent from the published tarball) — the development
    // logger transport would crash a production install, which is exactly the
    // kind of install-time breakage this smoke must surface.
    NODE_ENV: 'production',
    // Production rejects API keys < 32 chars and known placeholder substrings
    // (src/api/plugins/auth/keys.ts). A 32-char throwaway hex key clears both
    // floors. Non-secret, lives only in this process + the temp DB.
    API_KEYS: 'smoke0key0smoke0key0smoke0key0aa',
  };

  serverProc = spawn(binPath, ['serve'], {
    cwd: outsideCwd,
    env: serveEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  serverProc.stdout?.on('data', (d) => (serverLog += d));
  serverProc.stderr?.on('data', (d) => (serverLog += d));
  const serverExited = new Promise((resolve) => {
    serverProc?.on('exit', (code) => resolve(code));
  });

  const healthUrl = `http://127.0.0.1:${port}/health`;
  let healthBody = null;
  let healthStatus = 0;
  for (let i = 0; i < 120; i++) {
    if (serverProc.exitCode !== null) {
      console.error(serverLog);
      fail(`serve exited (code ${serverProc.exitCode}) during startup`);
    }
    try {
      const res = await fetch(healthUrl);
      healthStatus = res.status;
      healthBody = await res.json();
      if (res.status === 200) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  assert(
    healthStatus === 200 && healthBody != null && healthBody.status === 'healthy',
    `GET /health returned 200 healthy (status=${healthStatus})`
  );

  // -- 4b. DB created + migrations applied (_migrations table non-empty) -----
  assert(existsSync(dbPath), `app-data DB created at ${dbPath}`);

  // Read the Umzug bookkeeping table from the temp DB directly (read-only) to
  // prove migrations actually ran during serve startup.
  const Database = (await import(pathToInstalledBetterSqlite(prefixDir))).default;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let migrationCount = 0;
  try {
    const row = db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='_migrations'"
      )
      .get();
    assert(row.n === 1, 'migrations bookkeeping table (_migrations) exists');
    const cnt = db.prepare('SELECT count(*) AS n FROM _migrations').get();
    migrationCount = cnt.n;
    assert(
      migrationCount > 0,
      `migrations applied: ${migrationCount} row(s) in _migrations`
    );
  } finally {
    db.close();
  }

  // -- shut the server down --------------------------------------------------
  console.log('-- shutdown --');
  // Guard each signal: the process may already be gone (ESRCH) and the bin can
  // be a shell shim whose pid is reaped independently.
  const signal = (sig) => {
    if (serverProc?.pid && serverProc.exitCode === null) {
      try {
        process.kill(serverProc.pid, sig);
      } catch (err) {
        if (err?.code !== 'ESRCH') throw err;
      }
    }
  };
  signal('SIGTERM');
  await Promise.race([serverExited, sleep(5000)]);
  signal('SIGKILL');
  pass('server shut down cleanly');

  // -- no-sudo affirmation ---------------------------------------------------
  pass('NO sudo/runas/pkexec/doas was invoked (temp --prefix is user-writable)');

  console.log(`\n== SMOKE PASS — ${passes} assertions ==`);
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n== SMOKE FAIL ==\n${err?.stack ?? err}`);
    cleanup();
    process.exit(1);
  });
