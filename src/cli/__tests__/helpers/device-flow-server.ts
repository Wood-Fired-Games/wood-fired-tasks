/**
 * Test helper: minimal Fastify server that emulates the WFT device-flow
 * endpoints for Plan 30-06's subprocess test.
 *
 * Only `POST /auth/device/code` and `POST /auth/device/token` are wired —
 * the CLI's login command never hits anything else during a happy login.
 *
 * Test fixtures drive the server via two knobs:
 *
 *   - `codeResponse`     : the JSON body returned by /code (default = a
 *                          working envelope with interval=1 so the
 *                          subprocess test runs in <5s wall-clock)
 *   - `tokenResponses`   : an ARRAY of { status, body } pairs consumed in
 *                          order by successive /token polls. Once the array
 *                          is exhausted, the server responds with
 *                          authorization_pending forever.
 *
 * The handler records every incoming request body into `requests.code` and
 * `requests.token` so tests can assert on what the CLI sent (e.g.
 * --token-name routing in test 6).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';

export interface TokenResponseFixture {
  status: number;
  body: Record<string, unknown>;
}

export interface DeviceFlowServerOptions {
  codeResponse?: Record<string, unknown>;
  tokenResponses: TokenResponseFixture[];
  /**
   * When set, the server also serves `GET /api/v1/me` (used by the manual-PAT
   * login/setup path, #857/#858): a request whose `Authorization: Bearer <pat>`
   * matches `me.expectedToken` gets `me.identity` (HTTP 200); any other token
   * gets 401. Omit to leave `/api/v1/me` unrouted (404).
   */
  me?: {
    expectedToken: string;
    identity: { id: number; displayName: string; email: string | null };
  };
}

export interface DeviceFlowServer {
  baseUrl: string;
  close: () => Promise<void>;
  /** All bodies the CLI POSTed, in arrival order. */
  getRequests: () => {
    code: Array<Record<string, unknown>>;
    token: Array<Record<string, unknown>>;
  };
  /** Number of /token polls served so far. */
  getPollCount: () => number;
}

const DEFAULT_CODE_RESPONSE = {
  device_code: 'test-device-code-fixture',
  user_code: 'ABCD-EFGH',
  // Filled in by startDeviceFlowServer with the real bound port.
  verification_uri: 'http://__placeholder__/auth/device',
  verification_uri_complete: 'http://__placeholder__/auth/device?user_code=ABCD-EFGH',
  expires_in: 600,
  interval: 1,
};

export async function startDeviceFlowServer(
  opts: DeviceFlowServerOptions,
): Promise<DeviceFlowServer> {
  const fastify: FastifyInstance = Fastify({ logger: false });
  await fastify.register(formbody);

  const requests = {
    code: [] as Array<Record<string, unknown>>,
    token: [] as Array<Record<string, unknown>>,
  };
  let pollIdx = 0;

  fastify.post('/auth/device/code', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    requests.code.push(body);
    const baseUrl = `http://127.0.0.1:${(fastify.server.address() as { port: number }).port}`;
    const envelope = {
      ...DEFAULT_CODE_RESPONSE,
      verification_uri: `${baseUrl}/auth/device`,
      verification_uri_complete: `${baseUrl}/auth/device?user_code=ABCD-EFGH`,
      ...(opts.codeResponse ?? {}),
    };
    return reply.code(200).send(envelope);
  });

  fastify.post('/auth/device/token', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    requests.token.push(body);
    const fixture = opts.tokenResponses[pollIdx] ?? {
      status: 400,
      body: { error: 'authorization_pending' },
    };
    pollIdx += 1;
    return reply.code(fixture.status).send(fixture.body);
  });

  // Optional manual-PAT identity endpoint (#857/#858). persistManualPat GETs
  // this with a Bearer header to validate the PAT before writing credentials.
  if (opts.me) {
    const { expectedToken, identity } = opts.me;
    fastify.get('/api/v1/me', async (request, reply) => {
      const auth = request.headers.authorization ?? '';
      if (auth === `Bearer ${expectedToken}`) {
        return reply.code(200).send({ ...identity, isLegacy: false, isServiceAccount: false });
      }
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    });
  }

  const address = await fastify.listen({ port: 0, host: '127.0.0.1' });
  // Fastify v5 returns "http://127.0.0.1:<port>".
  return {
    baseUrl: address,
    close: async () => {
      await fastify.close();
    },
    getRequests: () => requests,
    getPollCount: () => pollIdx,
  };
}
