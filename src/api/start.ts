// Validate configuration at startup (fail-fast)
import { config, ExitCodes, loadConfig } from '../config/env.js';

// Trigger config validation immediately
loadConfig();

import { createServer } from './server.js';

/**
 * Production entry point for Wood Fired Tasks REST API
 *
 * Features:
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Binds to HOST env var (default 127.0.0.1; set HOST=0.0.0.0 for LAN)
 * - Proper error handling for uncaught exceptions
 */
async function main() {
  // Fail-fast: validate configuration before starting server
  loadConfig();

  // Task #703: thread the validated DATABASE_PATH into createServer so the
  // production server opens the operator-configured database (e.g.
  // DATABASE_PATH=/var/lib/wft/tasks.db) instead of silently falling back to
  // createApp's hard-coded './data/tasks.db' default. Without this, setting
  // DATABASE_PATH only affected the CLI/MCP entry points, never the API server.
  const { server, app } = await createServer({ dbPath: config.DATABASE_PATH });

  const port = config.PORT;
  const host = config.HOST;

  // Periodic WAL checkpoint to prevent file bloat (every 15 minutes by default)
  const checkpointInterval = setInterval(() => {
    try {
      server.log.debug('Running periodic WAL checkpoint');
      const result = app.db.pragma('wal_checkpoint(TRUNCATE)');
      server.log.debug({ checkpointResult: result }, 'WAL checkpoint completed');
    } catch (error) {
      server.log.error('WAL checkpoint failed');
    }
  }, config.WAL_CHECKPOINT_INTERVAL_MS);

  // Register graceful shutdown handlers
  const shutdown = async (signal: string) => {
    server.log.info({ signal }, 'Received shutdown signal');

    try {
      // Clear the periodic checkpoint interval
      clearInterval(checkpointInterval);

      // Stop accepting new connections and drain existing
      await server.close();

      // Run WAL checkpoint during shutdown
      server.log.info('Running WAL checkpoint before shutdown');
      app.db.pragma('wal_checkpoint(TRUNCATE)');

      // Close database connection
      app.db.close();

      server.log.info('Shutdown complete');
      process.exit(ExitCodes.EX_OK);
    } catch (error) {
      server.log.fatal({ error }, 'Error during shutdown');
      process.exit(ExitCodes.EX_SOFTWARE);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    server.log.fatal({ error }, 'Uncaught exception');
    process.exit(ExitCodes.EX_SOFTWARE);
  });

  process.on('unhandledRejection', (reason) => {
    server.log.fatal({ reason }, 'Unhandled rejection');
    process.exit(ExitCodes.EX_SOFTWARE);
  });

  // Start the server
  await server.listen({ port, host });

  // task #188: emit a clearly-visible startup line showing the bound
  // interface. The default is now 127.0.0.1 (loopback only); operators
  // who want LAN access must set HOST=0.0.0.0 (or a specific LAN IP)
  // explicitly. Surfacing the host here makes the binding obvious at boot.
  server.log.info(
    {
      host,
      port,
      nodeEnv: config.NODE_ENV,
    },
    `Server listening on http://${host}:${port}` +
      (host === '127.0.0.1' ? ' (loopback only; set HOST=0.0.0.0 to expose on LAN)' : ''),
  );
}

// Top-level entry: handle startup failures explicitly so a rejected boot
// promise produces a deterministic fatal log + non-zero exit instead of
// relying on the generic unhandledRejection handler (noFloatingPromises).
main().catch((error) => {
  console.error('Fatal error during startup', error);
  process.exit(ExitCodes.EX_SOFTWARE);
});
