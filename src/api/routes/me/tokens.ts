// Phase 28 Plan 28-05 — PAT lifecycle routes under /api/v1/me/tokens.
//
// All three routes carry `config: { sessionOnly: true }` so the auth-chain
// plugin's enforceSessionOnly gate rejects PAT-authed callers with 403
// `{ error: 'session_required', message: '...' }`. Locked decision:
// PATs CANNOT mint, list, or revoke PATs — the bootstrap path is the
// `tasks db mint-token` CLI (Plan 28-07).
//
// Response contracts (locked in 28-CONTEXT.md):
//   POST   /api/v1/me/tokens         — 201 + MintTokenResponse (token field
//                                       Returned exactly once at creation
//                                       time; cannot be retrieved later.)
//   GET    /api/v1/me/tokens         — 200 + TokenListItem[] (NO hash, NO
//                                       token plaintext; newest-first by
//                                       repository ORDER BY created_at DESC)
//   DELETE /api/v1/me/tokens/:id     — 204 No Content on success; 404
//                                       `{ error: 'NOT_FOUND' }` on both
//                                       "doesn't exist" AND "belongs to
//                                       another user" (no existence leak,
//                                       Threat T-28-05-02).
//
// The handlers all start with `const user = requireUser(request);`. The
// auth-chain enforceSessionOnly gate already runs BEFORE the handler, so
// when the handler is reached `request.user` is non-null AND
// `request.authMethod === 'session'`. `requireUser` is a defensive
// narrowing helper (throws if the chain misconfigured the route).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireUser } from '../../plugins/auth.js';
import { generateToken } from '../../../services/pat-hash.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// WR-02 (Phase 28 review) — bounded scopes prevent a session-authed caller
// from POSTing `{ name: "x", scopes: [<<1 MB of strings>>] }` and inflating
// the persisted `scopes` TEXT column (which then surfaces verbatim on every
// subsequent `GET /me/tokens` response). Caps reflect the advisory-only
// nature of scopes in v1.6 — 32 distinct scopes of ≤64 chars each is more
// headroom than any realistic deployment will use. `name` keeps its
// existing 100-char cap.
const MintTokenBodySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string().min(1).max(64)).max(32).optional(),
  // ISO-8601 timestamp; persisted verbatim so the auth chain's
  // `new Date(expires_at).getTime()` comparison works.
  expiresAt: z.string().datetime().optional(),
});

const MintTokenResponseSchema = z.object({
  id: z.number().int(),
  // `token` carries the full `wfb_pat_...` value EXACTLY ONCE — the only
  // surface that ever sees the plaintext after mint. Annotated so the
  // generated OpenAPI doc carries the warning to API consumers.
  token: z
    .string()
    .describe(
      'Returned exactly once at creation time; cannot be retrieved later.',
    ),
  name: z.string(),
  prefix: z.string(),
  suffix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

const TokenListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  prefix: z.string(),
  suffix: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
const TokenListResponseSchema = z.array(TokenListItemSchema);

const RevokeParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const NotFoundResponseSchema = z.object({
  error: z.literal('NOT_FOUND'),
  message: z.string(),
});

const SessionRequiredResponseSchema = z.object({
  error: z.literal('session_required'),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const tokensRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // -------------------------------------------------------------------------
  // POST / — mint
  // -------------------------------------------------------------------------
  fastify.post(
    '/',
    {
      config: { sessionOnly: true },
      schema: {
        tags: ['me-tokens'],
        description:
          'Mint a new Personal Access Token. The full `wfb_pat_...` token ' +
          'is returned EXACTLY ONCE in the response body — store it ' +
          'securely; it cannot be retrieved later.',
        body: MintTokenBodySchema,
        response: {
          201: MintTokenResponseSchema,
          403: SessionRequiredResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { token, prefix, suffix, hash } = generateToken();
      const scopesJson = JSON.stringify(request.body.scopes ?? []);
      const row = fastify.apiTokenRepository.insert({
        userId: user.id,
        name: request.body.name,
        prefix,
        suffix,
        hash,
        scopes: scopesJson,
        expiresAt: request.body.expiresAt ?? null,
      });
      return reply.code(201).send({
        id: row.id,
        token,
        name: row.name,
        prefix: row.prefix,
        suffix: row.suffix,
        scopes: JSON.parse(row.scopes) as string[],
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET / — list
  // -------------------------------------------------------------------------
  fastify.get(
    '/',
    {
      config: { sessionOnly: true },
      schema: {
        tags: ['me-tokens'],
        description:
          "List the caller's Personal Access Tokens. Returns metadata only " +
          '— the `hash` and `token` plaintext are NEVER exposed after mint.',
        response: {
          200: TokenListResponseSchema,
          403: SessionRequiredResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const rows = fastify.apiTokenRepository.listByUser(user.id);
      // Explicit field projection — do NOT spread the row. The `hash`
      // column MUST never leak to the response (Threat T-28-05-03).
      const items = rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        suffix: r.suffix,
        scopes: JSON.parse(r.scopes) as string[],
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        revokedAt: r.revoked_at,
        expiresAt: r.expires_at,
      }));
      return reply.code(200).send(items);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /:id — revoke
  // -------------------------------------------------------------------------
  fastify.delete(
    '/:id',
    {
      config: { sessionOnly: true },
      schema: {
        tags: ['me-tokens'],
        description:
          "Revoke one of the caller's Personal Access Tokens. Returns 204 " +
          "on success. Returns 404 with `{ error: 'NOT_FOUND' }` for both " +
          'unknown ids AND tokens belonging to other users — the response ' +
          'body is intentionally identical to avoid existence-leak ' +
          '(Threat T-28-05-02).',
        params: RevokeParamsSchema,
        response: {
          204: z.null().describe('No content'),
          403: SessionRequiredResponseSchema,
          404: NotFoundResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const success = fastify.apiTokenRepository.revoke(
        request.params.id,
        user.id,
      );
      if (!success) {
        return reply.code(404).send({
          error: 'NOT_FOUND' as const,
          message: 'Token not found.',
        });
      }
      return reply.code(204).send(null);
    },
  );
};

export default tokensRoutes;
