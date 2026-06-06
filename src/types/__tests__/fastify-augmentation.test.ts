// Type-level smoke tests for the Phase 28 Fastify module augmentations.
//
// Asserts that `src/types/fastify.d.ts` correctly merges into the ambient
// `fastify` module declarations so that:
//   - `request.user`, `request.authMethod`, `request.tokenId` are typed (and
//     NON-optional — Phase 28 `decorateRequest` calls initialize them to null).
//   - Route `config: { skipAuth, sessionOnly }` accepts booleans and rejects
//     other shapes.
//   - The Phase 27 `request.apiKeyLabel` augmentation in
//     `src/api/plugins/auth.ts` still merges (declaration merging across
//     files).
//
// Bodies are intentionally type-only; the assertions run at compile time.

import { describe, it, expectTypeOf } from 'vitest';
import Fastify, { type FastifyRequest, type RouteOptions } from 'fastify';
import type { AuthenticatedUser, AuthMethod } from '../identity.js';

describe('FastifyRequest augmentation', () => {
  it('user is AuthenticatedUser | null (NON-optional)', () => {
    expectTypeOf<FastifyRequest['user']>().toEqualTypeOf<AuthenticatedUser | null>();
  });

  it('authMethod is AuthMethod | null (NON-optional)', () => {
    expectTypeOf<FastifyRequest['authMethod']>().toEqualTypeOf<AuthMethod | null>();
  });

  it('tokenId is number | null (NON-optional)', () => {
    expectTypeOf<FastifyRequest['tokenId']>().toEqualTypeOf<number | null>();
  });

  it('apiKeyLabel from Phase 27 augmentation still compiles', () => {
    // The auth.ts augmentation declares `apiKeyLabel?: string` — merging
    // means it must be assignable from `string | undefined`.
    expectTypeOf<FastifyRequest['apiKeyLabel']>().toEqualTypeOf<string | undefined>();
  });
});

describe('FastifyContextConfig augmentation', () => {
  it('accepts skipAuth: true on a route config (positive)', () => {
    const server = Fastify();
    server.route({
      method: 'GET',
      url: '/health',
      config: { skipAuth: true },
      handler: async () => ({ ok: true }),
    });
  });

  it('accepts sessionOnly: true on a route config (positive)', () => {
    const server = Fastify();
    server.route({
      method: 'POST',
      url: '/api/v1/me/tokens',
      config: { sessionOnly: true },
      handler: async () => ({ ok: true }),
    });
  });

  it('rejects non-boolean skipAuth (negative)', () => {
    const server = Fastify();
    server.route({
      method: 'GET',
      url: '/x',
      // @ts-expect-error — `skipAuth: 'yes'` is a string, must be boolean.
      config: { skipAuth: 'yes' },
      handler: async () => ({ ok: true }),
    });
    void server;
  });

  it('typed RouteOptions.config exposes skipAuth + sessionOnly', () => {
    type Config = NonNullable<RouteOptions['config']>;
    expectTypeOf<Config['skipAuth']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Config['sessionOnly']>().toEqualTypeOf<boolean | undefined>();
  });
});
