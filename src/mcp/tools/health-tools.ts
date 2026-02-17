import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { randomUUID } from 'crypto';

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
      const traceId = randomUUID();
      const timestamp = new Date().toISOString();
      const version = '1.0.0';
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'check_health', event: 'start', timestamp }));

      try {
        // Test database connectivity
        db.prepare('SELECT 1').get();

        console.error(JSON.stringify({ level: 'info', traceId, tool: 'check_health', event: 'success' }));
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
        console.error(JSON.stringify({ level: 'error', traceId, tool: 'check_health', event: 'error', error: error instanceof Error ? error.message : String(error) }));

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
