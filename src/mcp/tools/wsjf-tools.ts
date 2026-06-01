import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { convertToMcpError } from '../errors.js';
import { rankFrontier } from '../../services/wsjf.service.js';
import type { RankDeps, ScoreSubmission } from '../../services/wsjf.service.js';
import type { IWsjfHistoryRepository } from '../../repositories/wsjf-history.repository.js';
import type {
  WsjfRescoreService,
  RescoreSubmission,
} from '../../services/wsjf-rescore.service.js';

/**
 * Collaborators the WSJF MCP tools need.
 *
 * - `rank` is the {@link RankDeps} bundle (topology + dependency + task repo)
 *   `rankFrontier` consumes; it is constructed once in `createMcpServer` and
 *   threaded in so this module performs no construction of its own.
 * - `history` is the append-only `wsjf_score_history` reader for `wsjf_history`.
 *
 * Task #641 (wsjf-rescore) ADDS `rescore_project` to this same registrar after
 * this task lands — when it needs more collaborators it extends THIS interface
 * (e.g. a `rescore` service) rather than changing the registration signature.
 */
export interface WsjfToolDeps {
  rank: RankDeps;
  history: IWsjfHistoryRepository;
  /**
   * Task #641 (wsjf-rescore): the deterministic project rescore engine backing
   * `rescore_project`. Optional so the dozens of pre-#641 callers that build a
   * `WsjfToolDeps` bundle without it keep working — when omitted, the
   * `rescore_project` tool is simply not registered (mirrors how
   * `topology_check` is conditionally registered in `createMcpServer`).
   */
  rescore?: WsjfRescoreService;
}

/** The four WSJF component keys whose history deltas `wsjf_history` reports. */
const COMPONENT_KEYS = [
  'value',
  'time_criticality',
  'risk_opportunity',
  'job_size',
  'wsjf_score',
] as const;

/**
 * Register all WSJF-related MCP tools.
 *
 * Registers:
 * - `wsjf_ranking(project_id, scope)` — frontier-ordered {@link RankedTask}
 *   results, each carrying the propagation breakdown (γ-decayed downstream
 *   Cost-of-Delay contributions). Pure read; nothing is persisted.
 * - `wsjf_history(task_id)` — the append-only score-history timeline for a
 *   task, each entry annotated with the from→to delta of every component
 *   (and the WSJF score) versus the previous entry.
 *
 * Structured `errors[]` / domain errors flow through {@link convertToMcpError}
 * so callers get the same McpError shape as every other tool group.
 *
 * @param server the MCP server to register tools on.
 * @param deps   the {@link WsjfToolDeps} collaborators (RankDeps + history repo).
 */
export function registerWsjfTools(
  server: McpServer,
  deps: WsjfToolDeps,
): void {
  // -------------------------------------------------------------------------
  // Tool: wsjf_ranking
  // -------------------------------------------------------------------------
  server.registerTool(
    'wsjf_ranking',
    {
      description:
        'Rank a project\'s tasks by propagation-adjusted WSJF (Weighted Shortest ' +
        'Job First). `scope="frontier"` (default) excludes not-ready/blocked tasks; ' +
        '`scope="all"` ranks every task. Returns an ordered list (descending ' +
        'effective WSJF) where each entry carries its components, base vs effective ' +
        'WSJF, and the downstream Cost-of-Delay `propagation` breakdown.',
      inputSchema: z.object({
        project_id: z.number().int().positive(),
        scope: z.enum(['frontier', 'all']).optional(),
      }),
    },
    async (args) => {
      try {
        const scope = args.scope ?? 'frontier';
        const ranking = await rankFrontier(args.project_id, scope, deps.rank);

        const summary = [
          `Ranked ${ranking.length} task(s) for project ${args.project_id} (scope=${scope}):\n`,
        ];
        ranking.forEach((r, idx) => {
          summary.push(
            `${idx + 1}. [${r.taskId}] effectiveWsjf=${r.effectiveWsjf.toFixed(3)}` +
              (r.scored ? ` (scored, base=${r.baseWsjf?.toFixed(3)})` : ' (unscored)'),
          );
        });

        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: {
            project_id: args.project_id,
            scope,
            ranking,
          } as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: wsjf_history
  // -------------------------------------------------------------------------
  server.registerTool(
    'wsjf_history',
    {
      description:
        'Return the append-only WSJF score-history timeline for a task ' +
        '(oldest-first). Each entry carries the server-computed components, the ' +
        'classification/features behind them, the trigger, and a `deltas` map ' +
        'reporting the from→to change of every component (and the WSJF score) ' +
        'versus the previous entry (null `from` on the first scoring).',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const rows = deps.history.findByTaskId(args.task_id);

        // Annotate each row with the from→to delta of every component versus
        // the immediately-preceding row (oldest-first, so prev = rows[i-1]).
        const timeline = rows.map((row, i) => {
          const prev = i > 0 ? rows[i - 1] : null;
          const deltas: Record<string, { from: number | null; to: number | null }> = {};
          for (const key of COMPONENT_KEYS) {
            const to = (row as unknown as Record<string, number | null>)[key] ?? null;
            const from = prev
              ? (prev as unknown as Record<string, number | null>)[key] ?? null
              : null;
            deltas[key] = { from, to };
          }
          return { ...row, deltas };
        });

        const summary = [
          `Task ${args.task_id} has ${timeline.length} WSJF history entr${
            timeline.length === 1 ? 'y' : 'ies'
          }:\n`,
        ];
        timeline.forEach((entry) => {
          const s = entry.deltas.wsjf_score;
          summary.push(
            `- ${entry.changed_at} [${entry.trigger}] wsjf ${
              s.from === null ? '∅' : s.from
            }→${s.to === null ? '∅' : s.to}`,
          );
        });

        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: {
            task_id: args.task_id,
            timeline,
          } as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: rescore_project — Task #641 (WSJF 4.1)
  //
  // Only registered when a rescore engine is wired into the deps bundle
  // (`deps.rescore`). Deterministically re-evaluates a project's scored tasks
  // against the CURRENT charter using the caller's written-back classifications,
  // opens one `wsjf_rescore_run`, links every changed task's history row by
  // `rescore_run_id`, SKIPS locked components, and returns a run summary.
  // -------------------------------------------------------------------------
  if (deps.rescore) {
    const rescoreService = deps.rescore;
    server.registerTool(
      'rescore_project',
      {
        description:
          'Deterministically rescore a project\'s already-scored tasks against ' +
          'its current value charter. Accepts written-back classifications ' +
          '(one per task), recomputes the four WSJF components, opens a rescore ' +
          'run, writes one append-only history row per changed task linked by ' +
          'the run id, and SKIPS per-component locked values. Returns a run ' +
          'summary with evaluated / changed / skipped-locked counts and any ' +
          'per-task validation errors.',
        inputSchema: z.object({
          project_id: z.number().int().positive(),
          submissions: z
            .array(
              z.object({
                task_id: z.number().int().positive(),
                classification: z.record(z.string(), z.unknown()),
                features: z.record(z.string(), z.unknown()),
              }),
            )
            .default([]),
          actor_type: z.string().optional(),
          actor_id: z.string().optional(),
        }),
      },
      async (args) => {
        try {
          const submissions: RescoreSubmission[] = args.submissions.map((s) => ({
            taskId: s.task_id,
            submission: {
              classification: s.classification,
              features: s.features,
            } as unknown as ScoreSubmission,
          }));

          const result = rescoreService.rescore(args.project_id, submissions, {
            actorType: args.actor_type ?? null,
            actorId: args.actor_id ?? null,
          });

          const summary = [
            `Rescore run ${result.runId} for project ${result.projectId}: ` +
              `${result.tasksEvaluated} evaluated, ${result.tasksChanged} changed, ` +
              `${result.tasksSkippedLocked} with locked components preserved.`,
          ];
          if (result.errors.length > 0) {
            summary.push(`\n${result.errors.length} task(s) had validation errors:`);
            for (const e of result.errors) {
              summary.push(`- [${e.taskId}] ${e.errors.join('; ')}`);
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: summary.join('\n'),
              },
            ],
            structuredContent: {
              run_id: result.runId,
              project_id: result.projectId,
              tasks_evaluated: result.tasksEvaluated,
              tasks_changed: result.tasksChanged,
              tasks_skipped_locked: result.tasksSkippedLocked,
              results: result.results,
              errors: result.errors,
            } as unknown as { [x: string]: unknown },
          };
        } catch (error) {
          throw convertToMcpError(error);
        }
      },
    );
  }
}
