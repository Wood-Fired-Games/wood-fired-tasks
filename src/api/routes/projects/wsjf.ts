import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ValueCharterNullableSchema } from '../../../schemas/project.schema.js';
import { ProjectCharterHistoryRepository } from '../../../repositories/project-charter-history.repository.js';
import { ErrorResponseSchema } from '../tasks/schemas.js';

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
};

export default projectWsjfRoutes;
