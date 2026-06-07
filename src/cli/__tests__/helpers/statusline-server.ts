/**
 * Test helper: minimal Fastify server that emulates the WFT REST endpoints the
 * `tasks statusline` command hits when it refreshes the per-project task-count
 * segment (project 29, Phase 4, task #599 subprocess test).
 *
 * The status-line render path, on a stale/missing count cache, calls:
 *
 *   GET /api/v1/tasks?project_id=<id>&status=<open|done|closed>&limit=1
 *       — three minimal (`limit: 1`) reads whose pagination-envelope `total`
 *         feeds `{ open, doneClosed }` (see src/cli/statusline/count-fetcher.ts).
 *   GET /api/v1/projects/<id>
 *       — best-effort display-name lookup (src/cli/commands/statusline.ts
 *         defaultResolveProjectName).
 *
 * Per-status `total`s are configurable; the project body defaults to a valid
 * ProjectResponse shape so the client's Zod trust boundary accepts it. Every
 * request's path + Authorization header is recorded so a test can assert that a
 * FRESH cache produces ZERO requests (the "no API hit when cache is fresh" AC).
 */
import Fastify, { type FastifyInstance } from 'fastify';

export interface StatuslineServerOptions {
  /** Per-status `total` counts returned by the tasks-list endpoint. */
  counts?: { open?: number; done?: number; closed?: number };
  /** Project id the project-name lookup should answer for. */
  projectId?: number;
  /** Display name returned by GET /projects/:id. */
  projectName?: string;
}

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
}

export interface StatuslineServer {
  baseUrl: string;
  close: () => Promise<void>;
  /** Every request the CLI made, in arrival order. */
  getRequests: () => RecordedRequest[];
}

export async function startStatuslineServer(
  opts: StatuslineServerOptions = {},
): Promise<StatuslineServer> {
  const fastify: FastifyInstance = Fastify({ logger: false });

  const requests: RecordedRequest[] = [];
  const record = (method: string, url: string, authorization: string | undefined): void => {
    requests.push({ method, url, authorization });
  };

  const counts = { open: 0, done: 0, closed: 0, ...(opts.counts ?? {}) };
  const projectId = opts.projectId ?? 1;
  const projectName = opts.projectName ?? 'demo-project';

  // GET /api/v1/tasks — return the pagination envelope whose `total` matches
  // the requested status. `data` is empty (limit:1 reads only consult `total`).
  fastify.get('/api/v1/tasks', async (request, reply) => {
    record('GET', request.url, request.headers.authorization);
    const status = (request.query as { status?: string }).status ?? '';
    const total = status in counts ? counts[status as keyof typeof counts] : 0;
    return reply.code(200).send({ data: [], total, limit: 1, offset: 0 });
  });

  // GET /api/v1/projects/:id — a valid ProjectResponse for the name lookup.
  fastify.get('/api/v1/projects/:id', async (request, reply) => {
    record('GET', request.url, request.headers.authorization);
    return reply.code(200).send({
      id: projectId,
      name: projectName,
      description: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
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
