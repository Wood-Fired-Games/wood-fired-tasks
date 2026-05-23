/**
 * Phase 29 Plan 06 — shared test harness for the /auth/login + /auth/callback
 * + /auth/logout integration tests.
 *
 * Why a dedicated helper module: all three test files mount the SAME minimal
 * Fastify stack — cookie + secure-session + formbody + the authRoutes
 * plugin — against the SAME nock-mocked discovery/JWKS/token-endpoint
 * fixture from `tests/helpers/oidc-fixtures.ts`. Centralizing the setup
 * keeps test cases focused on the route behavior rather than wiring.
 *
 * The harness deliberately does NOT use `createServer({ dbPath: ':memory:' })`
 * because that pulls in /api/v1, /health, Slack, SSE, rate-limit, swagger,
 * etc. — far more surface than these focused unit tests need. Instead we
 * stand up a clean Fastify instance with just the plugins under test plus
 * a real in-memory SQLite for the upsert path.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import fastifyFormbody from '@fastify/formbody';
import { randomBytes } from 'node:crypto';
import nock from 'nock';
import type Database from 'better-sqlite3';

import authRoutes from '../index.js';
import { initOidc } from '../../../../services/oidc-client.js';
import { UserRepository } from '../../../../repositories/user.repository.js';
import { initDatabase } from '../../../../db/database.js';
import { runMigrations } from '../../../../db/migrate.js';
import { SESSION_LIFETIME_SECONDS } from '../../../../web/session-constants.js';
import {
  getDiscoveryFixture,
  installOidcInterceptors,
  mintIdToken,
} from '../../../../../tests/helpers/oidc-fixtures.js';
import type { Config } from '../../../../config/env.js';

const ISSUER = 'https://accounts.example.com';
export const CLIENT_ID = 'test-client-id.example.com';
const CLIENT_SECRET = 'test-client-secret';
export const REDIRECT_URI = 'https://wfb.example.com/auth/callback';
export const SCOPES = 'openid email profile';

declare module 'fastify' {
  // The harness decorates the test server with `userRepository` so the
  // callback handler's `fastify.userRepository` lookup resolves. The
  // canonical augmentation lives in src/types/fastify.d.ts — adding it
  // here would conflict, so we rely on the existing declaration.
}

function makeEnv(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'test',
    OIDC_ISSUER_URL: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_REDIRECT_URI: REDIRECT_URI,
    OIDC_SCOPES: SCOPES,
    ...overrides,
  } as unknown as Config;
}

export interface AuthTestHarness {
  server: FastifyInstance;
  db: Database.Database;
  userRepository: UserRepository;
  close: () => Promise<void>;
}

/**
 * Stand up a Fastify instance wired with:
 *   - @fastify/cookie
 *   - @fastify/secure-session (32-byte random key generated per call)
 *   - @fastify/formbody
 *   - authRoutes plugin under prefix `/auth`
 *   - userRepository decoration backed by a real in-memory SQLite
 *
 * Discovery is intercepted by nock so initOidc resolves to a real
 * Configuration without touching the network. The caller MUST install
 * any token-endpoint interceptors BEFORE driving a `/auth/callback`
 * request (use `installOidcInterceptors` from tests/helpers/oidc-fixtures.ts).
 *
 * Probe routes are pre-mounted (e.g. /_test/handshake, /_test/who) so
 * tests can inspect the session contents without violating Fastify's
 * "no routes after ready" rule (#3097 equivalent at the test boundary).
 */
export async function mountAuthRoutes(
  opts: { discoveryOverride?: Record<string, unknown> } = {},
): Promise<AuthTestHarness> {
  nock.disableNetConnect();

  // Discovery interceptor must be installed before initOidc runs.
  const discoveryDoc = opts.discoveryOverride ?? getDiscoveryFixture();
  nock(ISSUER)
    .get('/.well-known/openid-configuration')
    .reply(200, discoveryDoc);

  const oidcConfig = await initOidc(makeEnv());
  if (!oidcConfig) {
    throw new Error('oidc-test-setup: initOidc returned null unexpectedly');
  }

  const server = Fastify();

  // In-memory database wired through the same UserRepository production uses.
  const db = initDatabase(':memory:');
  await runMigrations(db);
  const userRepository = new UserRepository(db);
  server.decorate('userRepository', userRepository);
  // The chain plugin's other decoration; some plugins (auth chain) read it.
  // Not strictly required for these focused tests but keeps the type happy.
  // We pass a stub apiTokenRepository because the auth chain is NOT mounted
  // in this harness — these tests only exercise /auth/* routes which carry
  // config.skipAuth and would short-circuit the chain anyway.
  server.decorate('apiTokenRepository', {} as never);

  await server.register(fastifyCookie);
  await server.register(fastifySecureSession, {
    sessionName: 'session',
    cookieName: 'wfb_session',
    // 32-byte sodium key, fresh per call for test isolation.
    key: randomBytes(32),
    expiry: SESSION_LIFETIME_SECONDS,
    cookie: {
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: SESSION_LIFETIME_SECONDS,
    },
  });
  await server.register(fastifyFormbody);

  await server.register(authRoutes, {
    prefix: '/auth',
    oidcConfig,
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
  });

  // Pre-mount probes so tests can inspect session contents without
  // adding routes after ready() (which Fastify rejects).
  server.get('/_test/handshake', async (request) => ({
    handshake: request.session.get('oidc.handshake') ?? null,
  }));
  server.get('/_test/who', async (request) => ({
    user: request.session.get('user') ?? null,
    authenticatedAt: request.session.get('authenticatedAt') ?? null,
    idToken: request.session.get('idToken') ?? null,
  }));

  await server.ready();

  return {
    server,
    db,
    userRepository,
    close: async () => {
      await server.close();
      db.close();
      nock.cleanAll();
      nock.enableNetConnect();
    },
  };
}

export interface HappyPathOpts {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  state?: string;
  nonce?: string;
  /** Override aud (defaults to CLIENT_ID). */
  aud?: string;
  /** Override discovery (e.g. omit end_session_endpoint). */
  discoveryOverride?: Record<string, unknown>;
}

/**
 * Install nock interceptors for ONE happy-path roundtrip and return the
 * minted ID token + tokenResponse the IdP will reply with. The caller is
 * still responsible for driving the GET /auth/callback request and
 * pre-populating the session.oidc.handshake fields via a probe route
 * (see auth-routes.test.ts for the canonical pattern).
 */
export async function setupOidcHappyPath(opts: HappyPathOpts): Promise<{
  idToken: string;
  tokenResponse: {
    access_token: string;
    id_token: string;
    token_type: 'Bearer';
    expires_in: number;
  };
}> {
  const idToken = await mintIdToken({
    sub: opts.sub,
    email: opts.email ?? 'user@example.com',
    email_verified: opts.email_verified ?? true,
    name: opts.name ?? 'Test User',
    aud: opts.aud ?? CLIENT_ID,
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
  });
  const tokenResponse = {
    access_token: 'access-token-' + opts.sub,
    id_token: idToken,
    token_type: 'Bearer' as const,
    expires_in: 3600,
  };
  await installOidcInterceptors({
    tokenResponse,
    ...(opts.discoveryOverride !== undefined
      ? { discoveryOverride: opts.discoveryOverride }
      : {}),
  });
  return { idToken, tokenResponse };
}
