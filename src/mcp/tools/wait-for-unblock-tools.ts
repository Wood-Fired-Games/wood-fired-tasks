import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toStructuredContent } from '../lib/structured-content.js';
import { z } from 'zod';
import { TaskService } from '../../services/task.service.js';
import { convertToMcpError } from '../errors.js';
import { eventBus } from '../../events/event-bus.js';
import { subscribeOnce, TimeoutError } from '../../events/subscribe-once.js';

/** Default long-poll deadline (seconds) when the caller omits `timeout_seconds`. */
const DEFAULT_TIMEOUT_SECONDS = 300;
/** Hard ceiling (seconds); larger requests are clamped down to this. */
const MAX_TIMEOUT_SECONDS = 1800;

/**
 * Register the `wait_for_unblock` MCP tool (task #455).
 *
 * Long-polls (blocks) until a task transitions `blocked → open`, then returns
 * the fresh task projection. Wraps {@link subscribeOnce} over the in-process
 * EventBus singleton, listening for `task.status_changed` events emitted by
 * `TaskService.updateTask` (see src/services/task.service.ts:283-292).
 *
 * IN-PROCESS SCOPE (verified, task #455 acceptance #2): `subscribeOnce`
 * listens on the in-process `eventBus` singleton. The MCP server holds the
 * same in-process `TaskService` that mutates tasks (src/mcp/index.ts builds
 * both from `createApp`), and `TaskService` imports that same `eventBus`
 * singleton. So the workflow-engine auto-unblock cascade
 * (`updateTask(id,{status:'open'},'workflow')`) emits on the very bus this
 * tool subscribes to. This tool therefore ONLY observes transitions that
 * happen in the SAME PROCESS as the MCP server — cross-session / cross-process
 * wake-ups are the wft-router SSE recipe's domain (contrast documented in
 * docs/MCP.md and task #456). A remote/REST-proxy MCP server would NOT see
 * these in-process events and could not resolve this tool.
 *
 * Return shapes (exactly one):
 *   - `{ status: "unblocked"; task }`          — the blocked→open transition fired.
 *   - `{ status: "already_unblocked"; task }`  — task was not `blocked` at call time.
 *   - `{ status: "timeout"; task_id; waited_seconds }` — deadline hit (NO throw;
 *     subscribeOnce's TimeoutError is caught and converted to this envelope).
 *
 * Authorization: identical to `get_task` — we call `taskService.getTask(id)`
 * and let `convertToMcpError` surface the same NotFoundError → InvalidRequest
 * McpError for unknown / inaccessible ids. There is no separate auth check in
 * `get_task`; the service read IS the authorization boundary, so an
 * unauthorized caller gets the exact same error envelope `get_task` produces.
 */
export function registerWaitForUnblockTools(
  server: McpServer,
  taskService: TaskService,
): void {
  server.registerTool(
    'wait_for_unblock',
    {
      description:
        'Long-poll until a task transitions blocked -> open, then return the ' +
        'fresh task projection. Resolves immediately with status ' +
        '"already_unblocked" if the task is not currently blocked. Returns ' +
        'status "timeout" (no error) if the deadline elapses first. ' +
        'timeout_seconds defaults to 300, is clamped to [1, 1800], and the ' +
        'applied value is echoed back as applied_timeout_seconds. NOTE: only ' +
        'observes in-process status transitions (same process as the MCP ' +
        'server); cross-process wake-ups use the SSE event stream instead.',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        timeout_seconds: z.number().int().positive().optional(),
      }),
    },
    async (args) => {
      try {
        const requested = args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
        // Clamp to [1, MAX]. Zod already rejects <=0 / non-int, so the lower
        // bound is defensive; the upper bound is the real clamp the caller
        // sees via applied_timeout_seconds.
        const appliedTimeoutSeconds = Math.min(
          Math.max(1, requested),
          MAX_TIMEOUT_SECONDS,
        );

        // Race handling (acceptance #3): SUBSCRIBE FIRST, then re-check the
        // current status. A blocked->open transition could land in the tiny
        // window between "read status" and "subscribe"; subscribing first
        // guarantees we never miss it. We use an AbortController so that, if
        // the re-check shows the task is already non-blocked, we tear the
        // subscription down immediately (already_unblocked fast path) rather
        // than leaking a listener until the deadline.
        const abortController = new AbortController();
        const waitPromise = subscribeOnce(
          eventBus,
          'task.status_changed',
          (event) => {
            // The static TaskEvent type does not expose from/to (they are
            // attached via an `as any` cast at the emit site,
            // task.service.ts:283-292), so narrow with a local cast.
            const m = event.metadata as { from?: string; to?: string };
            return (
              event.data.id === args.task_id &&
              m.from === 'blocked' &&
              m.to === 'open'
            );
          },
          { timeoutMs: appliedTimeoutSeconds * 1000, signal: abortController.signal },
        );

        // Now (after subscribing) read the current projection. This both
        // authorizes the caller (same boundary as get_task — throws
        // NotFoundError for unknown ids) and tells us whether we even need to
        // wait.
        const current = taskService.getTask(args.task_id);
        if (current.status !== 'blocked') {
          // Not blocked at call time: abort the just-created subscription and
          // return the already_unblocked envelope. Swallow the resulting
          // AbortError — it is an expected control-flow signal, not a failure.
          abortController.abort();
          waitPromise.catch(() => {
            /* expected AbortError from the teardown above */
          });
          const payload = {
            status: 'already_unblocked' as const,
            task: current,
            applied_timeout_seconds: appliedTimeoutSeconds,
          };
          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} is not blocked (status: ${current.status}); returning immediately.`,
              },
            ],
            structuredContent: toStructuredContent(payload),
          };
        }

        // Task is blocked: wait for the transition or the deadline.
        try {
          await waitPromise;
          // Re-read the fresh projection rather than trusting the event
          // payload, so the caller always gets the current canonical task.
          const fresh = taskService.getTask(args.task_id);
          const payload = {
            status: 'unblocked' as const,
            task: fresh,
            applied_timeout_seconds: appliedTimeoutSeconds,
          };
          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} transitioned blocked -> open (status: ${fresh.status}).`,
              },
            ],
            structuredContent: toStructuredContent(payload),
          };
        } catch (err) {
          if (err instanceof TimeoutError) {
            // Deadline hit: convert to the timeout envelope. NO exception is
            // thrown for timeout (acceptance criterion). The subscribeOnce
            // helper has already torn down its listener.
            const payload = {
              status: 'timeout' as const,
              task_id: args.task_id,
              waited_seconds: appliedTimeoutSeconds,
              applied_timeout_seconds: appliedTimeoutSeconds,
            };
            return {
              content: [
                {
                  type: 'text',
                  text: `Timed out after ${appliedTimeoutSeconds}s waiting for task ${args.task_id} to unblock.`,
                },
              ],
              structuredContent: toStructuredContent(payload),
            };
          }
          // Any other rejection (e.g. AbortError, predicate throw) is genuine
          // — surface it through the standard MCP error mapping.
          throw err;
        }
      } catch (error) {
        throw convertToMcpError(error);
      }
    },
  );
}
