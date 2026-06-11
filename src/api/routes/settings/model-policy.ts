import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ModelPolicyNullableSchema } from '../../../schemas/model-policy.schema.js';

/**
 * Configurable Task Models (Task 13) — GET|PUT /api/v1/settings/model-policy
 *
 * The database-wide model-policy DEFAULT (the `app_settings.model_policy_default`
 * column, owned by task #916's `SettingsService`). A project without its own
 * `model_policy` inherits this default; `resolve_model` falls back to it.
 *
 * - GET → 200 with the current default (`ModelPolicy | null`; `null` when unset).
 * - PUT with a valid `ModelPolicy` (or `null` to clear) → 200, echoing the
 *   stored policy back. An invalid body is rejected with 400 by the Zod body
 *   validator at the boundary (never reaches the service / a 500).
 *
 * Auth: inherits the standard `/api/v1` auth chain (the parent plugin is
 * mounted inside the `/api/v1` scope that wires `authPlugin`). No custom guard.
 */
const modelPolicyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // GET /settings/model-policy — read the global default.
  fastify.get(
    '/model-policy',
    {
      schema: {
        tags: ['settings'],
        description:
          'Get the database-wide model-policy default. Returns the stored ' +
          '`ModelPolicy`, or `null` when no default is configured.',
        response: {
          200: ModelPolicyNullableSchema,
        },
      },
    },
    async (_request, reply) => {
      const policy = fastify.settingsService.getModelPolicyDefault();
      return reply.send(policy);
    },
  );

  // PUT /settings/model-policy — set (or, with `null`, clear) the global default.
  // The body schema validates the shape; an invalid policy is a 400 at the
  // boundary rather than a 500 from the service's own parse.
  fastify.put(
    '/model-policy',
    {
      schema: {
        tags: ['settings'],
        description:
          'Set the database-wide model-policy default. Body is a `ModelPolicy` ' +
          '(or `null` to clear). An invalid policy shape yields 400.',
        body: ModelPolicyNullableSchema,
        response: {
          200: ModelPolicyNullableSchema,
        },
      },
    },
    async (request, reply) => {
      // A literal `null` JSON body (clear the default) arrives as `undefined`
      // — Fastify treats `null` as "no body". Normalise it back to `null` so
      // the clear path persists SQL NULL rather than tripping the service's
      // non-null Zod parse. A non-null body has already passed the
      // `ModelPolicyNullableSchema` body validator (invalid → 400 upstream).
      const policy = request.body ?? null;
      fastify.settingsService.setModelPolicyDefault(policy);
      // Echo the validated body back. `request.body` has already been parsed
      // through `ModelPolicyNullableSchema` by the route's body validator —
      // the SAME canonical shape the service just persisted — so re-reading +
      // re-validating the singleton row here was a redundant round-trip
      // (task #931). A write failure throws before this line.
      return reply.send(policy);
    },
  );
};

export default modelPolicyRoutes;
