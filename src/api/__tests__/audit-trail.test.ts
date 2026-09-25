/**
 * Security Audit finding M5 (task #1630) — REST audit-trail producer tests.
 *
 * Two harnesses, on purpose:
 *
 *  1. FULL STACK (`createServer`) — proves the hook is actually WIRED into
 *     the authenticated `/api/v1` scope and sees the real auth chain's
 *     principal. A hook that works in isolation but is registered in the
 *     wrong scope records nothing in production, so the wiring is the part
 *     worth testing end to end.
 *  2. ISOLATED (bare Fastify + captured pino destination) — the only way to
 *     assert on the `audit.append_failed` ERROR line, since `createServer`
 *     owns its logger and gives no seam to swap the destination.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Writable } from 'stream';
import Fastify from 'fastify';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import type { App } from '../../index.js';
import { createServer } from '../server.js';
import auditTrailPlugin, {
  AUDIT_EXEMPT_METHODS,
  buildAuditAction,
  deriveAuditResource,
} from '../hooks/audit-trail.js';
import type { AuditEventRecord, AuditEventRow } from '../../repositories/interfaces.js';
import { generateToken } from '../../services/pat-hash.js';
import { seedAuth } from './helpers/auth.js';

/**
 * Seed a user + PAT carrying an EXPLICIT scope grant.
 *
 * `helpers/auth.ts#seedAuth` mints `scopes: '[]'`, which
 * `grantSatisfiesScope` treats as the pre-taxonomy legacy full-tier case —
 * useful for every other suite, useless for exercising the scope gate. This
 * mints a genuinely restricted token so a `write`-tier route really 403s.
 */
function seedScopedAuth(
  db: Database.Database,
  displayName: string,
  scopes: string[],
): { userId: number; tokenId: number; headers: { Authorization: string } } {
  const userInfo = db.prepare(`INSERT INTO users (display_name) VALUES (?)`).run(displayName);
  const userId = Number(userInfo.lastInsertRowid);

  const { token, prefix, suffix, hash } = generateToken();
  const tokenInfo = db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, revoked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(userId, `${displayName}-token`, prefix, suffix, hash, JSON.stringify(scopes));

  return {
    userId,
    tokenId: Number(tokenInfo.lastInsertRowid),
    headers: { Authorization: `Bearer ${token}` },
  };
}

/**
 * `onResponse` fires after the reply is flushed, so `server.inject`'s promise
 * can in principle settle a tick before the hook has appended. Poll (rather
 * than sleep a fixed amount) so the suite is neither flaky nor slow.
 */
async function waitForRows(
  read: () => AuditEventRow[],
  expected: number,
  timeoutMs = 2000,
): Promise<AuditEventRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows = read();
  while (rows.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    rows = read();
  }
  return rows;
}

/** Settle any pending `onResponse` work before asserting a ZERO-row outcome. */
async function settleResponseHooks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('REST audit trail — full stack wiring', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let projectId: number;

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;
    await server.ready();
    projectId = app.projectService.createProject({ name: 'Audit Trail Project' }).id;
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('records exactly one row for a successful authenticated POST, carrying the PAT id and the METHOD + route PATTERN', async () => {
    // Distinct principal per test so `findByActor` isolates this test's rows.
    const auth = seedAuth(db, { displayName: 'audit-post-user', name: 'audit-post-token' });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: auth.headers,
      payload: { title: 'Audited task', project_id: projectId, created_by: 'audit-post-user' },
    });
    expect(response.statusCode).toBe(201);

    const rows = await waitForRows(
      () => app.auditEventRepository.findByActor(String(auth.userId), 10),
      1,
    );

    expect(rows).toHaveLength(1);
    const row = rows[0] as AuditEventRow;
    expect(row.token_id).toBe(String(auth.tokenId));
    expect(row.actor_type).toBe('user');
    expect(row.actor_id).toBe(String(auth.userId));
    // Route PATTERN, not the raw URL — method + pattern, nothing else.
    expect(row.action).toBe('POST /api/v1/tasks');
    // Collection-addressing route: no id in the path, so none in the row.
    expect(row.resource_type).toBe('tasks');
    expect(row.resource_id).toBeNull();
    expect(row.request_id).not.toBeNull();
    expect(row.metadata).toMatchObject({ status: 201, authMethod: 'pat' });
    // The append went through the owning repository, so the chain is intact.
    expect(app.auditEventRepository.verifyChain()).toBeNull();
  });

  it('puts the path id in resource_id (never in action) for an instance-addressing route', async () => {
    const auth = seedAuth(db, { displayName: 'audit-put-user', name: 'audit-put-token' });
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: auth.headers,
      payload: { title: 'Task to update', project_id: projectId, created_by: 'audit-put-user' },
    });
    const taskId = JSON.parse(created.body).id as number;

    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${taskId}`,
      headers: auth.headers,
      payload: { title: 'Updated title' },
    });
    expect(response.statusCode).toBe(200);

    const rows = await waitForRows(
      () => app.auditEventRepository.findByActor(String(auth.userId), 10),
      2,
    );
    const putRow = rows.find((row) => row.action.startsWith('PUT ')) as AuditEventRow;
    expect(putRow).toBeDefined();
    expect(putRow.action).toBe('PUT /api/v1/tasks/:id');
    expect(putRow.action).not.toContain(String(taskId));
    expect(putRow.resource_type).toBe('tasks');
    expect(putRow.resource_id).toBe(String(taskId));
  });

  it('registers the hook exactly ONCE — N nested-scope mutations produce N rows, never 2N', async () => {
    // The hook lives on the ROOT instance while `/api/v1` routes live in a
    // nested scope (root → the `{ prefix: '/api/v1' }` register lambda → each
    // route plugin). Fastify runs an instance-level `onResponse` hook once per
    // request no matter how deep the match is — but a SECOND registration in
    // the nested scope (the shape this fix replaced) would append a second row
    // for every one of these requests. Three requests make the failure
    // unambiguous: 3 vs 6, not 1 vs 2 which a stray row could imitate.
    const auth = seedAuth(db, { displayName: 'audit-dup-user', name: 'audit-dup-token' });

    for (const title of ['dup-probe-1', 'dup-probe-2', 'dup-probe-3']) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers: auth.headers,
        payload: { title, project_id: projectId, created_by: 'audit-dup-user' },
      });
      expect(response.statusCode).toBe(201);
    }

    const rows = await waitForRows(
      () => app.auditEventRepository.findByActor(String(auth.userId), 20),
      3,
    );
    // Give a hypothetical duplicate hook time to land before counting.
    await settleResponseHooks();
    expect(app.auditEventRepository.findByActor(String(auth.userId), 20)).toHaveLength(3);
    expect(rows.every((row) => row.action === 'POST /api/v1/tasks')).toBe(true);
    // Distinct request ids — three requests, not one request recorded thrice.
    expect(new Set(rows.map((row) => row.request_id)).size).toBe(3);
  });

  it('records ZERO rows for an authenticated GET', async () => {
    const auth = seedAuth(db, { displayName: 'audit-get-user', name: 'audit-get-token' });

    const listed = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: auth.headers,
    });
    expect(listed.statusCode).toBe(200);

    const single = await server.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: auth.headers,
    });
    expect(single.statusCode).toBe(200);

    await settleResponseHooks();
    expect(app.auditEventRepository.findByActor(String(auth.userId), 10)).toEqual([]);
  });

  it('records a scope-gate rejection with its 403 status instead of dropping it', async () => {
    const auth = seedScopedAuth(db, 'audit-403-user', ['read']);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: auth.headers,
      payload: { title: 'Denied task', project_id: projectId, created_by: 'audit-403-user' },
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('insufficient_scope');

    const rows = await waitForRows(
      () => app.auditEventRepository.findByActor(String(auth.userId), 10),
      1,
    );

    expect(rows).toHaveLength(1);
    const row = rows[0] as AuditEventRow;
    expect(row.action).toBe('POST /api/v1/tasks');
    expect(row.token_id).toBe(String(auth.tokenId));
    expect(row.metadata).toMatchObject({ status: 403 });
  });

  it('leaves the HTTP status untouched when the audit append throws', async () => {
    const auth = seedAuth(db, { displayName: 'audit-fail-user', name: 'audit-fail-token' });

    const appendSpy = vi
      .spyOn(app.auditEventRepository, 'append')
      .mockImplementation((_record: AuditEventRecord): number => {
        throw new Error('simulated audit outage');
      });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers: auth.headers,
        payload: { title: 'Still created', project_id: projectId, created_by: 'audit-fail-user' },
      });

      // The mutation succeeded and the client's status is unchanged — the
      // audit append is strictly downstream of the response.
      expect(response.statusCode).toBe(201);
      expect(JSON.parse(response.body).title).toBe('Still created');

      await settleResponseHooks();
      expect(appendSpy).toHaveBeenCalledTimes(1);
      // The row was genuinely lost (not written some other way) …
      expect(app.auditEventRepository.findByActor(String(auth.userId), 10)).toEqual([]);
    } finally {
      appendSpy.mockRestore();
    }

    // … and the server is still healthy afterwards: no crash, no wedged hook.
    const after = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: auth.headers,
      payload: { title: 'After outage', project_id: projectId, created_by: 'audit-fail-user' },
    });
    expect(after.statusCode).toBe(201);
    const rows = await waitForRows(
      () => app.auditEventRepository.findByActor(String(auth.userId), 10),
      1,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('audit-trail hook — isolated', () => {
  /**
   * Bare Fastify running ONLY the audit hook, with a pino destination we own
   * so the failure path's log line is observable. `request.user` /
   * `request.tokenId` are decorated and populated by a stand-in preHandler —
   * the real auth chain is exercised by the full-stack suite above.
   */
  async function bootHarness(
    append: (record: AuditEventRecord) => number,
  ): Promise<{ instance: FastifyInstance; lines: () => Record<string, unknown>[] }> {
    const captured: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      },
    });

    // Fastify 5 takes a pre-built pino instance via `loggerInstance`;
    // `logger` only accepts a plain options object.
    const instance = Fastify({ loggerInstance: pino({ level: 'error' }, dest) });
    const repository = {
      append,
      verifyChain: (): number | null => null,
      findByActor: (): AuditEventRow[] => [],
      findByResource: (): AuditEventRow[] => [],
      findByTimeRange: (): AuditEventRow[] => [],
    };
    instance.decorate('auditEventRepository', repository);
    instance.decorateRequest('user', null);
    instance.decorateRequest('authMethod', null);
    instance.decorateRequest('tokenId', null);
    instance.decorateRequest('scopes', null);
    await instance.register(auditTrailPlugin);
    instance.addHook('preHandler', async (request) => {
      request.user = {
        id: 42,
        displayName: 'harness-user',
        email: null,
        isLegacy: false,
        isServiceAccount: false,
      };
      request.authMethod = 'pat';
      request.tokenId = 7;
    });
    instance.post('/api/v1/things/:id', async () => ({ ok: true }));
    // GET (and, via `exposeHeadRoutes`, its auto-generated HEAD twin) so the
    // read-verb exemption is exercised on the same instance.
    instance.get('/api/v1/things', async () => ({ ok: true }));
    await instance.ready();

    return {
      instance,
      lines: () =>
        captured
          .join('')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  }

  it('logs audit.append_failed at ERROR level when the append throws, without failing the request', async () => {
    const { instance, lines } = await bootHarness(() => {
      throw new Error('boom');
    });

    try {
      const response = await instance.inject({ method: 'POST', url: '/api/v1/things/9' });
      expect(response.statusCode).toBe(200);

      await settleResponseHooks();
      const failures = lines().filter((line) => line['msg'] === 'audit.append_failed');
      expect(failures).toHaveLength(1);
      // pino numeric level 50 === error.
      expect(failures[0]?.['level']).toBe(50);
      expect(failures[0]?.['route']).toBe('/api/v1/things/:id');
    } finally {
      await instance.close();
    }
  });

  it('appends one row per non-GET request and none for GET/HEAD', async () => {
    const records: AuditEventRecord[] = [];
    const { instance } = await bootHarness((record) => {
      records.push(record);
      return records.length;
    });

    try {
      await instance.inject({ method: 'POST', url: '/api/v1/things/3' });
      await instance.inject({ method: 'GET', url: '/api/v1/things' });
      await instance.inject({ method: 'HEAD', url: '/api/v1/things' });
      await settleResponseHooks();

      expect(records).toHaveLength(1);
      expect(records[0]?.action).toBe('POST /api/v1/things/:id');
      expect(records[0]?.resourceType).toBe('things');
      expect(records[0]?.resourceId).toBe('3');
      expect(records[0]?.tokenId).toBe('7');
      expect(records[0]?.actorId).toBe('42');
    } finally {
      await instance.close();
    }
  });
});

describe('audit-trail resource derivation', () => {
  it('treats a trailing path parameter as the addressed resource', () => {
    expect(deriveAuditResource('/api/v1/tasks/:id', { id: 12 })).toEqual({
      resourceType: 'tasks',
      resourceId: '12',
    });
    expect(
      deriveAuditResource('/api/v1/tasks/:taskId/dependencies/:dependsOnId', {
        taskId: 4,
        dependsOnId: 9,
      }),
    ).toEqual({ resourceType: 'dependencies', resourceId: '9' });
  });

  it('treats a trailing static segment as a collection with no resource id', () => {
    expect(deriveAuditResource('/api/v1/tasks', {})).toEqual({
      resourceType: 'tasks',
      resourceId: null,
    });
    expect(deriveAuditResource('/api/v1/tasks/:id/comments', { id: 3 })).toEqual({
      resourceType: 'comments',
      resourceId: null,
    });
  });

  it('degrades safely on a pattern with no static segment or no matching param', () => {
    expect(deriveAuditResource('/:id', { id: 1 })).toEqual({
      resourceType: 'unknown',
      resourceId: '1',
    });
    expect(deriveAuditResource('/api/v1/tasks/:id', {})).toEqual({
      resourceType: 'tasks',
      resourceId: null,
    });
  });

  it('builds the action from the method and the pattern only', () => {
    expect(buildAuditAction('post', '/api/v1/tasks/:id')).toBe('POST /api/v1/tasks/:id');
  });

  it('exempts exactly the read verbs', () => {
    expect([...AUDIT_EXEMPT_METHODS].sort()).toEqual(['GET', 'HEAD']);
  });
});
