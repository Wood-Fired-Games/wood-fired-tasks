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
//
// ─── Phase 29 Plan 07 — content negotiation on POST ────────────────────────
// The HTML form at /me/tokens posts here with Accept: text/html. We branch
// at handler entry:
//   • prefersHtml === true  → validate CSRF, mint via the SAME path as JSON
//                             callers, stash the full token in the
//                             session.mintedToken flash, 303 to /me/tokens.
//   • prefersHtml === false → existing JSON behavior (201 + body, no CSRF).
// The JSON path is UNCHANGED — Phase 28 tests still pass — because the
// content-negotiation branch only fires when the client prefers HTML AND
// is form-encoded (the JSON-API callers and existing me-tokens tests send
// Accept: */* or application/json with JSON body).
// ────────────────────────────────────────────────────────────────────────────
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireUser } from '../../plugins/auth.js';
import { generateToken } from '../../../services/pat-hash.js';
import { verifyCsrfToken } from '../auth/csrf.js';

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
  // `token` carries the full `wft_pat_...` value EXACTLY ONCE — the only
  // surface that ever sees the plaintext after mint. Annotated so the
  // generated OpenAPI doc carries the warning to API consumers.
  token: z.string().describe('Returned exactly once at creation time; cannot be retrieved later.'),
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

// Phase 30 Plan 30-03 — 400 response shape for DELETE /tokens/active when
// the caller's auth method does not carry a tokenId (session or legacy).
// The route returns this body with guidance to use the /:id endpoint.
const NoTokenIdResponseSchema = z.object({
  error: z.literal('NO_TOKEN_ID'),
  message: z.string(),
});

const SessionRequiredResponseSchema = z.object({
  error: z.literal('session_required'),
  message: z.string(),
});

// Phase 29 Plan 07 — additional error response shapes for the HTML branch
// and the manual JSON-body validation. Declared so the route's response
// schema covers 400 + 403 csrf_invalid cleanly (Zod type provider rejects
// returning a code not declared in the response map).
const CsrfInvalidResponseSchema = z.object({
  error: z.literal('csrf_invalid'),
});
const ValidationFailedResponseSchema = z.object({
  error: z.literal('validation_failed'),
});
const BadRequestResponseSchema = z.object({
  statusCode: z.literal(400),
  error: z.string(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Content-negotiation helper (Phase 29 Plan 07)
// ---------------------------------------------------------------------------

/**
 * True when the request's Accept header prefers `text/html` over
 * `application/json`. "Prefers" = text/html appears AND either JSON is
 * absent OR text/html appears earlier in the header (positional priority
 * — q-value parsing is overkill for the two consumers we care about:
 * browsers send `text/html,application/xhtml+xml,application/xml;q=0.9,...`
 * and the JSON-API callers send `application/json` or `*\/*`).
 *
 * Accept-header check ONLY — the Content-Type check is done at the call
 * site (see `isFormEncodedBody` below). WR-01: keeping the two checks
 * separate so each is testable on its own; the handler ANDs them when
 * choosing the HTML branch.
 */
function prefersHtmlResponse(acceptHeader: string | undefined): boolean {
  if (!acceptHeader) return false;
  const htmlIdx = acceptHeader.indexOf('text/html');
  if (htmlIdx === -1) return false;
  const jsonIdx = acceptHeader.indexOf('application/json');
  return jsonIdx === -1 || htmlIdx < jsonIdx;
}

/**
 * True when the request body is form-encoded
 * (`application/x-www-form-urlencoded`). Used together with
 * `prefersHtmlResponse` at the POST mint handler so a JSON caller
 * cannot inadvertently (or maliciously) trigger the HTML branch by
 * sending `Accept: text/html` with a JSON body — WR-01 in 29-REVIEW.md.
 *
 * The check is `.includes(...)` to tolerate the `; charset=utf-8`
 * parameter form browsers occasionally append.
 */
function isFormEncodedBody(contentType: string | undefined): boolean {
  return (
    typeof contentType === 'string' && contentType.includes('application/x-www-form-urlencoded')
  );
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const tokensRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // -------------------------------------------------------------------------
  // POST / — mint
  // -------------------------------------------------------------------------
  //
  // ─── Phase 29 Plan 07 ───
  // Two consumer profiles share this endpoint:
  //   1. JSON API (existing): Accept: application/json + JSON body. The
  //      Zod body schema validates; CSRF is skipped (sessionOnly already
  //      enforces session auth; legitimate JSON callers are page-inline
  //      AJAX or external scripts authenticating via a session cookie).
  //   2. HTML form (new): Accept: text/html + application/x-www-form-urlencoded.
  //      The handler validates CSRF (constant-time), re-parses the form
  //      body through the SAME MintTokenBodySchema, mints via the SAME
  //      repository path, stashes the full token in session.mintedToken
  //      (flash), and 303-redirects to /me/tokens.
  //
  // Branch order: HTML check is FIRST so the JSON path's Zod body parser
  // never runs on form-encoded input (Zod would reject because `scopes`
  // arrives as a CSV string, not an array — see formScopes parsing below).
  // Schema declaration below is intentional: it documents the JSON
  // contract for /docs/json and keeps the JSON path's automatic
  // validation behavior.
  // ─── end Phase 29 Plan 07 ───
  fastify.route({
    method: 'POST',
    url: '/',
    config: { sessionOnly: true },
    schema: {
      tags: ['me-tokens'],
      description:
        'Mint a new Personal Access Token. The full `wft_pat_...` token ' +
        'is returned EXACTLY ONCE in the response body — store it ' +
        'securely; it cannot be retrieved later.',
      // No body schema declared at the route level: the HTML branch runs
      // BEFORE Zod, and the JSON branch validates manually below so both
      // consumers share the same MintTokenBodySchema source-of-truth.
      response: {
        201: MintTokenResponseSchema,
        // 400 covers both the manual JSON Zod-fail AND the HTML branch's
        // validation_failed envelope. The two shapes share `error: string`
        // so the union below is the simplest typing.
        400: z.union([BadRequestResponseSchema, ValidationFailedResponseSchema]),
        // 403 carries TWO shapes: the chain's session_required gate AND
        // the HTML branch's csrf_invalid. Zod type provider needs both.
        403: z.union([SessionRequiredResponseSchema, CsrfInvalidResponseSchema]),
      },
    },
    handler: async (request, reply) => {
      // ─── Phase 29 Plan 07: HTML branch ───
      // WR-01 fix: require BOTH `Accept: text/html` AND
      // `Content-Type: application/x-www-form-urlencoded`. A JSON-API
      // caller that spoofs Accept (deliberately or accidentally) must
      // not slip into the HTML branch — its JSON body would not parse
      // as a form payload and the CSRF check would reject anyway, but
      // the early gate keeps the security boundary explicit.
      if (
        prefersHtmlResponse(request.headers.accept) &&
        isFormEncodedBody(request.headers['content-type'])
      ) {
        const body = (request.body ?? {}) as {
          _csrf?: unknown;
          name?: unknown;
          scopes?: unknown;
          expiresAt?: unknown;
        };
        if (!verifyCsrfToken(request, body._csrf)) {
          return reply
            .header('Cache-Control', 'no-store')
            .code(403)
            .send({ error: 'csrf_invalid' });
        }
        // formbody supplies strings; coerce `scopes` (csv) → array,
        // `expiresAt` (datetime-local string) → ISO-8601. Empty fields
        // become `undefined` so the optional schema fields stay optional.
        const formScopes =
          typeof body.scopes === 'string' && body.scopes.length > 0
            ? body.scopes
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
            : undefined;
        let formExpiresAt: string | undefined;
        if (typeof body.expiresAt === 'string' && body.expiresAt.length > 0) {
          const d = new Date(body.expiresAt);
          if (Number.isNaN(d.getTime())) {
            return reply
              .header('Cache-Control', 'no-store')
              .code(400)
              .send({ error: 'validation_failed' });
          }
          formExpiresAt = d.toISOString();
        }
        const parsed = MintTokenBodySchema.safeParse({
          name: body.name,
          scopes: formScopes,
          expiresAt: formExpiresAt,
        });
        if (!parsed.success) {
          return reply
            .header('Cache-Control', 'no-store')
            .code(400)
            .send({ error: 'validation_failed' });
        }
        const htmlUser = requireUser(request);
        const minted = generateToken();
        const scopesJsonHtml = JSON.stringify(parsed.data.scopes ?? []);
        const htmlRow = fastify.apiTokenRepository.insert({
          userId: htmlUser.id,
          name: parsed.data.name,
          prefix: minted.prefix,
          suffix: minted.suffix,
          hash: minted.hash,
          scopes: scopesJsonHtml,
          expiresAt: parsed.data.expiresAt ?? null,
        });
        request.session.set('mintedToken', {
          id: htmlRow.id,
          token: minted.token,
        });
        return reply
          .header('Cache-Control', 'no-store')
          .redirect(`/me/tokens?just_minted=${htmlRow.id}`, 303);
      }
      // ─── end Phase 29 Plan 07 ───

      // JSON branch (unchanged Phase 28 contract).
      const jsonParsed = MintTokenBodySchema.safeParse(request.body);
      if (!jsonParsed.success) {
        return reply.code(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Invalid request body',
        });
      }
      const user = requireUser(request);
      const { token, prefix, suffix, hash } = generateToken();
      const scopesJson = JSON.stringify(jsonParsed.data.scopes ?? []);
      const row = fastify.apiTokenRepository.insert({
        userId: user.id,
        name: jsonParsed.data.name,
        prefix,
        suffix,
        hash,
        scopes: scopesJson,
        expiresAt: jsonParsed.data.expiresAt ?? null,
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
  });

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
  // DELETE /active — self-revoke (Phase 30 Plan 30-03)
  // -------------------------------------------------------------------------
  //
  // The ONE PAT-revoke endpoint that is NOT sessionOnly. Accepts Bearer auth
  // (and only Bearer auth) so `tasks logout` — which only holds a PAT — can
  // revoke itself. Session and legacy callers get a 400 with guidance to
  // use the existing `/:id` route.
  //
  // Security tradeoff (locked decision, 30-03-PLAN.md `truths`):
  //   - A PAT can revoke ITSELF via /tokens/active. This is intentional and
  //     does NOT enable privilege escalation: the caller already proved
  //     possession of the secret to authenticate; letting them invalidate
  //     it is strictly weakening their own access.
  //   - A PAT CANNOT revoke OTHER PATs. The /:id route below stays
  //     sessionOnly to preserve the Phase 28 contract ("PATs can't revoke
  //     PATs"). The /active route narrows revoke() to `request.tokenId`,
  //     so cross-PAT revocation is structurally impossible — even if a
  //     malicious caller forged a tokenId in their request, the auth chain
  //     repopulates `request.tokenId` from the verified Bearer hash before
  //     the handler runs (T-30-03-04).
  //
  // CRITICAL: registered BEFORE the /:id route. Otherwise Fastify's radix
  // tree matches `/active` against the `/:id` param route first and this
  // handler is unreachable. The `8. existing /:id route still works for
  // numeric ids` test guards against accidental re-ordering.
  fastify.delete(
    '/active',
    {
      // NO `config: { sessionOnly: true }` — explicitly Bearer-accepting.
      schema: {
        tags: ['me-tokens'],
        description:
          'Revoke the Personal Access Token used to authenticate THIS ' +
          'request. The only PAT-revoke endpoint that accepts Bearer auth ' +
          '(every other /me/tokens route is session-only). Returns 204 on ' +
          'success; 400 with `{ error: "NO_TOKEN_ID" }` when the caller ' +
          'authenticated via session or legacy X-API-Key (no token to ' +
          'revoke — use DELETE /api/v1/me/tokens/:id instead).',
        response: {
          204: z.null().describe('No content'),
          400: NoTokenIdResponseSchema,
          404: NotFoundResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const tokenId = request.tokenId;
      if (tokenId === null) {
        return reply.code(400).send({
          error: 'NO_TOKEN_ID' as const,
          message:
            'This endpoint only accepts PAT-authenticated callers; ' +
            'session and legacy callers should use DELETE ' +
            '/api/v1/me/tokens/:id.',
        });
      }
      // Repository.revoke is keyed on (tokenId, userId); ownership is
      // enforced at SQL even though the chain already guarantees it.
      // Defense-in-depth: if revoke returns false (already revoked, or —
      // structurally impossible — ownership mismatch), respond 404 with
      // the same NOT_FOUND envelope as the /:id route.
      const success = fastify.apiTokenRepository.revoke(tokenId, user.id);
      if (!success) {
        return reply.code(404).send({
          error: 'NOT_FOUND' as const,
          message: 'Token not found.',
        });
      }
      return reply.code(204).send(null);
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
      const success = fastify.apiTokenRepository.revoke(request.params.id, user.id);
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
