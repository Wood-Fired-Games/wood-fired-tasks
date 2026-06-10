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
import {
  ModelPolicyNullableSchema,
  PipelineRoleSchema,
} from '../../schemas/model-policy.schema.js';
import type { ModelCatalogService } from '../../services/model-catalog.service.js';
import type { ModelPolicyService } from '../../services/model-policy.service.js';
import type { SettingsService } from '../../services/settings.service.js';

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
        role: PipelineRoleSchema,
        task_id: z.number().int().positive().optional(),
      }),
    },
    async (args) => {
      try {
        const resolved = deps.modelPolicy.resolveModel(args.project_id, args.role, args.task_id);
        return {
          content: [
            {
              type: 'text',
              text: resolved == null ? 'inherit (session model)' : resolved.model,
            },
          ],
          // A concrete result round-trips through `toStructuredContent`. The
          // `null` ("inherit") sentinel OMITS the key entirely: the MCP wire
          // schema types `structuredContent` as an optional RECORD
          // (`z.record(...).optional()` in CallToolResultSchema), so a literal
          // `null` fails client-side result validation in SDK-built clients.
          // The text line ("inherit (session model)") carries the sentinel;
          // absence of structuredContent === inherit.
          ...(resolved == null ? {} : { structuredContent: toStructuredContent(resolved) }),
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    },
  );
}

/** Injected dependencies for {@link registerModelDefaultsTools}. */
export interface ModelDefaultsToolsDeps {
  /** The settings service owning the database-wide model-policy default (task #916). */
  settings: SettingsService;
}

/**
 * Register the read/write `get_model_defaults` and `set_model_defaults` MCP
 * tools onto `server`, backed by the injected settings service.
 *
 * Both surface the global default policy as `structuredContent { model_policy }`
 * (mirroring the `registerModelTools` registration shape — `toStructuredContent`
 * + `convertToMcpError`). `set_model_defaults` validates its input through
 * `ModelPolicyNullableSchema` (a `null` policy clears the default).
 */
export function registerModelDefaultsTools(server: McpServer, deps: ModelDefaultsToolsDeps): void {
  server.registerTool(
    'get_model_defaults',
    {
      description:
        'Get the database-wide default ModelPolicy (the global fallback applied ' +
        'when a project has no policy of its own). Returns { model_policy } ' +
        '(null when no default is configured). Read-only.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const policy = deps.settings.getModelPolicyDefault();
        return {
          content: [
            {
              type: 'text',
              text: policy == null ? 'no default configured' : 'default model policy set',
            },
          ],
          structuredContent: toStructuredContent({ model_policy: policy }),
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    },
  );

  server.registerTool(
    'set_model_defaults',
    {
      description:
        'Set (or, with null, clear) the database-wide default ModelPolicy. The ' +
        'policy is validated before it is persisted; an invalid shape is ' +
        'rejected. Returns { model_policy } (the value just stored).',
      inputSchema: z.object({
        model_policy: ModelPolicyNullableSchema,
      }),
    },
    async (args) => {
      try {
        deps.settings.setModelPolicyDefault(args.model_policy);
        return {
          content: [
            {
              type: 'text',
              text:
                args.model_policy == null
                  ? 'default model policy cleared'
                  : 'default model policy updated',
            },
          ],
          structuredContent: toStructuredContent({ model_policy: args.model_policy }),
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    },
  );
}
