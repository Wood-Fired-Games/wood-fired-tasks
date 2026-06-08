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
/** @type {import('node:http').Server | null} — local /api/v1/me stub (SMOKE_REMOTE). */
let meServer = null;

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

// npm is a bare name on POSIX but the `npm.cmd` shim on Windows, and the
// globally-installed `wood-fired-tasks` bin is likewise a `.cmd` wrapper on
// Windows. Node ≥20 refuses to spawn a `.cmd`/`.bat` directly without a shell
// (EINVAL, the CVE-2024-27980 hardening), and a bare `npm` can't be resolved by
// spawnSync (PATHEXT isn't applied to argv[0]). Routing through a shell on
// Windows resolves both: cmd.exe finds the .cmd shim, and Node auto-quotes args
// (default windowsVerbatimArguments=false) so temp paths with spaces survive.
const NPM = 'npm';
const IS_WIN = process.platform === 'win32';

// On Windows, a shell is required for the bare npm wrapper and for any command
// that IS a .cmd/.bat batch file (the installed bin). POSIX never needs it.
function needsWindowsShell(cmd) {
  if (!IS_WIN) return false;
  return cmd === NPM || /\.(cmd|bat)$/i.test(cmd);
}

/**
 * Run a command synchronously, capturing output. Hard-guards against ever
 * invoking an elevation binary (this smoke must NEVER prompt for a password).
 */
function run(cmd, args, opts = {}) {
  if (ELEVATION_RE.test(cmd)) {
    fail(`refusing to run elevated command: ${cmd}`);
  }
  const useShell = needsWindowsShell(cmd);
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: useShell,
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

/**
 * Async variant of {@link run}. Required when the command must talk to an
 * in-process HTTP server: `spawnSync` blocks the event loop, so a Node server
 * listening in THIS process can't accept the child's connection until the child
 * has already exited. `spawn` keeps the loop free to serve it. Resolves
 * `{ status, stdout, stderr }`; never rejects (spawn errors call `fail`).
 */
function runAsync(cmd, args, opts = {}) {
  if (ELEVATION_RE.test(cmd)) {
    fail(`refusing to run elevated command: ${cmd}`);
  }
  const useShell = needsWindowsShell(cmd);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: useShell,
      ...opts,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => fail(`spawn failed for ${cmd}: ${err.message}`));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
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
  if (meServer) {
    try {
      meServer.close();
    } catch {
      /* already closed */
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
      'index.js',
    ),
    // Windows layout (no lib/ segment).
    path.join(
      prefixDir,
      'node_modules',
      'wood-fired-tasks',
      'node_modules',
      'better-sqlite3',
      'lib',
      'index.js',
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
  runOrFail(NPM, ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });

  console.log('-- pack --');
  const packDir = mkTemp('wft-smoke-pack-');
  const packRes = runOrFail(NPM, ['pack', '--pack-destination', packDir], {
    cwd: REPO_ROOT,
  });
  // `npm pack` prints the tarball filename on the last non-empty stdout line.
  const tarballName = packRes.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  const tarball = path.join(packDir, tarballName ?? '');
  assert(tarballName != null && existsSync(tarball), `npm pack produced a tarball: ${tarballName}`);

  // -- 2. install -g into a TEMP prefix (no sudo: user-writable temp dir) -----
  console.log('-- install -g (temp prefix, no sudo) --');
  const prefixDir = mkTemp('wft-smoke-prefix-');
  runOrFail(NPM, ['install', '-g', tarball, '--prefix', prefixDir], {
    cwd: packDir,
  });
  // On POSIX the bin lands under <prefix>/bin; on Windows directly under prefix.
  const binName = process.platform === 'win32' ? 'wood-fired-tasks.cmd' : 'wood-fired-tasks';
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
    'setup merged the wood-fired-tasks stdio MCP server entry into ~/.claude.json',
  );

  const skillsDir = path.join(homeDir, '.claude', 'commands', 'tasks');
  const skillFiles = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((f) => f.endsWith('.md'))
    : [];
  assert(skillFiles.length > 0, `setup copied ${skillFiles.length} skill(s) into ${skillsDir}`);

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
    'setup is idempotent: ~/.claude.json bytes identical across re-run',
  );
  assert(
    /already present/i.test(setup2.stdout ?? ''),
    'setup re-run reports the MCP server "already present" (no spurious change)',
  );

  // -- 3c. docs command works from OUTSIDE the repo (task #750) --------------
  // The bundled guides resolve from the PACKAGE ROOT via the #730 asset
  // resolver, not cwd — so `docs list` / `docs show` must work from the
  // outside-the-repo cwd with the temp HOME. No sudo: pure stdout reads.
  console.log('-- docs list / docs show (from outside the repo) --');
  const docsList = runOrFail(binPath, ['docs', 'list'], {
    cwd: outsideCwd,
    env: setupEnv,
  });
  const docsListOut = docsList.stdout ?? '';
  assert(
    /(^|\s)usage-patterns(\s|$)/m.test(docsListOut) &&
      /(^|\s)setup(\s|$)/m.test(docsListOut) &&
      /(^|\s)cli(\s|$)/m.test(docsListOut),
    'docs list enumerates the curated guides (usage-patterns, setup, cli)',
  );

  const docsShow = runOrFail(binPath, ['docs', 'show', 'usage-patterns'], {
    cwd: outsideCwd,
    env: setupEnv,
  });
  const docsShowOut = docsShow.stdout ?? '';
  assert(
    docsShowOut.trim().length > 0 && /^#/m.test(docsShowOut),
    'docs show usage-patterns prints real guide content (non-empty, has a heading)',
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
    // Same Windows .cmd-spawn constraint as run(): the installed bin is a
    // batch shim, which Node ≥20 won't spawn without a shell.
    shell: needsWindowsShell(binPath),
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
    `GET /health returned 200 healthy (status=${healthStatus})`,
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
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .get();
    assert(row.n === 1, 'migrations bookkeeping table (_migrations) exists');
    const cnt = db.prepare('SELECT count(*) AS n FROM _migrations').get();
    migrationCount = cnt.n;
    assert(migrationCount > 0, `migrations applied: ${migrationCount} row(s) in _migrations`);
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

  // -- 5. OPT-IN: setup --remote --token persists a real credential ----------
  // Gated behind SMOKE_REMOTE=1 so default behaviour is unchanged (backward
  // compatible). The cross-OS CI matrix sets SMOKE_REMOTE=1 so the one thing
  // the base smoke does NOT cover — that `setup --remote <url> --token <pat>`
  // writes the URL-only `wood-fired-tasks-remote` MCP entry AND persists the
  // validated PAT to the credentials file — is exercised on every leg without a
  // separate, driftable shell step.
  //
  // #858: the `--token` path now validates the PAT against `GET /api/v1/me` and
  // writes it to the credentials file (the bridge's single source of truth) —
  // it no longer writes an orphaned `remote-token` cache that nothing reads. So
  // this smoke stands up a tiny local /api/v1/me stub and asserts the credential
  // actually lands where the CLI + bridge read it.
  if (process.env.SMOKE_REMOTE === '1') {
    console.log('-- setup --remote --token (temp HOME, local /api/v1/me) --');
    const remoteHome = mkTemp('wft-smoke-remote-home-');
    const remoteCwd = mkTemp('wft-smoke-remote-cwd-');
    // 32-char throwaway PAT: non-secret, lives only in the temp HOME + config.
    const remotePat = 'smoke0pat0smoke0pat0smoke0pat0aa';

    // Local identity server: persistManualPat GETs <baseUrl>/api/v1/me with a
    // Bearer header before writing credentials. Return an identity for the
    // matching PAT; 401 otherwise.
    const http = await import('node:http');
    const mePort = await freePort();
    meServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/v1/me') {
        if (req.headers.authorization === `Bearer ${remotePat}`) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 4242,
              displayName: 'Smoke User',
              email: 'smoke@example.invalid',
              isLegacy: false,
              isServiceAccount: false,
            }),
          );
          return;
        }
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => meServer.listen(mePort, '127.0.0.1', resolve));
    const remoteUrl = `http://127.0.0.1:${mePort}`;

    const remoteEnv = {
      HOME: remoteHome,
      USERPROFILE: remoteHome, // Windows parity
      // Keep the OS config dir (and thus the credentials file) inside the temp
      // HOME on every platform so the PAT never lands in the runner's real tree.
      XDG_CONFIG_HOME: path.join(remoteHome, '.config'),
      LOCALAPPDATA: path.join(remoteHome, 'AppData', 'Local'),
      APPDATA: path.join(remoteHome, 'AppData', 'Roaming'),
    };

    // Run async (NOT runOrFail/spawnSync): the child's persistManualPat fetch
    // hits our in-process /api/v1/me, which can only be served while this
    // process's event loop is free — spawnSync would deadlock it.
    const remoteSetup = await runAsync(
      binPath,
      ['setup', '--remote', remoteUrl, '--token', remotePat],
      { cwd: remoteCwd, env: remoteEnv },
    );
    if (remoteSetup.stdout) console.log(remoteSetup.stdout.trimEnd());
    if (remoteSetup.status !== 0) {
      if (remoteSetup.stderr) console.error(remoteSetup.stderr);
      fail(`setup --remote --token exited ${remoteSetup.status}`);
    }

    meServer.close();
    meServer = null;

    const remoteClaudeJsonPath = path.join(remoteHome, '.claude.json');
    assert(existsSync(remoteClaudeJsonPath), `${remoteClaudeJsonPath} created by setup --remote`);
    const remoteParsed = JSON.parse(readFileSync(remoteClaudeJsonPath, 'utf8'));
    const remoteMcp = remoteParsed.mcpServers ?? {};
    const remoteEntry = remoteMcp['wood-fired-tasks-remote'];
    assert(
      remoteEntry != null && remoteEntry.type === 'stdio',
      "setup --remote wrote the 'wood-fired-tasks-remote' stdio MCP entry",
    );
    const remoteEntryEnv = remoteEntry?.env ?? {};
    assert(
      remoteEntryEnv.WFT_API_URL === remoteUrl,
      `remote entry carries WFT_API_URL=${remoteUrl}`,
    );
    // #810 security contract: the PAT is NEVER persisted into claude.json. The
    // entry is URL-only; the bridge resolves the bearer token at runtime from
    // the credentials file written below.
    assert(
      remoteEntryEnv.WFT_API_KEY === undefined,
      'remote entry is URL-only (no WFT_API_KEY persisted in claude.json, #810)',
    );
    // #858: the validated PAT is persisted to the CLI credentials file — the
    // SAME file `tasks login` writes and the remote bridge reads. With
    // XDG_CONFIG_HOME rooted in the temp HOME, that resolves deterministically.
    const credPath = path.join(remoteHome, '.config', 'wood-fired-tasks', 'credentials');
    assert(existsSync(credPath), `setup --remote --token wrote the credentials file ${credPath}`);
    const credBody = readFileSync(credPath, 'utf8');
    assert(
      credBody.includes(remotePat),
      'credentials file carries the validated PAT (CLI + bridge read it from here)',
    );
    assert(
      credBody.includes('user_id = 4242'),
      'credentials file carries the identity resolved from /api/v1/me',
    );
    // #858: the orphaned `remote-token` cache was removed — setup must no longer
    // log it (the credentials file is the single source of truth).
    assert(
      !/Cached remote PAT at/i.test(remoteSetup.stdout ?? ''),
      'setup --remote --token no longer writes the orphaned remote-token cache',
    );
  } else {
    console.log('-- setup --remote: SKIPPED (set SMOKE_REMOTE=1 to enable) --');
  }

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
