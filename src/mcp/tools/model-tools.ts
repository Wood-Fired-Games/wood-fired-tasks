/**
 * Task 9 (project "Configurable Task Models") — `model-tools.ts`.
 *
 * Two READ-ONLY MCP tools that expose the model-catalog (task #917) and
 * model-policy (task #914) services to MCP clients. Neither tool writes to the
 * database. Descriptions, input schemas, and result rendering come from the
 * shared `src/mcp/lib/model-tool-definitions.ts` (task #930) — this registrar
 * contributes only the in-process service calls and `convertToMcpError`
 * error handling (mirroring `src/mcp/tools/topology-tools.ts`).
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
import { convertToMcpError } from '../errors.js';
import {
  LIST_MODELS_TOOL_DEFINITION,
  RESOLVE_MODEL_TOOL_DEFINITION,
  GET_MODEL_DEFAULTS_TOOL_DEFINITION,
  SET_MODEL_DEFAULTS_TOOL_DEFINITION,
  renderListModelsResult,
  renderResolveModelResult,
  renderGetModelDefaultsResult,
  renderSetModelDefaultsResult,
} from '../lib/model-tool-definitions.js';
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
  server.registerTool('list_models', LIST_MODELS_TOOL_DEFINITION, async () => {
    try {
      const catalog = await deps.catalog.list();
      return renderListModelsResult(catalog);
    } catch (error) {
      throw convertToMcpError(error);
    }
  });

  server.registerTool('resolve_model', RESOLVE_MODEL_TOOL_DEFINITION, async (args) => {
    try {
      const resolved = deps.modelPolicy.resolveModel(args.project_id, args.role, args.task_id);
      return renderResolveModelResult(resolved);
    } catch (error) {
      throw convertToMcpError(error);
    }
  });
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
  server.registerTool('get_model_defaults', GET_MODEL_DEFAULTS_TOOL_DEFINITION, async () => {
    try {
      const policy = deps.settings.getModelPolicyDefault();
      return renderGetModelDefaultsResult(policy);
    } catch (error) {
      throw convertToMcpError(error);
    }
  });

  server.registerTool('set_model_defaults', SET_MODEL_DEFAULTS_TOOL_DEFINITION, async (args) => {
    try {
      deps.settings.setModelPolicyDefault(args.model_policy);
      return renderSetModelDefaultsResult(args.model_policy);
    } catch (error) {
      throw convertToMcpError(error);
    }
  });
}
