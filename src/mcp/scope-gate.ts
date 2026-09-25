/**
 * Per-tool PAT scope enforcement for the stdio MCP surface (Security Audit
 * finding M1 — task #1631).
 *
 * ## Why this module exists
 *
 * The stdio MCP server resolves its actor ONCE at boot from `WFT_API_KEY`
 * (`src/mcp/identity-resolution.ts`) and its tool handlers then call
 * `taskService.createTask` / `updateTask` / `deleteTask` / ... directly. It
 * never passes through Fastify, so the REST post-auth gate
 * (`enforceRequiredScope` in `src/api/plugins/auth/index.ts`) — which is the
 * ONLY place scope enforcement landed in tasks #1620/#1621 — cannot see these
 * calls at all.
 *
 * That made stdio MCP a complete authorization bypass: a `read`-scoped PAT
 * exported as `WFT_API_KEY` could still create, mutate, and delete every task
 * in the database. This module closes that hole by giving every MUTATING tool
 * a declared required tier and a one-line gate call.
 *
 * ## Shared semantics, not a re-implementation
 *
 * The tier comparison itself is NOT re-implemented here. {@link enforceToolScope}
 * delegates to `grantSatisfiesScope` from `src/schemas/pat-scope.schema.ts` —
 * the exact predicate the REST gate calls — so the two surfaces can never
 * drift on the ordering (`read < write < admin`) or on the two special cases
 * that predicate owns:
 *
 *   - `null` — the actor authenticated via a mechanism that carries NO PAT
 *     scope restriction (legacy `API_KEYS` hash match, or the `mcp-bot`
 *     service-account fallback when `WFT_API_KEY` is unset). Treated as
 *     full-tier, mirroring how the REST chain treats session cookies.
 *   - `[]` (empty array) — a PAT minted before the #1620 taxonomy existed.
 *     Explicit LEGACY RULE: an empty scope array is full-tier, so
 *     pre-existing tokens are never silently denied by this new gate. This
 *     matches the REST gate exactly.
 *
 * ## Tiering rationale (see {@link MUTATING_TOOL_SCOPES})
 *
 *   - `write` — anything that creates or edits a row a task-agent legitimately
 *     needs to touch while draining a backlog: task/project create + update,
 *     claim, comment, dependency edges, and a WSJF rescore (which appends
 *     history rows).
 *   - `admin` — row-destructive deletes (`delete_task`, `delete_project`,
 *     `delete_comment`) and the database-wide settings mutation
 *     (`set_model_defaults`). These are irreversible or global, so they sit
 *     one tier above ordinary agent writes.
 *
 * Read-only tools are deliberately ABSENT from the map and therefore
 * ungated — a `read` PAT must keep working for every query surface.
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { grantSatisfiesScope, type PatScope } from '../schemas/pat-scope.schema.js';

/**
 * Declared required scope tier for every MUTATING stdio MCP tool.
 *
 * This map is the single source of truth for "which tools are gated and at
 * what tier". A tool absent from this map is, by construction, treated as
 * read-only and is NOT gated.
 *
 * The full registered-tool sweep behind this map (31 tools as of #1631):
 *
 * | tool                 | mutating? | tier        |
 * |----------------------|-----------|-------------|
 * | create_task          | yes       | write       |
 * | update_task          | yes       | write       |
 * | delete_task          | yes       | admin       |
 * | claim_task           | yes       | write       |
 * | get_task             | no        | (ungated)   |
 * | list_tasks           | no        | (ungated)   |
 * | list_subtasks        | no        | (ungated)   |
 * | get_subtasks         | no        | (ungated)   |
 * | completion_report    | no        | (ungated)   |
 * | wait_for_unblock     | no        | (ungated)   |
 * | create_project       | yes       | write       |
 * | update_project       | yes       | write       |
 * | delete_project       | yes       | admin       |
 * | get_project          | no        | (ungated)   |
 * | list_projects        | no        | (ungated)   |
 * | add_dependency       | yes       | write       |
 * | remove_dependency    | yes       | write       |
 * | get_dependencies     | no        | (ungated)   |
 * | add_comment          | yes       | write       |
 * | delete_comment       | yes       | admin       |
 * | get_comments         | no        | (ungated)   |
 * | rescore_project      | yes       | write       |
 * | wsjf_ranking         | no        | (ungated)   |
 * | wsjf_history         | no        | (ungated)   |
 * | wsjf_health          | no        | (ungated)   |
 * | set_model_defaults   | yes       | admin       |
 * | get_model_defaults   | no        | (ungated)   |
 * | list_models          | no        | (ungated)   |
 * | resolve_model        | no        | (ungated)   |
 * | check_health         | no        | (ungated)   |
 * | topology_check       | no        | (ungated)   |
 */
export const MUTATING_TOOL_SCOPES = {
  // --- task-tools.ts -------------------------------------------------------
  create_task: 'write',
  update_task: 'write',
  delete_task: 'admin',
  claim_task: 'write',
  // --- project-tools.ts ----------------------------------------------------
  create_project: 'write',
  update_project: 'write',
  delete_project: 'admin',
  // --- dependency-tools.ts -------------------------------------------------
  add_dependency: 'write',
  remove_dependency: 'write',
  // --- comment-tools.ts ----------------------------------------------------
  add_comment: 'write',
  delete_comment: 'admin',
  // --- wsjf-tools.ts -------------------------------------------------------
  rescore_project: 'write',
  // --- model-tools.ts ------------------------------------------------------
  set_model_defaults: 'admin',
} as const satisfies Record<string, PatScope>;

/** Name of a tool carrying a declared required scope in {@link MUTATING_TOOL_SCOPES}. */
export type MutatingToolName = keyof typeof MUTATING_TOOL_SCOPES;

/**
 * Machine-readable discriminator on the thrown {@link McpError}'s `data`
 * payload. Mirrors the REST 403 body's `error: 'insufficient_scope'` so a
 * client can branch on the same string regardless of transport.
 */
export const INSUFFICIENT_SCOPE_ERROR = 'insufficient_scope';

/** Structured `data` payload attached to an insufficient-scope {@link McpError}. */
export interface InsufficientScopeData {
  error: typeof INSUFFICIENT_SCOPE_ERROR;
  tool: MutatingToolName;
  requiredScope: PatScope;
  grantedScopes: PatScope[] | null;
  [key: string]: unknown;
}

/**
 * Gate a mutating tool call against the boot-resolved PAT grant.
 *
 * Returns normally (and the caller proceeds with the mutation) when the grant
 * satisfies the tool's declared tier. Otherwise throws an {@link McpError} —
 * the SAME failure channel every other MCP tool error uses
 * (`convertToMcpError` in `src/mcp/errors.ts`), which the MCP SDK renders as
 * an `isError: true` tool result. It does NOT reject the transport or crash
 * the process.
 *
 * Call this as the FIRST statement of a mutating handler's `try` block, so
 * the denial is also captured by that handler's structured `event: 'error'`
 * stderr log. `convertToMcpError` passes an already-`McpError` through
 * unchanged, so the structured payload survives the surrounding catch.
 *
 * @param scopes the grant resolved at boot (`McpServerContext.scopes`).
 *   `undefined` (context predates #1631 / test harness) and `null` (non-PAT
 *   credential class) both mean "no PAT scope restriction" — full tier.
 * @param tool   the tool being invoked; its tier is looked up in
 *   {@link MUTATING_TOOL_SCOPES}.
 * @throws McpError `InvalidRequest` with {@link InsufficientScopeData} in `data`.
 */
export function enforceToolScope(
  scopes: readonly PatScope[] | null | undefined,
  tool: MutatingToolName,
): void {
  const required: PatScope = MUTATING_TOOL_SCOPES[tool];
  const granted = scopes ?? null;
  if (grantSatisfiesScope(granted, required)) {
    return;
  }
  const data: InsufficientScopeData = {
    error: INSUFFICIENT_SCOPE_ERROR,
    tool,
    requiredScope: required,
    grantedScopes: granted === null ? null : [...granted],
  };
  throw new McpError(
    ErrorCode.InvalidRequest,
    `insufficient_scope: the '${tool}' tool requires the '${required}' scope, ` +
      `but the credential in WFT_API_KEY grants [${granted === null ? '' : granted.join(', ')}].`,
    data,
  );
}
