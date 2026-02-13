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
  const { server, app } = await createServer();

  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  // Register graceful shutdown handlers
  const shutdown = async (signal: string) => {
    server.log.info({ signal }, 'Received shutdown signal');

    try {
      // Stop accepting new connections and drain existing
      await server.close();

      // Close database connection
      app.db.close();

      server.log.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      server.log.fatal({ error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    server.log.fatal({ error }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    server.log.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
  });

  // Start the server
  await server.listen({ port, host });

  server.log.info(
    {
      host,
      port,
      nodeEnv: process.env.NODE_ENV || 'development',
    },
    'Server started'
  );
}

main();
