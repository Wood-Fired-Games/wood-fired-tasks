/**
 * Test helper: minimal Fastify server that emulates the WFT server endpoints
 * used by `tasks logout` (Plan 30-07) and `tasks whoami` (Plan 30-07 Task 2).
 *
 * Wires only the three routes the CLI commands hit on a successful flow:
 *
 *   DELETE /api/v1/me/tokens/active   — logout self-revoke
 *   GET    /api/v1/me                 — whoami profile lookup
 *   GET    /api/v1/me/tokens          — whoami active-token enrichment
 *
 * Per-test fixtures drive each route's response independently. The handler
 * records every incoming Authorization header into `requests.{logout,me,tokens}`
 * so tests can assert the Bearer prefix + token value the CLI sent.
 */
import Fastify, { type FastifyInstance } from 'fastify';

export interface RouteFixture {
  status: number;
  body: unknown; // pass `null` for 204 no-content
}

export interface LogoutWhoamiServerOptions {
  logoutResponse?: RouteFixture;
  meResponse?: RouteFixture;
  tokensResponse?: RouteFixture;
}

export interface RecordedRequest {
  authorization: string | undefined;
}

export interface LogoutWhoamiServer {
  baseUrl: string;
  close: () => Promise<void>;
  /** Per-route arrival log. */
  getRequests: () => {
    logout: RecordedRequest[];
    me: RecordedRequest[];
    tokens: RecordedRequest[];
  };
}

export async function startLogoutWhoamiServer(
  opts: LogoutWhoamiServerOptions = {},
): Promise<LogoutWhoamiServer> {
  const fastify: FastifyInstance = Fastify({ logger: false });

  const requests = {
    logout: [] as RecordedRequest[],
    me: [] as RecordedRequest[],
    tokens: [] as RecordedRequest[],
  };

  fastify.delete('/api/v1/me/tokens/active', async (request, reply) => {
    requests.logout.push({
      authorization: request.headers.authorization,
    });
    const fixture = opts.logoutResponse ?? { status: 204, body: null };
    if (fixture.status === 204) {
      return reply.code(204).send();
    }
    return reply.code(fixture.status).send(fixture.body);
  });

  fastify.get('/api/v1/me', async (request, reply) => {
    requests.me.push({
      authorization: request.headers.authorization,
    });
    const fixture = opts.meResponse ?? {
      status: 200,
      body: {
        id: 1,
        displayName: 'Test User',
        email: 'test@example.com',
        isLegacy: false,
        isServiceAccount: false,
      },
    };
    return reply.code(fixture.status).send(fixture.body);
  });

  fastify.get('/api/v1/me/tokens', async (request, reply) => {
    requests.tokens.push({
      authorization: request.headers.authorization,
    });
    const fixture = opts.tokensResponse ?? {
      status: 200,
      body: [],
    };
    return reply.code(fixture.status).send(fixture.body);
  });

  const address = await fastify.listen({ port: 0, host: '127.0.0.1' });
  return {
    baseUrl: address,
    close: async () => {
      await fastify.close();
    },
    getRequests: () => requests,
  };
}
