import { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config, loadConfig } from '../../config/env.js';
import { createServer } from '../../api/server.js';

/**
 * `tasks serve` (task #733).
 *
 * Boots the REST API server the same way the production entry point
 * (`src/api/start.ts`) does, but as a first-class CLI subcommand so npm-only
 * users can run `wood-fired-tasks serve` from anywhere.
 *
 * Cwd-independence comes FOR FREE from the paths resolver (#731): the
 * `DATABASE_PATH` env var defaults to the OS app-data path
 * (`src/config/paths.ts` `defaultDbPath`), so no path is hardcoded here. We
 * thread `config.DATABASE_PATH` into `createServer`, which opens that DB and
 * runs migrations (Umzug) BEFORE we begin listening. Launched from any
 * directory, the same app-data DB is migrated and served.
 *
 * The public `/health` route answers 200 unauthenticated regardless of cwd.
 */

export interface ServeOptions {
  /** Optional port override; defaults to `config.PORT`. */
  port?: number;
}

/**
 * Boot the API server: load+validate config, create the server (which runs
 * migrations on the app-data DB), then start listening. Returns the running
 * Fastify server + app so callers (and tests) can read the bound address and
 * close it cleanly.
 *
 * Migrations run inside `createServer` → `createApp` BEFORE `server.listen`,
 * so a request that lands after this resolves always hits a migrated DB.
 */
export async function startServer(options: ServeOptions = {}): Promise<{
  server: Awaited<ReturnType<typeof createServer>>['server'];
  app: Awaited<ReturnType<typeof createServer>>['app'];
  port: number;
  host: string;
}> {
  // Fail-fast: validate configuration before doing anything else.
  loadConfig();

  // Use the resolver-defaulted DATABASE_PATH (#731) — never a hardcoded path.
  const dbPath = config.DATABASE_PATH;

  // Ensure the DB's parent directory exists BEFORE createApp opens the file.
  // createApp → initDatabase opens the DB file before runMigrations gets a
  // chance to mkdir, so a first-ever boot against a fresh OS app-data dir
  // (the #731 default) would otherwise fail with "directory does not exist".
  // `:memory:` and bare filenames have no directory to create.
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (dir && dir !== '.') {
      mkdirSync(dir, { recursive: true });
    }
  }

  const { server, app } = await createServer({ dbPath });

  // Task #811: emit ONE structured boot log line reporting the OIDC
  // enablement state (`ready` / `disabled` / `degraded`) so operators can
  // confirm device-flow availability straight from the boot logs. The state
  // is resolved once at `createApp` time and surfaced as `app.oidcStatus`
  // (see src/index.ts `OidcStatus`); we do NOT recompute it here. The message
  // string and the `oidc` field are kept stable so tests/log-scrapers can
  // assert against them.
  server.log.info({ oidc: app.oidcStatus.state }, 'oidc boot state');

  const port = options.port ?? config.PORT;
  const host = config.HOST;

  // Migrations have already run inside createServer/createApp; only now do we
  // begin accepting connections.
  await server.listen({ port, host });

  return { server, app, port, host };
}

export const serveCommand = new Command('serve')
  .description('Run the Wood Fired Tasks API server (migrates the app-data DB on start)')
  .addHelpText(
    'after',
    `
The server opens the database at DATABASE_PATH (defaulting to the OS app-data
path) and runs all pending migrations BEFORE it begins listening. The bind host
comes from HOST (default 127.0.0.1; set HOST=0.0.0.0 to expose on the LAN) and
the port from PORT unless overridden with --port.

The unauthenticated GET /health route returns 200 once the server is up.

Examples:
  tasks serve                 Serve on HOST:PORT (default 127.0.0.1:3000)
  tasks serve --port 8080     Serve on port 8080
  HOST=0.0.0.0 tasks serve    Expose on every interface
`,
  )
  .option('--port <n>', 'Port to listen on (overrides the PORT env var)', (value) => {
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(`--port must be an integer between 0 and 65535, got "${value}"`);
    }
    return n;
  })
  .action(async () => {
    const opts = serveCommand.opts<{ port?: number }>();
    const { host, port } = await startServer({
      ...(opts.port !== undefined && { port: opts.port }),
    });
    process.stdout.write(
      `Wood Fired Tasks API listening on http://${host}:${port}` +
        (host === '127.0.0.1' ? ' (loopback only; set HOST=0.0.0.0 to expose on LAN)\n' : '\n'),
    );
  });
