// Validate configuration at startup (fail-fast)
import { config, ExitCodes, loadConfig } from '../config/env.js';

// Trigger config validation immediately
loadConfig();

import { createServer } from './server.js';

/**
 * Production entry point for Wood Fired Bugs REST API
 *
 * Features:
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Binds to 0.0.0.0 for LAN accessibility
 * - Proper error handling for uncaught exceptions
 */
async function main() {
  // Fail-fast: validate configuration before starting server
  loadConfig();

  const { server, app } = await createServer();

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

  server.log.info(
    {
      host,
      port,
      nodeEnv: config.NODE_ENV,
    },
    'Server started'
  );
}

main();
