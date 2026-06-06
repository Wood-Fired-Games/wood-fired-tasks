import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ValueCharterNullableSchema } from '../../../schemas/project.schema.js';
import { ProjectCharterHistoryRepository } from '../../../repositories/project-charter-history.repository.js';
import { ErrorResponseSchema } from '../tasks/schemas.js';
import { WsjfComponentsSchema, WsjfEvidenceSchema } from '../../../schemas/wsjf.schema.js';
import { rankFrontier } from '../../../services/wsjf.service.js';
import type { RankDeps } from '../../../services/wsjf.service.js';
import { WsjfHistoryRepository } from '../../../repositories/wsjf-history.repository.js';
import { WsjfRescoreRepository } from '../../../repositories/wsjf-rescore.repository.js';
import { ProjectRepository } from '../../../repositories/project.repository.js';
import { TaskRepository } from '../../../repositories/task.repository.js';
import { DependencyRepository } from '../../../repositories/dependency.repository.js';
import { TopologyService } from '../../../services/topology.service.js';
import { WsjfRescoreService } from '../../../services/wsjf-rescore.service.js';
import type { RescoreSubmission } from '../../../services/wsjf-rescore.service.js';
import { WsjfHealthService } from '../../../services/wsjf-health.service.js';
import type { ScoreSubmission } from '../../../services/wsjf.service.js';
import { requireUser } from '../../plugins/auth/index.js';

/**
 * WSJF 4.5 (task #645) — REST surface for a project's WSJF audit history:
 * the value-charter version snapshots and the deterministic rescore runs.
 *
 * Routes (mounted under the `/api/v1/projects` scope by the parent
 * `projectRoutes` plugin, so they inherit the standard auth chain):
 *
 *   GET /:id/charter-history → the append-only `project_charter_history`
 *                              snapshots, oldest-first (chronological). Each row
 *                              is the PRIOR charter that was replaced when the
 *                              interview bumped to `interview_version`.
 *   GET /:id/rescore-runs    → the project's `wsjf_rescore_run` rows,
 *                              oldest-first by `triggered_at`. Each row carries
 *                              the rollup counts (evaluated / changed /
 *                              skipped-locked) and the human summary.
 *
 * The charter-history reader constructs a `ProjectCharterHistoryRepository` over
 * the decorated `fastify.db` handle — that repository is the exclusive owner of
 * the table's read shape (it parses the JSON `charter` column).
 *
 * The rescore-run reader is a read-only projection of `wsjf_rescore_run`. The
 * `WsjfRescoreRepository` owns that table's WRITE lifecycle (open / finalize) but
 * does not yet expose a project-scoped reader, and this surface task is scoped to
 * the route + CLI layer only (it does not extend the repository). The query is a
 * single bounded, parameterized SELECT — no writes, no raw user SQL.
 */

/** One charter-history snapshot row. */
const CharterHistoryRowSchema = z.object({
  id: z.number(),
  project_id: z.number(),
  interview_version: z.number(),
  charter: ValueCharterNullableSchema,
  change_kind: z.string().nullable(),
  actor_type: z.string().nullable(),
  actor_id: z.string().nullable(),
  changed_at: z.string(),
});

const CharterHistoryResponseSchema = z.object({
  project_id: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  history: z.array(CharterHistoryRowSchema),
});

/** One rescore-run row. */
const RescoreRunRowSchema = z.object({
  id: z.number(),
  project_id: z.number(),
  triggered_at: z.string(),
  charter_version: z.number().nullable(),
  actor_type: z.string().nullable(),
  actor_id: z.string().nullable(),
  tasks_evaluated: z.number().nullable(),
  tasks_changed: z.number().nullable(),
  tasks_skipped_locked: z.number().nullable(),
  summary: z.string().nullable(),
});

const RescoreRunsResponseSchema = z.object({
  project_id: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  runs: z.array(RescoreRunRowSchema),
});

// ── WSJF 1.10 remote-parity schemas (wsjf-ranking / wsjf-health / rescore) ──

/** One propagation edge: γ-decayed downstream Cost-of-Delay contribution. */
const PropagationEdgeSchema = z.object({
  dependentId: z.number(),
  contribution: z.number(),
});

/** One ranked task row (mirrors `RankedTask` from wsjf.service.ts). */
const RankedTaskSchema = z.object({
  taskId: z.number(),
  scored: z.boolean(),
  baseWsjf: z.number().nullable(),
  effectiveWsjf: z.number(),
  components: WsjfComponentsSchema.nullable(),
  propagation: z.array(PropagationEdgeSchema),
  evidence: WsjfEvidenceSchema.nullable(),
});

const WsjfRankingResponseSchema = z.object({
  project_id: z.number().int().positive(),
  scope: z.enum(['frontier', 'all']),
  total: z.number().int().nonnegative(),
  ranking: z.array(RankedTaskSchema),
});

/** One health finding (mirrors `HealthFinding` from wsjf-health.service.ts). */
const HealthFindingSchema = z.object({
  check: z.enum([
    'degenerate-spread',
    'cod-no-anchor',
    'job-size-collapsed',
    'stale-time-criticality',
    'high-fallback-ratio',
    'score-churn',
  ]),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string(),
  suggestion: z.string(),
  taskIds: z.array(z.number()),
});

const WsjfHealthResponseSchema = z.object({
  project_id: z.number().int().positive(),
  healthy: z.boolean(),
  scored_task_count: z.number().int().nonnegative(),
  findings: z.array(HealthFindingSchema),
});

/**
 * POST /:id/rescore body. Mirrors the stdio `rescore_project` inputSchema
 * (`src/mcp/tools/wsjf-tools.ts`): a loosely-typed `submissions[]` whose per-task
 * `classification` / `features` are validated by the SAME deterministic gate the
 * service runs (`validateScoreSubmission`), NOT re-implemented here. Structural
 * malformation (non-positive task_id, non-object classification/features) is
 * rejected at the schema boundary → 400; contradictory-but-well-formed payloads
 * surface as per-task `errors[]` in the 200 body (byte-identical to stdio).
 */
const RescoreRequestSchema = z
  .object({
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
  })
  .strict();

/** Per-task rescore outcome (mirrors `RescoreTaskResult`). */
const RescoreTaskResultSchema = z.object({
  taskId: z.number(),
  changed: z.boolean(),
  skippedLocked: z.array(z.string()),
  components: WsjfComponentsSchema,
  prevWsjfScore: z.number().nullable(),
  newWsjfScore: z.number(),
});

const RescoreResponseSchema = z.object({
  run_id: z.number(),
  project_id: z.number().int().positive(),
  tasks_evaluated: z.number().int().nonnegative(),
  tasks_changed: z.number().int().nonnegative(),
  tasks_skipped_locked: z.number().int().nonnegative(),
  results: z.array(RescoreTaskResultSchema),
  errors: z.array(z.object({ taskId: z.number(), errors: z.array(z.string()) })),
});

interface RescoreRunDbRow {
  id: number;
  project_id: number;
  triggered_at: string;
  charter_version: number | null;
  actor_type: string | null;
  actor_id: string | null;
  tasks_evaluated: number | null;
  tasks_changed: number | null;
  tasks_skipped_locked: number | null;
  summary: string | null;
}

const projectWsjfRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // GET /:id/charter-history — chronological charter snapshots.
  fastify.get(
    '/:id/charter-history',
    {
      schema: {
        tags: ['projects'],
        description:
          "Return a project's append-only value-charter history, oldest-first " +
          '(chronological). Each row is the PRIOR charter snapshot that was ' +
          'replaced when the interview bumped to `interview_version`.',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: CharterHistoryResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Existence guard → 404 ProblemDetails on a missing project.
      fastify.projectService.getProject(request.params.id);
      const charterHistoryRepo = new ProjectCharterHistoryRepository(fastify.db);
      const history = charterHistoryRepo.findByProjectId(request.params.id);
      return reply.send({
        project_id: request.params.id,
        total: history.length,
        history,
      });
    },
  );

  // GET /:id/rescore-runs — chronological rescore runs.
  fastify.get(
    '/:id/rescore-runs',
    {
      schema: {
        tags: ['projects'],
        description:
          "Return a project's deterministic WSJF rescore runs, oldest-first " +
          '(chronological by `triggered_at`). Each row carries the rollup ' +
          'counts (evaluated / changed / skipped-locked) and a human summary.',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: RescoreRunsResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Existence guard → 404 ProblemDetails on a missing project.
      fastify.projectService.getProject(request.params.id);
      const runs = fastify.db
        .prepare(
          `SELECT id, project_id, triggered_at, charter_version, actor_type,
                  actor_id, tasks_evaluated, tasks_changed, tasks_skipped_locked,
                  summary
             FROM wsjf_rescore_run
            WHERE project_id = ?
            ORDER BY triggered_at ASC, id ASC`,
        )
        .all(request.params.id) as RescoreRunDbRow[];
      return reply.send({
        project_id: request.params.id,
        total: runs.length,
        runs,
      });
    },
  );

  // GET /:id/wsjf-ranking — propagation-adjusted WSJF ranking.
  //
  // Remote parity for the stdio `wsjf_ranking` tool. Delegates to
  // `rankFrontier(projectId, scope, rankDeps)`. The RankDeps bundle is built the
  // same way `createMcpServer` builds it: the already-decorated TopologyService
  // + DependencyService, plus a TaskRepository over the decorated `fastify.db`
  // (db-backed repos are stateless prepared-statement holders). No DB is touched
  // outside a service/repository that owns it.
  fastify.get(
    '/:id/wsjf-ranking',
    {
      schema: {
        tags: ['projects'],
        description:
          "Rank a project's tasks by propagation-adjusted WSJF. " +
          '`scope=frontier` (default) excludes not-ready/blocked tasks; ' +
          '`scope=all` ranks every task. Returns an ordered list (descending ' +
          'effective WSJF), each entry carrying its components, base vs ' +
          'effective WSJF, and the downstream Cost-of-Delay propagation ' +
          'breakdown. Identical to the stdio `wsjf_ranking` tool.',
        params: z.object({ id: z.coerce.number().int().positive() }),
        querystring: z.object({
          scope: z.enum(['frontier', 'all']).optional(),
        }),
        response: {
          200: WsjfRankingResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Existence guard → 404 ProblemDetails on a missing project.
      fastify.projectService.getProject(request.params.id);
      const scope = request.query.scope ?? 'frontier';
      const rankDeps: RankDeps = {
        topology: fastify.topologyService,
        dependency: fastify.dependencyService,
        tasks: new TaskRepository(fastify.db),
      };
      const ranking = await rankFrontier(request.params.id, scope, rankDeps);
      return reply.send({
        project_id: request.params.id,
        scope,
        total: ranking.length,
        ranking,
      });
    },
  );

  // GET /:id/wsjf-health — degeneracy / pitfall linter.
  //
  // Remote parity for the stdio `wsjf_health` tool. Delegates to
  // `WsjfHealthService.check(projectId)` (pure read). The service is constructed
  // from the decorated `fastify.db` via the same task repo + append-only history
  // reader the rest of the WSJF surface shares.
  fastify.get(
    '/:id/wsjf-health',
    {
      schema: {
        tags: ['projects'],
        description:
          "Lint a project's WSJF state for degeneracies and pitfalls " +
          '(non-blocking, pure read). Reports near-identical scores, a missing ' +
          'Cost-of-Delay `1` anchor, a collapsed Job Size distribution, ' +
          'past-deadline stale Time Criticality, a high priority-fallback ' +
          'ratio, and score-churn. Each finding carries a severity, message, ' +
          'and suggested fix. Empty findings ⇔ healthy. Identical to the stdio ' +
          '`wsjf_health` tool.',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: WsjfHealthResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Existence guard → 404 ProblemDetails on a missing project.
      fastify.projectService.getProject(request.params.id);
      const healthService = new WsjfHealthService({
        tasks: new TaskRepository(fastify.db),
        history: new WsjfHistoryRepository(fastify.db),
      });
      const report = healthService.check(request.params.id);
      return reply.send({
        project_id: report.projectId,
        healthy: report.healthy,
        scored_task_count: report.scoredTaskCount,
        findings: report.findings,
      });
    },
  );

  // POST /:id/rescore — deterministic project rescore (MUTATION).
  //
  // Remote parity for the stdio `rescore_project` tool. Delegates to
  // `WsjfRescoreService.rescore(projectId, submissions, opts)`. The service is
  // the EXCLUSIVE owner of the rescore-run + history + component write
  // lifecycle (all committed in one transaction over the shared `fastify.db`);
  // the route never touches those tables directly. Per-task validation failures
  // are returned in `errors[]` (200) exactly as the stdio tool does; structural
  // malformation is rejected by the body schema (→ 400). Auth: inherits the
  // standard projects-route chain; `requireUser` attributes the run/history
  // rows to the authenticated principal when no explicit actor is supplied.
  fastify.post(
    '/:id/rescore',
    {
      schema: {
        tags: ['projects'],
        description:
          "Deterministically rescore a project's already-scored tasks against " +
          'its current value charter. Accepts written-back classifications ' +
          '(one per task), recomputes the four WSJF components, opens a rescore ' +
          'run, writes one append-only history row per changed task linked by ' +
          'the run id, and SKIPS per-component locked values. Returns a run ' +
          'summary with evaluated / changed / skipped-locked counts and any ' +
          'per-task validation errors. Identical to the stdio `rescore_project` ' +
          'tool.',
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: RescoreRequestSchema,
        response: {
          200: RescoreResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Existence guard → 404 ProblemDetails on a missing project.
      fastify.projectService.getProject(request.params.id);
      const rescoreService = new WsjfRescoreService({
        db: fastify.db,
        tasks: new TaskRepository(fastify.db),
        projects: new ProjectRepository(fastify.db),
        history: new WsjfHistoryRepository(fastify.db),
        runs: new WsjfRescoreRepository(fastify.db),
        topology:
          fastify.topologyService ??
          new TopologyService(new TaskRepository(fastify.db), new DependencyRepository(fastify.db)),
      });
      const submissions: RescoreSubmission[] = request.body.submissions.map((s) => ({
        taskId: s.task_id,
        submission: {
          classification: s.classification,
          features: s.features,
        } as unknown as ScoreSubmission,
      }));
      const result = rescoreService.rescore(request.params.id, submissions, {
        // Default attribution to the authenticated user when the caller does
        // not pin an explicit actor (mirrors the manual-override write path).
        actorType: request.body.actor_type ?? 'user',
        actorId: request.body.actor_id ?? String(requireUser(request).id),
      });
      return reply.send({
        run_id: result.runId,
        project_id: result.projectId,
        tasks_evaluated: result.tasksEvaluated,
        tasks_changed: result.tasksChanged,
        tasks_skipped_locked: result.tasksSkippedLocked,
        results: result.results,
        errors: result.errors,
      });
    },
  );
};

export default projectWsjfRoutes;
