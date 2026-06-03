import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  WsjfComponentsSchema,
  WsjfEvidenceSchema,
  WsjfLocksSchema,
  WsjfSourceSchema,
  WsjfClassificationSchema,
  WsjfFeaturesSchema,
} from '../../../schemas/wsjf.schema.js';
import { WsjfHistoryRepository } from '../../../repositories/wsjf-history.repository.js';
import { ErrorResponseSchema } from './schemas.js';
import { requireUser } from '../../plugins/auth/index.js';
import type { Task, WsjfWriteDTO } from '../../../types/task.js';

/**
 * Project a stored task onto the WSJF read response. `components` is non-null
 * only when all four component columns are present (the all-four-or-none rule);
 * the explicit re-read of each column inside the guard keeps TS narrowing the
 * `Fib | null` columns to `Fib`.
 */
function projectWsjf(task: Task): z.infer<typeof WsjfReadResponseSchema> {
  const v = task.wsjf_value;
  const tc = task.wsjf_time_criticality;
  const ro = task.wsjf_risk_opportunity;
  const js = task.wsjf_job_size;
  const scored = v !== null && tc !== null && ro !== null && js !== null;
  return {
    task_id: task.id,
    scored,
    components:
      v !== null && tc !== null && ro !== null && js !== null
        ? { value: v, timeCriticality: tc, riskOpportunity: ro, jobSize: js }
        : null,
    evidence: task.wsjf_evidence,
    locked: task.wsjf_locked,
    source: task.wsjf_source,
    classifications: task.wsjf_classifications,
    features: task.wsjf_features,
  };
}

/**
 * WSJF 4.5 (task #645) — REST surface for a task's WSJF components, evidence,
 * locks, and append-only score history.
 *
 * Routes (mounted under the `/api/v1/tasks` scope by the parent `taskRoutes`
 * plugin, so they inherit the standard auth chain):
 *
 *   GET  /:id/wsjf           → read the task's persisted components + the
 *                              evidence / locks / source / classification /
 *                              features metadata (all NULL for an unscored task).
 *   PUT  /:id/wsjf           → set / lock components. This is the MANUAL-override
 *                              write path: it delegates to
 *                              `taskService.updateTask({ wsjf: { ..., manual:true }})`
 *                              which runs the SAME `validateManualScore` gate the
 *                              MCP / direct-service write paths use (enum + the
 *                              shared cross-component contradiction rule). The
 *                              route does NOT re-implement validation — a bad
 *                              payload surfaces as the service's `ValidationError`
 *                              → 400 ProblemDetails, byte-for-byte the MCP gate.
 *   GET  /:id/score-history  → the append-only `wsjf_score_history` timeline,
 *                              oldest-first (chronological), each row carrying the
 *                              server-computed components, the classification /
 *                              features behind them, the trigger, and provenance.
 *
 * The component write funnels through `taskService.updateTask`, so the
 * component column write and its `wsjf_score_history` audit row commit in one
 * transaction (the no-bypass invariant). The history reader constructs a
 * `WsjfHistoryRepository` over the already-decorated `fastify.db` handle — the
 * repository is the exclusive owner of that table's read shape (it parses the
 * JSON columns), so the route never touches raw SQL.
 */

/** Read projection of a task's persisted WSJF state. */
const WsjfReadResponseSchema = z.object({
  task_id: z.number().int().positive(),
  scored: z.boolean(),
  components: WsjfComponentsSchema.nullable(),
  evidence: WsjfEvidenceSchema.nullable(),
  locked: WsjfLocksSchema.nullable(),
  source: WsjfSourceSchema.nullable(),
  classifications: WsjfClassificationSchema.nullable(),
  features: WsjfFeaturesSchema.nullable(),
});

/**
 * PUT body: the four components (required together — all-four-or-none) plus the
 * optional evidence / locks / source metadata. `manual` is forced server-side so
 * the write always goes through the manual gate; clients cannot smuggle the
 * classified-path trigger.
 */
const WsjfWriteRequestSchema = WsjfComponentsSchema.extend({
  evidence: WsjfEvidenceSchema.optional().nullable(),
  locked: WsjfLocksSchema.optional().nullable(),
  source: WsjfSourceSchema.optional().nullable(),
}).strict();

/** One score-history row as returned by GET /:id/score-history. */
const ScoreHistoryRowSchema = z.object({
  id: z.number(),
  task_id: z.number(),
  project_id: z.number(),
  changed_at: z.string(),
  trigger: z.string(),
  actor_type: z.string().nullable(),
  actor_id: z.string().nullable(),
  charter_version: z.number().nullable(),
  rescore_run_id: z.number().nullable(),
  value: z.number().nullable(),
  time_criticality: z.number().nullable(),
  risk_opportunity: z.number().nullable(),
  job_size: z.number().nullable(),
  classifications: WsjfClassificationSchema.nullable(),
  features: WsjfFeaturesSchema.nullable(),
  evidence: WsjfEvidenceSchema.nullable(),
  source: WsjfSourceSchema.nullable(),
  locked: WsjfLocksSchema.nullable(),
  wsjf_score: z.number().nullable(),
  prev_wsjf_score: z.number().nullable(),
});

const ScoreHistoryResponseSchema = z.object({
  task_id: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  history: z.array(ScoreHistoryRowSchema),
});

const taskWsjfRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // GET /:id/wsjf — read persisted components + metadata.
  fastify.get(
    '/:id/wsjf',
    {
      schema: {
        tags: ['tasks'],
        description:
          "Read a task's persisted WSJF components plus the evidence, lock, " +
          'source, classification, and feature metadata. All fields are NULL ' +
          'for an unscored task (`scored:false`).',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: WsjfReadResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // getTask throws NotFoundError → 404 ProblemDetails when absent.
      const task = fastify.taskService.getTask(request.params.id);
      return reply.send(projectWsjf(task));
    },
  );

  // PUT /:id/wsjf — set / lock components (manual-override gate).
  fastify.put(
    '/:id/wsjf',
    {
      schema: {
        tags: ['tasks'],
        description:
          "Set a task's WSJF components and (optionally) lock individual " +
          'components against future rescores. This is the MANUAL-override path: ' +
          'it runs the same enum + cross-component contradiction gate ' +
          '(`validateManualScore`) the MCP / direct-service write paths use, and ' +
          'audits the write with a `manual` score-history row. A contradiction ' +
          '(e.g. jobSize=1 with value=13) or an off-scale tier returns 400.',
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: WsjfWriteRequestSchema,
        response: {
          200: WsjfReadResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const wsjf: WsjfWriteDTO = {
        value: body.value,
        timeCriticality: body.timeCriticality,
        riskOpportunity: body.riskOpportunity,
        jobSize: body.jobSize,
        evidence: body.evidence ?? null,
        locked: body.locked ?? null,
        source: body.source ?? null,
        // Forced server-side: REST component writes are manual overrides and
        // MUST go through `validateManualScore` (enum + contradiction). The
        // service stamps the history row `trigger='manual'`.
        manual: true,
      };
      // updateTask runs the manual gate; a ValidationError → 400, NotFound → 404.
      const updated = fastify.taskService.updateTask(
        request.params.id,
        { wsjf },
        'user',
        requireUser(request).id,
      );
      return reply.send(projectWsjf(updated));
    },
  );

  // GET /:id/score-history — append-only timeline, oldest-first.
  fastify.get(
    '/:id/score-history',
    {
      schema: {
        tags: ['tasks'],
        description:
          "Return a task's append-only WSJF score-history timeline, " +
          'oldest-first (chronological). Each row carries the server-computed ' +
          'components, the classification / features behind them, the trigger, ' +
          'and the actor / charter / rescore-run provenance.',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: ScoreHistoryResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Existence guard → 404 on a missing task (an empty history would
      // otherwise be indistinguishable from "task does not exist").
      fastify.taskService.getTask(request.params.id);
      const historyRepo = new WsjfHistoryRepository(fastify.db);
      const history = historyRepo.findByTaskId(request.params.id);
      return reply.send({
        task_id: request.params.id,
        total: history.length,
        history,
      });
    },
  );
};

export default taskWsjfRoutes;
