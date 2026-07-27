/**
 * Security Audit finding M5 (task #1632) — stdio MCP audit-trail producer.
 *
 * ## Why this module exists
 *
 * Task #1630 made the REST API the first producer of `audit_events` rows via a
 * root-level `onResponse` hook (`src/api/hooks/audit-trail.ts`). The stdio MCP
 * server never passes through Fastify: it resolves its actor ONCE at boot and
 * its tool handlers call the services directly. Every mutation made through
 * that surface produced ZERO rows — and the automation loop drives most writes
 * through exactly that surface, so the trail under-reported its busiest
 * producer.
 *
 * This module closes that gap by INTERCEPTING TOOL REGISTRATION rather than by
 * editing thirteen handlers. {@link installMcpAuditTrail} replaces
 * `server.registerTool` with a wrapper that, for any tool named in
 * {@link MUTATING_TOOL_SCOPES}, appends exactly one row per call.
 *
 * ## The audited set IS the gated set
 *
 * "Which tools mutate" has exactly one definition in this codebase:
 * `MUTATING_TOOL_SCOPES` in `src/mcp/scope-gate.ts` (task #1631). This module
 * does not restate it — {@link isMutatingTool} is a membership test against
 * that very object, so a tool added there is audited automatically and a tool
 * removed there stops being audited automatically. There is no second list to
 * drift.
 *
 * The one piece of per-tool data the gate map cannot supply is the audit
 * TARGET (`resource_type` / which argument carries `resource_id`), declared in
 * {@link MCP_AUDIT_TARGETS}. That map is typed
 * `satisfies Record<MutatingToolName, McpAuditTarget>`, which makes the sync a
 * COMPILE-TIME guarantee in both directions: a missing key is a type error
 * (`Record` demands every `MutatingToolName`) and an extra key is an excess-
 * property error. `src/mcp/__tests__/audit-trail.test.ts` adds the equivalent
 * runtime drift guard so the invariant is also visible as a failing test.
 *
 * ## `action` — `"MCP <tool_name>"`
 *
 * The REST hook writes `"<METHOD> <route pattern>"` (`POST /api/v1/tasks`).
 * This surface writes `"MCP <tool_name>"` (`MCP create_task`). The two can
 * never be confused or collide: REST actions always contain a space-delimited
 * second token starting with `/`, and `MCP` is not an HTTP method. Both are
 * low-cardinality (one distinct value per route / per tool), so `GROUP BY
 * action` stays meaningful across the union, and `action LIKE 'MCP %'` is an
 * exact surface filter.
 *
 * ## resource_type / resource_id — deliberately the REST vocabulary
 *
 * `resource_type` values are copied from what the REST hook derives for the
 * EQUIVALENT route, not invented (`tasks`, `projects`, `dependencies`,
 * `comments`, `rescore`, `model-policy`). That is what makes a single
 * `WHERE resource_type = 'tasks' AND resource_id = '42'` query return the row
 * regardless of which surface performed the mutation.
 *
 * `resource_id` follows the REST hook's rule exactly: an instance-addressing
 * call carries the id (`update_task` → `args.id`), and a CREATE carries NULL —
 * the id of a row created by a POST is not part of the request, and the REST
 * hook nulls the column for the same reason. The parent ids that were in the
 * call are still preserved under `metadata.params`.
 *
 * ## Refusal semantics — a scope-refused call writes NO row
 *
 * A call refused by `enforceToolScope` (#1631) never reached a service; no
 * state changed. This module deliberately DIFFERS from the REST hook there,
 * and the difference is structural rather than a matter of taste:
 *
 *   - The REST hook is a RESPONSE-phase hook. By the time it runs, "refused by
 *     the scope gate" and "applied" are both just a status code; it cannot
 *     position itself before or after the gate, so it records the 403 too.
 *   - This wrapper is CALL-phase and wraps the handler, so it can see the
 *     refusal as a distinct outcome — and the authorization boundary is
 *     exactly where "an action on a resource" begins. Before it, there is no
 *     action to attribute to a resource; there is an authorization decision,
 *     whose canonical home is the auth log (#1631 already surfaces every
 *     refusal as a structured `insufficient_scope` error result).
 *
 * Consequence for the union query, stated so consumers can normalize: the MCP
 * row set is "calls that passed authorization", the REST row set is
 * "authenticated requests that reached a route". They agree once REST rows
 * with `metadata.status = 403` are excluded.
 *
 * Everything PAST the gate is recorded regardless of outcome — a
 * `NotFoundError` from `update_task` produces a row with
 * `metadata.outcome = 'error'`, mirroring the REST row a 404 produces. The
 * trail records ATTEMPTS, not just successes; only the pre-authorization
 * refusal is out of scope.
 *
 * ## Non-fatal by construction
 *
 * The append runs AFTER the handler has produced its result (or its error), in
 * its own try/catch. A repository failure can therefore never change what the
 * tool returns — but it is never silent either: it emits an
 * `audit.append_failed` line at ERROR level. That line goes to STDERR
 * (`console.error`), because stdout on this surface is the JSON-RPC stream and
 * any write to it corrupts the protocol (Pitfall 5, see
 * `src/mcp/__tests__/stdio-compliance.test.ts`).
 */
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from '../db/driver.js';
import { AuditEventRepository } from '../repositories/audit-event.repository.js';
import type { AuditEventRecord, IAuditEventRepository } from '../repositories/interfaces.js';
import type { AuthMethod } from '../types/identity.js';
import type { ResolutionPath } from './identity-resolution.js';
import {
  INSUFFICIENT_SCOPE_ERROR,
  MUTATING_TOOL_SCOPES,
  type MutatingToolName,
} from './scope-gate.js';

/**
 * The only member of `IAuditEventRepository` this producer needs. Narrowing
 * the dependency keeps the append path honest (nothing here can read or
 * verify the chain) and makes the failure-injection test a two-line stub.
 */
export type AuditAppender = Pick<IAuditEventRepository, 'append'>;

/** Where a tool's `resource_type` / `resource_id` come from. */
export interface McpAuditTarget {
  /**
   * The `resource_type` column value. Copied VERBATIM from what the REST hook
   * derives for the equivalent route (its trailing collection segment), so the
   * two surfaces share one vocabulary — plural and un-singularized, exactly as
   * `deriveAuditResource` produces it.
   */
  resourceType: string;
  /**
   * Name of the tool argument carrying the addressed row's id, or `null` when
   * the call addresses a COLLECTION (every create). `null` ⇒ `resource_id` is
   * NULL, matching the REST hook's treatment of a POST to a collection route.
   */
  resourceIdArg: string | null;
}

/**
 * Audit target for every mutating tool.
 *
 * `satisfies Record<MutatingToolName, McpAuditTarget>` is the drift guard:
 * `MutatingToolName` is `keyof typeof MUTATING_TOOL_SCOPES`, so this object
 * cannot compile while it is missing a gated tool or naming a tool that is not
 * gated. Adding a mutating tool to the scope map without adding it here is a
 * BUILD failure, not a silently unaudited mutation.
 *
 * The REST route each value mirrors:
 *
 * | tool               | REST route                                    | resource_type |
 * |--------------------|-----------------------------------------------|---------------|
 * | create_task        | POST   /api/v1/tasks                          | tasks         |
 * | update_task        | PATCH  /api/v1/tasks/:id                      | tasks         |
 * | delete_task        | DELETE /api/v1/tasks/:id                      | tasks         |
 * | claim_task         | PATCH  /api/v1/tasks/:id                      | tasks         |
 * | create_project     | POST   /api/v1/projects                       | projects      |
 * | update_project     | PATCH  /api/v1/projects/:id                   | projects      |
 * | delete_project     | DELETE /api/v1/projects/:id                   | projects      |
 * | add_dependency     | POST   /api/v1/tasks/:id/dependencies         | dependencies  |
 * | remove_dependency  | DELETE /api/v1/tasks/:id/dependencies/:blocksTaskId | dependencies |
 * | add_comment        | POST   /api/v1/tasks/:id/comments             | comments      |
 * | delete_comment     | DELETE /api/v1/tasks/:id/comments/:commentId  | comments      |
 * | rescore_project    | POST   /api/v1/projects/:id/rescore           | rescore       |
 * | set_model_defaults | PUT    /api/v1/settings/model-policy          | model-policy  |
 */
export const MCP_AUDIT_TARGETS = {
  // --- task-tools.ts -------------------------------------------------------
  create_task: { resourceType: 'tasks', resourceIdArg: null },
  update_task: { resourceType: 'tasks', resourceIdArg: 'id' },
  delete_task: { resourceType: 'tasks', resourceIdArg: 'id' },
  claim_task: { resourceType: 'tasks', resourceIdArg: 'task_id' },
  // --- project-tools.ts ----------------------------------------------------
  create_project: { resourceType: 'projects', resourceIdArg: null },
  update_project: { resourceType: 'projects', resourceIdArg: 'id' },
  delete_project: { resourceType: 'projects', resourceIdArg: 'id' },
  // --- dependency-tools.ts -------------------------------------------------
  add_dependency: { resourceType: 'dependencies', resourceIdArg: null },
  remove_dependency: { resourceType: 'dependencies', resourceIdArg: 'blocks_task_id' },
  // --- comment-tools.ts ----------------------------------------------------
  add_comment: { resourceType: 'comments', resourceIdArg: null },
  delete_comment: { resourceType: 'comments', resourceIdArg: 'comment_id' },
  // --- wsjf-tools.ts -------------------------------------------------------
  rescore_project: { resourceType: 'rescore', resourceIdArg: null },
  // --- model-tools.ts ------------------------------------------------------
  set_model_defaults: { resourceType: 'model-policy', resourceIdArg: null },
} as const satisfies Record<MutatingToolName, McpAuditTarget>;

/**
 * Surface tag written into `action` and `metadata.surface`. See the module
 * note on why this cannot collide with a REST `"<METHOD> <pattern>"` value.
 */
export const MCP_AUDIT_ACTION_PREFIX = 'MCP';

/** `"MCP <tool_name>"` — the `action` column value for one MCP mutation. */
export function buildMcpAuditAction(tool: string): string {
  return `${MCP_AUDIT_ACTION_PREFIX} ${tool}`;
}

/**
 * True when `name` is a tool the #1631 scope gate treats as mutating.
 *
 * This is the SINGLE source of truth for "audit this tool": it reads
 * `MUTATING_TOOL_SCOPES` directly rather than copying its keys.
 */
export function isMutatingTool(name: string): name is MutatingToolName {
  return Object.hasOwn(MUTATING_TOOL_SCOPES, name);
}

/**
 * `actor_type` for a boot resolution path.
 *
 * `pat` / `legacy` resolve a REAL user (the token's owner, or the user behind
 * an `API_KEYS` label). Every other path — the `pat-*-fallback` variants, the
 * unmatched-legacy fallback, and the unset-key fallback — resolves the
 * `mcp-bot` SERVICE ACCOUNT, which is precisely the distinction the REST hook
 * draws with `user.isServiceAccount`.
 */
export function mcpActorTypeForPath(path: ResolutionPath | undefined): string {
  return path === 'pat' || path === 'legacy' ? 'user' : 'service_account';
}

/**
 * `metadata.authMethod` for a boot resolution path, in the SHARED
 * {@link AuthMethod} vocabulary the REST hook records.
 *
 * `null` for every mcp-bot fallback: no credential proved a user identity
 * there, which is the same thing `authMethod === null` means on REST.
 * The finer-grained MCP-only detail is kept alongside as
 * `metadata.resolutionPath`.
 */
export function mcpAuthMethodForPath(path: ResolutionPath | undefined): AuthMethod | null {
  if (path === 'pat') return 'pat';
  if (path === 'legacy') return 'legacy';
  return null;
}

/** Identity + sink for the audit rows this surface produces. */
export interface McpAuditContext {
  /** Append-only writer. The ONLY supported way to write `audit_events`. */
  repository: AuditAppender;
  /**
   * Boot-resolved actor `users.id`. `null` ⇒ no principal, so nothing is
   * written — the same early return the REST hook makes for an
   * unauthenticated request, and the reason `audit_events.actor_id` can stay
   * NOT NULL. Only pre-#1632 callers (tests constructing a bare context) hit
   * this; the production boot path always resolves an actor or throws.
   */
  actorUserId: number | null;
  /** `api_tokens.id` when a PAT authenticated this process, else `null`. */
  tokenId: string | null;
  /** Boot resolution path; drives `actor_type` and `metadata.authMethod`. */
  resolutionPath?: ResolutionPath;
  /**
   * Sink for the `audit.append_failed` ERROR line. Defaults to a single
   * `console.error` JSON line — STDERR, never stdout (JSON-RPC stream).
   * Injectable so a test can assert the line is emitted.
   */
  log?: (payload: Record<string, unknown>) => void;
}

/** Outcome of the wrapped handler, recorded in `metadata`. */
type ToolOutcome = { outcome: 'ok' } | { outcome: 'error'; errorCode: number | null };

/**
 * Lazily-constructed default writer over `db`.
 *
 * Deliberately lazy: `new AuditEventRepository(db)` prepares statements in its
 * constructor and therefore THROWS if `audit_events` is absent. Constructing
 * it eagerly inside `createMcpServer` would turn a missing migration into a
 * server-construction failure; deferring it to the first append routes that
 * same failure into the non-fatal `audit.append_failed` path, where a broken
 * audit sink belongs.
 */
export function defaultAuditAppender(db: Database.Database): AuditAppender {
  let repository: AuditEventRepository | null = null;
  return {
    append(record: AuditEventRecord): number {
      repository ??= new AuditEventRepository(db);
      return repository.append(record);
    },
  };
}

/**
 * True for the `insufficient_scope` refusal thrown by `enforceToolScope`.
 *
 * Identified by the structured `data.error` discriminator the gate attaches,
 * not by message text. `convertToMcpError` passes an existing `McpError`
 * through unchanged, so the payload survives every handler's catch block.
 */
export function isInsufficientScopeError(error: unknown): boolean {
  if (!(error instanceof McpError)) {
    return false;
  }
  const data = error.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { error?: unknown }).error === INSUFFICIENT_SCOPE_ERROR
  );
}

/**
 * The id-shaped arguments of a call, preserved under `metadata.params`.
 *
 * Mirrors the REST hook's `metadata.params` (the route's path ids) as closely
 * as this surface allows: MCP has no path/body split, so "the ids in the call"
 * is the closest analogue, and selecting `id` / `*_id` keys with scalar values
 * is a MECHANICAL rule that cannot drift as tool schemas change.
 *
 * Free-text arguments (`title`, `description`, `content`, `assignee`) never
 * match, which preserves the REST hook's deliberate refusal to copy request
 * bodies into the audit table.
 */
export function pickIdArgs(args: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'id' && !key.endsWith('_id')) {
      continue;
    }
    if (typeof value === 'number' || typeof value === 'string') {
      params[key] = value;
    }
  }
  return params;
}

/** `resource_id` for one call, per {@link McpAuditTarget.resourceIdArg}. */
function readResourceId(args: Record<string, unknown>, idArg: string | null): string | null {
  if (idArg === null) {
    return null;
  }
  const raw = args[idArg];
  return raw === undefined || raw === null ? null : String(raw);
}

/**
 * Action-specific detail. `outcome` is this surface's analogue of the REST
 * hook's `metadata.status`: it is how an applied mutation is distinguished
 * from one the service rejected. `errorCode` is the JSON-RPC error code only —
 * deliberately NOT the message, which can echo user-supplied text.
 */
function buildAuditMetadata(
  audit: McpAuditContext,
  args: Record<string, unknown>,
  result: ToolOutcome,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    surface: 'mcp',
    outcome: result.outcome,
    authMethod: mcpAuthMethodForPath(audit.resolutionPath),
  };
  if (audit.resolutionPath !== undefined) {
    metadata['resolutionPath'] = audit.resolutionPath;
  }
  if (result.outcome === 'error') {
    metadata['errorCode'] = result.errorCode;
  }
  const params = pickIdArgs(args);
  if (Object.keys(params).length > 0) {
    metadata['params'] = params;
  }
  return metadata;
}

/**
 * Append the row for one completed tool call. NEVER throws — a failing audit
 * sink must not become a failing tool call — but always logs at ERROR level
 * when it drops a row, because a dropped audit row is itself a security event.
 */
function recordToolCall(
  audit: McpAuditContext,
  tool: MutatingToolName,
  args: Record<string, unknown>,
  requestId: string | null,
  result: ToolOutcome,
): void {
  try {
    // No principal → nothing to attribute the action to. Same early return as
    // the REST hook's `request.user === null` case.
    if (audit.actorUserId === null) {
      return;
    }
    const target = MCP_AUDIT_TARGETS[tool];
    audit.repository.append({
      actorType: mcpActorTypeForPath(audit.resolutionPath),
      // TEXT column: `users.id` is numeric, other actor kinds may not be.
      actorId: String(audit.actorUserId),
      tokenId: audit.tokenId,
      action: buildMcpAuditAction(tool),
      resourceType: target.resourceType,
      resourceId: readResourceId(args, target.resourceIdArg),
      requestId,
      metadata: buildAuditMetadata(audit, args, result),
    });
  } catch (err) {
    const log =
      audit.log ??
      ((payload: Record<string, unknown>): void => {
        console.error(JSON.stringify(payload));
      });
    log({
      level: 'error',
      event: 'audit.append_failed',
      surface: 'mcp',
      tool,
      requestId,
      outcome: result.outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Structural view of `McpServer.registerTool` used to install the wrapper.
 *
 * The SDK method is generic over its input/output Zod shapes, which the
 * wrapper is deliberately agnostic to — it forwards the handler's arguments
 * untouched. Erasing the generics to `unknown` here (and casting once at each
 * boundary in {@link installMcpAuditTrail}) keeps the erasure to two lines
 * instead of threading unusable type parameters through the wrapper.
 */
type ToolRegistrar = (
  name: string,
  config: { inputSchema?: unknown },
  cb: (...callArgs: unknown[]) => unknown,
) => unknown;

/** Reads `extra.requestId` (the JSON-RPC request id) if the SDK supplied one. */
function readRequestId(extra: unknown): string | null {
  if (typeof extra !== 'object' || extra === null) {
    return null;
  }
  const raw = (extra as { requestId?: unknown }).requestId;
  return raw === undefined || raw === null ? null : String(raw);
}

/**
 * Make `server` audit every mutating tool registered on it from now on.
 *
 * MUST be called BEFORE any `register*Tools(server, ...)` call — it works by
 * replacing `server.registerTool`, so a tool registered earlier is not
 * wrapped. `createMcpServer` calls it on the line after `new McpServer(...)`
 * for exactly that reason.
 *
 * Why interception rather than a call in each of the thirteen handlers: one
 * wrapper cannot forget a tool. A per-handler call would be a second,
 * hand-maintained enumeration of the mutating set — the exact drift the
 * #1631 gate map exists to prevent.
 */
export function installMcpAuditTrail(server: McpServer, audit: McpAuditContext): void {
  const register = server.registerTool.bind(server) as unknown as ToolRegistrar;

  const patched: ToolRegistrar = (name, config, cb) => {
    if (!isMutatingTool(name)) {
      return register(name, config, cb);
    }
    // Tools declaring an `inputSchema` are called `(args, extra)`; tools
    // without one are called `(extra)`. Both forms are forwarded verbatim.
    const takesArgs = config.inputSchema !== undefined;

    const wrapped = async (...callArgs: unknown[]): Promise<unknown> => {
      const rawArgs = takesArgs ? callArgs[0] : undefined;
      const args =
        typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
      const requestId = readRequestId(takesArgs ? callArgs[1] : callArgs[0]);

      try {
        const result = await cb(...callArgs);
        recordToolCall(audit, name, args, requestId, { outcome: 'ok' });
        return result;
      } catch (error) {
        // A scope refusal performed no mutation — see the module note on
        // refusal semantics. Everything else got past authorization and IS an
        // attempted action, so it is recorded with `outcome: 'error'`.
        if (!isInsufficientScopeError(error)) {
          recordToolCall(audit, name, args, requestId, {
            outcome: 'error',
            errorCode: error instanceof McpError ? error.code : null,
          });
        }
        throw error;
      }
    };

    return register(name, config, wrapped);
  };

  server.registerTool = patched as unknown as McpServer['registerTool'];
}
