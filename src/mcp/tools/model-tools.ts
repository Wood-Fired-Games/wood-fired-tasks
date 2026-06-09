/**
 * Task 9 (project "Configurable Task Models") — `model-tools.ts`.
 *
 * Two READ-ONLY MCP tools that expose the model-catalog (task #917) and
 * model-policy (task #914) services to MCP clients. Neither tool writes to the
 * database; both mirror the registration shape, Zod input schema,
 * `toStructuredContent` usage, and `convertToMcpError` error handling of
 * `src/mcp/tools/topology-tools.ts`.
 *
 * - `list_models` — calls `catalog.list()` and returns the catalog
 *   (`{ models, stale }`) verbatim in `structuredContent`.
 * - `resolve_model` — calls `modelPolicy.resolveModel(project_id, role,
 *   task_id?)` and returns the resolver output VERBATIM in `structuredContent`:
 *   `{ model: string }` | `{ model: 'auto' }` | `null`. The `null` case means
 *   "inherit the session model"; it is surfaced as `structuredContent: null`
 *   (the resolver output, unwrapped).
 *
 * Wiring these tools into `src/mcp/server.ts` is a separate downstream task
 * (#920); this module only constructs and registers them onto a supplied
 * server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toStructuredContent } from '../lib/structured-content.js';
import { convertToMcpError } from '../errors.js';
import type { ModelCatalogService } from '../../services/model-catalog.service.js';
import type { ModelPolicyService, PipelineRole } from '../../services/model-policy.service.js';

/** Injected dependencies for {@link registerModelTools}. */
export interface ModelToolsDeps {
  /** The model-catalog service (task #917). */
  catalog: ModelCatalogService;
  /** The model-policy service (task #914). */
  modelPolicy: ModelPolicyService;
}

/**
 * Register the read-only `list_models` and `resolve_model` MCP tools onto
 * `server`, backed by the injected catalog + model-policy services.
 */
export function registerModelTools(server: McpServer, deps: ModelToolsDeps): void {
  server.registerTool(
    'list_models',
    {
      description:
        'List Anthropic models available at runtime (from the Models API, with ' +
        'a static fallback when offline). Returns models[] and a `stale` flag. ' +
        'Read-only.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const catalog = await deps.catalog.list();
        return {
          content: [
            {
              type: 'text',
              text: `${catalog.models.length} models${catalog.stale ? ' (stale fallback)' : ''}`,
            },
          ],
          structuredContent: toStructuredContent(catalog),
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    },
  );

  server.registerTool(
    'resolve_model',
    {
      description:
        'Resolve the model for a pipeline role (execution|validation|planning) ' +
        'for a project, optionally task-scoped for size routing. Returns ' +
        '{ model } (concrete id), { model: "auto" } (resolve from live catalog ' +
        'at dispatch), or null (inherit the session model). Read-only.',
      inputSchema: z.object({
        project_id: z.number().int().positive(),
        role: z.enum(['execution', 'validation', 'planning']),
        task_id: z.number().int().positive().optional(),
      }),
    },
    async (args) => {
      try {
        const resolved = deps.modelPolicy.resolveModel(
          args.project_id,
          args.role as PipelineRole,
          args.task_id,
        );
        return {
          content: [
            {
              type: 'text',
              text: resolved == null ? 'inherit (session model)' : resolved.model,
            },
          ],
          // The AC requires the resolver output VERBATIM. A concrete result is
          // an object and round-trips through `toStructuredContent`; the
          // `null` ("inherit") sentinel is surfaced unwrapped. The SDK callback
          // return type only admits a record (or `undefined`) for
          // `structuredContent`, so the bare-`null` case needs the one cast at
          // this boundary — exactly the sanctioned widening pattern used by
          // `toStructuredContent` itself.
          structuredContent:
            resolved == null
              ? (null as unknown as ReturnType<typeof toStructuredContent>)
              : toStructuredContent(resolved),
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    },
  );
}
