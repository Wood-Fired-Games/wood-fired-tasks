// Phase 28 Plan 28-05 — /me barrel module.
//
// Registers all per-caller resource routes under the /me prefix. Phase 28
// only ships /me/tokens; future phases (29: /me/sessions; later:
// /me/profile, /me/preferences) extend this module without changing the
// server.ts wiring.
import type { FastifyPluginAsync } from 'fastify';
import tokensRoutes from './tokens.js';

const meRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(tokensRoutes, { prefix: '/tokens' });
};

export default meRoutes;
