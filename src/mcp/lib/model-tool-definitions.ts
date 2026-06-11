/**
 * Shared definitions for the four model MCP tools (task #930).
 *
 * The stdio registrar (`src/mcp/tools/model-tools.ts`) and the remote-proxy
 * registrar (`src/mcp/remote/register-tools.ts`) previously each carried a
 * VERBATIM copy of every tool's description, input schema, and
 * content/structuredContent rendering — the repo's known stdio↔remote
 * dual-source drift trap. This module is now the single source for those
 * parts; the two registrars differ ONLY in the transport call (in-process
 * service vs REST client) and in transport-specific error mapping.
 *
 * Lives in `src/mcp/lib/` (next to `structured-content.ts`) so both
 * registrars reach it without crossing a dependency-cruiser boundary.
 */

import { z } from 'zod';
import type { ModelCatalogEntry } from '../../schemas/model-catalog.schema.js';
import {
  ModelPolicyNullableSchema,
  PipelineRoleSchema,
  type ModelPolicyNullable,
} from '../../schemas/model-policy.schema.js';
import { toStructuredContent, type StructuredContent } from './structured-content.js';

/**
 * The result shape both registrars hand back to the MCP SDK. A `type` alias
 * (not an interface): the SDK's CallToolResult carries an index signature,
 * and only object-literal type aliases — not interfaces — are implicitly
 * assignable to index-signature types.
 */
type ModelToolResult = {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: StructuredContent;
};

// ── Tool definitions (description + inputSchema) ─────────────────────────────

/** `list_models` registration config. */
export const LIST_MODELS_TOOL_DEFINITION = {
  description:
    'List Anthropic models available at runtime (from the Models API, with ' +
    'a static fallback when offline). Returns models[] and a `stale` flag. ' +
    'Read-only.',
  inputSchema: z.object({}),
};

/** `resolve_model` registration config. */
export const RESOLVE_MODEL_TOOL_DEFINITION = {
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
};

/** `get_model_defaults` registration config. */
export const GET_MODEL_DEFAULTS_TOOL_DEFINITION = {
  description:
    'Get the database-wide default ModelPolicy (the global fallback applied ' +
    'when a project has no policy of its own). Returns { model_policy } ' +
    '(null when no default is configured). Read-only.',
  inputSchema: z.object({}),
};

/** `set_model_defaults` registration config. */
export const SET_MODEL_DEFAULTS_TOOL_DEFINITION = {
  description:
    'Set (or, with null, clear) the database-wide default ModelPolicy. The ' +
    'policy is validated before it is persisted; an invalid shape is ' +
    'rejected. Returns { model_policy } (the value just stored).',
  inputSchema: z.object({
    model_policy: ModelPolicyNullableSchema,
  }),
};

// ── Result renderers (content + structuredContent) ───────────────────────────

/** Render the `list_models` result: the `{ models, stale }` catalog verbatim. */
export function renderListModelsResult(catalog: {
  models: ModelCatalogEntry[];
  stale: boolean;
}): ModelToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `${catalog.models.length} models${catalog.stale ? ' (stale fallback)' : ''}`,
      },
    ],
    structuredContent: toStructuredContent(catalog),
  };
}

/**
 * Render the `resolve_model` result.
 *
 * A concrete result round-trips through `toStructuredContent`. The `null`
 * ("inherit") sentinel OMITS the key entirely: the MCP wire schema types
 * `structuredContent` as an optional RECORD (`z.record(...).optional()` in
 * CallToolResultSchema), so a literal `null` fails client-side result
 * validation in SDK-built clients. The text line ("inherit (session model)")
 * carries the sentinel; absence of structuredContent === inherit.
 */
export function renderResolveModelResult(resolved: { model: string } | null): ModelToolResult {
  return {
    content: [
      {
        type: 'text',
        text: resolved == null ? 'inherit (session model)' : resolved.model,
      },
    ],
    ...(resolved == null ? {} : { structuredContent: toStructuredContent(resolved) }),
  };
}

/** Render the `get_model_defaults` result: `{ model_policy }` (null = unset). */
export function renderGetModelDefaultsResult(policy: ModelPolicyNullable): ModelToolResult {
  return {
    content: [
      {
        type: 'text',
        text: policy == null ? 'no default configured' : 'default model policy set',
      },
    ],
    structuredContent: toStructuredContent({ model_policy: policy }),
  };
}

/** Render the `set_model_defaults` result: `{ model_policy }` (the stored value). */
export function renderSetModelDefaultsResult(policy: ModelPolicyNullable): ModelToolResult {
  return {
    content: [
      {
        type: 'text',
        text: policy == null ? 'default model policy cleared' : 'default model policy updated',
      },
    ],
    structuredContent: toStructuredContent({ model_policy: policy }),
  };
}
