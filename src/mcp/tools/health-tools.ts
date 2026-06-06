import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toStructuredContent } from '../lib/structured-content.js';
import type { Database } from '../../db/driver.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { VERSION } from '../../utils/version.js';

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
      const version = VERSION;
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'check_health', event: 'start', timestamp }));

      try {
        // Test database connectivity
        db.prepare('SELECT 1').get();

        // Fingerprint: which DB file this process opened + cheap counts, so a
        // wrong/stale DB is obvious at a glance (the signal that was missing
        // during the 2026-05-25 incident).
        const projectRow = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
        const maxIdRow = db.prepare('SELECT MAX(id) AS m FROM tasks').get() as { m: number | null };
        const latestRow = db.prepare('SELECT MAX(updated_at) AS t FROM tasks').get() as { t: string | null };
        const database = {
          path: db.name,
          projects: projectRow.n,
          maxTaskId: maxIdRow.m ?? null,
          latestActivity: latestRow.t ?? null,
        };

        console.error(JSON.stringify({ level: 'info', traceId, tool: 'check_health', event: 'success' }));
        return {
          content: [
            {
              type: 'text',
              text: `Service Status: healthy\nVersion: ${version}\nDatabase: ok\nTimestamp: ${timestamp}\nDB Path: ${database.path}\nProjects: ${database.projects}, Max Task ID: ${database.maxTaskId ?? 'none'}, Latest Activity: ${database.latestActivity ?? 'none'}`,
            },
          ],
          structuredContent: toStructuredContent({
            status: 'healthy',
            timestamp,
            version,
            database,
            checks: {
              database: 'ok',
            },
          }),
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
          structuredContent: toStructuredContent({
            status: 'unhealthy',
            timestamp,
            version,
            database: {
              path: db.name,
              projects: 0,
              maxTaskId: null,
              latestActivity: null,
            },
            checks: {
              database: 'failed',
            },
          }),
        };
      }
    }
  );
}
