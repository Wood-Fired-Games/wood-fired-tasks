import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';

/**
 * Register health check MCP tool
 *
 * Provides service health monitoring capabilities:
 * - check_health: Check service health status, database connectivity, and version information
 */
export function registerHealthTools(server: McpServer, db: Database): void {
  // Tool: check_health
  server.registerTool(
    'check_health',
    {
      description: 'Check service health status, database connectivity, and version information',
      inputSchema: z.object({}),
    },
    async () => {
      const timestamp = new Date().toISOString();
      const version = '1.0.0';

      try {
        // Test database connectivity
        db.prepare('SELECT 1').get();

        return {
          content: [
            {
              type: 'text',
              text: `Service Status: healthy\nVersion: ${version}\nDatabase: ok\nTimestamp: ${timestamp}`,
            },
          ],
          structuredContent: {
            status: 'healthy',
            timestamp,
            version,
            checks: {
              database: 'ok',
            },
          } as unknown as Record<string, unknown>,
        };
      } catch (error) {
        // Database check failed - log error but return unhealthy status
        console.error('Database health check failed:', error);

        return {
          content: [
            {
              type: 'text',
              text: `Service Status: unhealthy\nVersion: ${version}\nDatabase: failed\nTimestamp: ${timestamp}`,
            },
          ],
          structuredContent: {
            status: 'unhealthy',
            timestamp,
            version,
            checks: {
              database: 'failed',
            },
          } as unknown as Record<string, unknown>,
        };
      }
    }
  );
}
