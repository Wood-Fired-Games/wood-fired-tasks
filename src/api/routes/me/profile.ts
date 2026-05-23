// Phase 30 Plan 30-03 — GET /api/v1/me profile route.
//
// Backs `tasks whoami`. Accepts ANY chain strategy (session, PAT, legacy) —
// NO `config: { sessionOnly: true }`. The auth-chain `preHandler` runs first
// and populates `request.user`; if no credentials are presented the chain
// emits 401 before this handler runs.
//
// Response shape (locked in 30-03-PLAN.md):
//   { id, displayName, email, isLegacy, isServiceAccount }
// plus `authenticatedAt: <ISO-8601>` ONLY when session-authed. The
// `authenticatedAt` value persists in the session payload as epoch ms (set by
// the OIDC callback at src/api/routes/auth/callback.ts:209) — we convert to
// ISO at the boundary so the public surface is human-readable AND
// language-agnostic.
//
// The Zod response schema is the public-leakage gate: unknown columns (e.g.
// `oidc_sub`, `oidc_provider`, `slack_user_id`, `disabled_at`) on the
// underlying users row never survive serialization — fastify-type-provider-zod
// strips fields not present in the schema. This is Threat T-30-03-03's
// primary mitigation; tests in profile.test.ts case 6 assert the envelope is
// minimal under every auth method.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireUser } from '../../plugins/auth.js';

const MeResponseSchema = z.object({
  id: z.number().int(),
  displayName: z.string(),
  email: z.string().nullable(),
  isLegacy: z.boolean(),
  isServiceAccount: z.boolean(),
  // ISO-8601 timestamp; present ONLY when the chain matched the session
  // strategy. PAT and legacy callers have no `authenticatedAt` because the
  // auth event for them is per-request, not session-bounded.
  authenticatedAt: z.string().datetime().optional(),
});

/**
 * Read `request.session.get('authenticatedAt')` defensively. The session
 * decorator is OPTIONAL — when `SESSION_COOKIE_SECRET` is unset (OIDC-disabled
 * mode) `request.session` is undefined entirely. Returns the epoch-ms value
 * when present, or `undefined` for non-session-authed callers.
 */
function readSessionAuthenticatedAt(request: {
  session?: { get: (key: 'authenticatedAt') => unknown };
}): number | undefined {
  const value = request.session?.get('authenticatedAt');
  return typeof value === 'number' ? value : undefined;
}

const profileRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/',
    {
      // No `config: { sessionOnly: true }` — this endpoint accepts session,
      // PAT, and legacy callers (CLI-04 requires PAT support).
      schema: {
        tags: ['me'],
        description:
          "Return the authenticated caller's identity. Accepts session, " +
          "Personal Access Token (Bearer), or legacy `X-API-Key` auth. The " +
          'response envelope is minimal by design — internal columns ' +
          '(provider, sub, etc.) NEVER leak.',
        response: {
          200: MeResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const authenticatedAtMs = readSessionAuthenticatedAt(request);
      const body: z.infer<typeof MeResponseSchema> = {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        isLegacy: user.isLegacy,
        isServiceAccount: user.isServiceAccount,
      };
      // Convert epoch-ms → ISO-8601 ONLY when the session payload supplied
      // it (session-authed branch). Bearer/legacy callers get a body
      // WITHOUT the field, matching the schema's `.optional()`.
      if (authenticatedAtMs !== undefined) {
        body.authenticatedAt = new Date(authenticatedAtMs).toISOString();
      }
      return reply.code(200).send(body);
    },
  );
};

export default profileRoutes;
