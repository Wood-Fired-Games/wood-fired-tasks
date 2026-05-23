/**
 * Phase 29 Plan 06 — POST /auth/logout (stub; full impl in Task 3).
 *
 * Placeholder so `src/api/routes/auth/index.ts` registers cleanly while
 * Tasks 2 and 3 are in flight. The Task 3 commit replaces this body
 * with the real CSRF-checked + RP-initiated-logout implementation.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { AuthRoutesOptions } from './index.js';

const logoutRoute: FastifyPluginAsync<AuthRoutesOptions> = async (fastify) => {
  fastify.post(
    '/logout',
    { config: { skipAuth: true } },
    async (_request, reply) => {
      // Task 3 will replace this with the real implementation.
      return reply.code(501).send({ error: 'not_implemented' });
    },
  );
};

export default logoutRoute;
