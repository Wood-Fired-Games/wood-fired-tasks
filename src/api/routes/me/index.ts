// Phase 28 Plan 28-05 — /me barrel module.
//
// Registers all per-caller resource routes under the /me prefix.
//   Phase 28: /me/tokens
//   Phase 30 Plan 30-03: GET /me profile (this plan) — registered with an
//     empty prefix so the route resolves to /api/v1/me exactly.
//
// Registration order: `profileRoutes` BEFORE `tokensRoutes` so the profile
// route claims `GET /` at the /me prefix. The two plugins do not collide
// (different methods/paths) but keeping the more-specific (`/tokens/*`)
// nested AFTER the bare `/` is the conventional Fastify ordering.
import type { FastifyPluginAsync } from 'fastify';
import profileRoutes from './profile.js';
import tokensRoutes from './tokens.js';

const meRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(profileRoutes);
  await fastify.register(tokensRoutes, { prefix: '/tokens' });
};

export default meRoutes;
