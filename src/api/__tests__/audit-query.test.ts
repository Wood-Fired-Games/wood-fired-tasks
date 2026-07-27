import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import type { App } from '../../index.js';
import { authHeaders } from './helpers/auth.js';
import { AUDIT_QUERY_LIMIT_MAX, toStoredTimestamp } from '../routes/audit/index.js';
import { findBindingRule } from '../plugins/auth/project-binding.js';

/**
 * Security Audit finding M5 (task #1637) — the read-only audit-trail query
 * surface (`GET /api/v1/audit-events`).
 *
 * Covers the four properties that make this surface safe to expose at all:
 *  1. it is ADMIN-tier (a `read` token is refused),
 *  2. it is READ-ONLY (asserted against the built route table, not a comment),
 *  3. its limit ceiling is ENFORCED (proved with a real over-limit request),
 *  4. its filters — actor, resource and time range — actually filter.
 */

const AUDIT_URL = '/api/v1/audit-events';

/** All rows this suite seeds share a request-id prefix so they are identifiable. */
const SEEDED_ACTOR = 'actor-alpha';
const OTHER_ACTOR = 'actor-beta';

let server: FastifyInstance;
let app: App;

/** `?a=1&b=2` from a plain object, dropping undefined values. */
function url(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.append(key, String(value));
  }
  return `${AUDIT_URL}?${search.toString()}`;
}

interface AuditListBody {
  data: Array<Record<string, unknown>>;
  limit: number;
  offset: number;
  count: number;
}

beforeAll(async () => {
  const result = await createServer({ dbPath: ':memory:' });
  server = result.server;
  app = result.app;
  await server.ready();

  // 12 rows for the primary actor — more than the small page sizes used below
  // so a limit that is NOT honoured shows up as extra rows rather than as an
  // accidentally-correct short page.
  for (let i = 0; i < 12; i += 1) {
    app.auditEventRepository.append({
      actorType: 'user',
      actorId: SEEDED_ACTOR,
      tokenId: '7',
      action: `PUT /api/v1/tasks/:id#${i}`,
      resourceType: 'tasks',
      resourceId: String(100 + i),
      requestId: `req-${i}`,
      metadata: { status: 200, authMethod: 'pat' },
    });
  }
  // One row for a DIFFERENT actor and a different resource, so the actor and
  // resource filters have something they must exclude.
  app.auditEventRepository.append({
    actorType: 'service_account',
    actorId: OTHER_ACTOR,
    tokenId: null,
    action: 'DELETE /api/v1/projects/:id',
    resourceType: 'projects',
    resourceId: '9001',
    requestId: 'req-other',
    metadata: { status: 204, authMethod: 'session' },
  });
});

afterAll(async () => {
  await server.close();
  app.db.close();
});

/** Bearer headers for a PAT carrying exactly the given scope grant. */
function headersWithScopes(scopes: string[], name: string): { Authorization: string } {
  return authHeaders(app.db, { displayName: name, name, scopes });
}

describe('GET /api/v1/audit-events — admin tier enforcement', () => {
  it('refuses a read-scoped token with 403 insufficient_scope', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR }),
      headers: headersWithScopes(['read'], 'reader'),
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.payload).error).toBe('insufficient_scope');
  });

  it('refuses a write-scoped token too — `write` does not satisfy `admin`', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR }),
      headers: headersWithScopes(['write'], 'writer'),
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.payload).error).toBe('insufficient_scope');
  });

  it('serves an admin-scoped token with 200', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR }),
      headers: headersWithScopes(['admin'], 'admin-a'),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as AuditListBody;
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('rejects an unauthenticated caller with 401 before any scope check', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR }),
    });

    expect(response.statusCode).toBe(401);
  });

  it('declares requiredScope: admin in the built route table', () => {
    const audit = (server as unknown as { authenticatedRouteAudit: RouteAuditEntry[] })
      .authenticatedRouteAudit;
    const entries = audit.filter((route) => route.url.startsWith('/api/v1/audit-events'));

    expect(entries.length, 'audit-events routes must appear in the route audit').toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.config.requiredScope, `${entry.method} ${entry.url}`).toBe('admin');
    }
  });
});

interface RouteAuditEntry {
  method: string;
  url: string;
  config: Record<string, unknown>;
}

describe('GET /api/v1/audit-events — read-only surface', () => {
  it('registers NO write verb anywhere under the audit-events prefix', () => {
    const audit = (server as unknown as { authenticatedRouteAudit: RouteAuditEntry[] })
      .authenticatedRouteAudit;

    // `method` is a comma-joined string when Fastify registers a multi-verb
    // route, so split before classifying.
    const verbs = audit
      .filter((route) => route.url.startsWith('/api/v1/audit-events'))
      .flatMap((route) => route.method.split(',').map((verb) => verb.trim().toUpperCase()));

    expect(verbs.length, 'expected the audit-events route(s) to be registered').toBeGreaterThan(0);

    const writeVerbs = verbs.filter((verb) => !['GET', 'HEAD'].includes(verb));
    expect(
      writeVerbs,
      `audit-events must expose no write verb; found: ${writeVerbs.join(', ')}`,
    ).toEqual([]);
    expect(verbs).toContain('GET');
  });

  it('answers a POST to the audit-events url with 404 (no such route)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: AUDIT_URL,
      headers: headersWithScopes(['admin'], 'admin-post'),
      payload: { actor_id: 'x' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('answers a DELETE to the audit-events url with 404 (no such route)', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: AUDIT_URL,
      headers: headersWithScopes(['admin'], 'admin-delete'),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/v1/audit-events — filters', () => {
  it('filters by actor and excludes every other actor', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: AUDIT_QUERY_LIMIT_MAX }),
      headers: headersWithScopes(['admin'], 'admin-actor'),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as AuditListBody;
    expect(body.data.length).toBe(12);
    expect(new Set(body.data.map((row) => row['actor_id']))).toEqual(new Set([SEEDED_ACTOR]));
  });

  it('filters by resource type + id', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ resource_type: 'projects', resource_id: '9001' }),
      headers: headersWithScopes(['admin'], 'admin-resource'),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as AuditListBody;
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.['actor_id']).toBe(OTHER_ACTOR);
  });

  it('returns rows newest-first', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: AUDIT_QUERY_LIMIT_MAX }),
      headers: headersWithScopes(['admin'], 'admin-order'),
    });

    const ids = (JSON.parse(response.payload) as AuditListBody).data.map(
      (row) => row['id'] as number,
    );
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('rejects a request naming no filter mode at all', async () => {
    const response = await server.inject({
      method: 'GET',
      url: AUDIT_URL,
      headers: headersWithScopes(['admin'], 'admin-nofilter'),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a request naming TWO filter modes', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({
        actor_id: SEEDED_ACTOR,
        start: '2020-01-01T00:00:00Z',
        end: '2030-01-01T00:00:00Z',
      }),
      headers: headersWithScopes(['admin'], 'admin-twofilter'),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a half-specified resource mode', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ resource_type: 'tasks' }),
      headers: headersWithScopes(['admin'], 'admin-halfresource'),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a half-specified time range', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ start: '2020-01-01T00:00:00Z' }),
      headers: headersWithScopes(['admin'], 'admin-halfrange'),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/v1/audit-events — time-range filter', () => {
  /**
   * The stored `timestamp` is SQLite's `datetime('now')` output
   * (`YYYY-MM-DD HH:MM:SS`), compared as TEXT. These cases are built from a
   * REAL stored timestamp read back through the endpoint so they exercise the
   * ISO-8601 → stored-form normalization: a same-day bound differs from the
   * stored value only in the `T`/space separator, which is exactly where an
   * un-normalized comparison silently returns nothing.
   */
  let newestStored: string;
  let newestId: number;

  beforeAll(async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: 1 }),
      headers: headersWithScopes(['admin'], 'admin-probe'),
    });
    const row = (JSON.parse(response.payload) as AuditListBody).data[0] as Record<string, unknown>;
    newestStored = row['timestamp'] as string;
    newestId = row['id'] as number;
  });

  /** Stored `YYYY-MM-DD HH:MM:SS` (UTC) → an ISO-8601 instant, offset by `seconds`. */
  function isoFromStored(stored: string, seconds: number): string {
    const ms = Date.parse(`${stored.replace(' ', 'T')}Z`) + seconds * 1000;
    return new Date(ms).toISOString();
  }

  it('returns the seeded rows for a same-day range (proves ISO → stored normalization)', async () => {
    const day = newestStored.slice(0, 10);
    const response = await server.inject({
      method: 'GET',
      url: url({
        start: `${day}T00:00:00Z`,
        end: `${day}T23:59:59Z`,
        limit: AUDIT_QUERY_LIMIT_MAX,
      }),
      headers: headersWithScopes(['admin'], 'admin-sameday'),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as AuditListBody;
    expect(body.data.map((row) => row['id'])).toContain(newestId);
    expect(body.data.length).toBe(13);
  });

  it('excludes rows after `end` — the upper bound is real, not decorative', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({
        start: isoFromStored(newestStored, -86400),
        end: isoFromStored(newestStored, -1),
        limit: AUDIT_QUERY_LIMIT_MAX,
      }),
      headers: headersWithScopes(['admin'], 'admin-upper'),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as AuditListBody;
    expect(body.data.map((row) => row['id'])).not.toContain(newestId);
  });

  it('excludes rows before `start` — the lower bound is real too', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({
        start: isoFromStored(newestStored, 1),
        end: isoFromStored(newestStored, 86400),
        limit: AUDIT_QUERY_LIMIT_MAX,
      }),
      headers: headersWithScopes(['admin'], 'admin-lower'),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as AuditListBody;
    expect(body.data.map((row) => row['id'])).not.toContain(newestId);
  });

  it('returns an empty page for a window that predates every row', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ start: '2000-01-01T00:00:00Z', end: '2000-01-02T00:00:00Z' }),
      headers: headersWithScopes(['admin'], 'admin-ancient'),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as AuditListBody;
    expect(body.data).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('toStoredTimestamp converts an ISO instant to the stored column form', () => {
    expect(toStoredTimestamp('2026-07-27T10:00:00Z')).toBe('2026-07-27 10:00:00');
    // A non-UTC offset is normalized to UTC, not merely reformatted.
    expect(toStoredTimestamp('2026-07-27T12:00:00+02:00')).toBe('2026-07-27 10:00:00');
    // Sub-second precision is truncated to the column's whole-second resolution.
    expect(toStoredTimestamp('2026-07-27T10:00:00.750Z')).toBe('2026-07-27 10:00:00');
  });
});

describe('GET /api/v1/audit-events — limit ceiling is enforced, not suggested', () => {
  it('honours a small limit exactly', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: 5 }),
      headers: headersWithScopes(['admin'], 'admin-limit5'),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as AuditListBody;
    // 12 rows exist for this actor — a limit that is ignored would return 12.
    expect(body.data.length).toBe(5);
    expect(body.count).toBe(5);
    expect(body.limit).toBe(5);
  });

  it(`accepts exactly the ceiling (${AUDIT_QUERY_LIMIT_MAX})`, async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: AUDIT_QUERY_LIMIT_MAX }),
      headers: headersWithScopes(['admin'], 'admin-atmax'),
    });

    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.payload) as AuditListBody).limit).toBe(AUDIT_QUERY_LIMIT_MAX);
  });

  it(`REJECTS one over the ceiling (${AUDIT_QUERY_LIMIT_MAX + 1}) rather than silently clamping`, async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: AUDIT_QUERY_LIMIT_MAX + 1 }),
      headers: headersWithScopes(['admin'], 'admin-overmax'),
    });

    expect(response.statusCode).toBe(400);
  });

  it('REJECTS a grossly over-limit request (limit=100000)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: 100000 }),
      headers: headersWithScopes(['admin'], 'admin-huge'),
    });

    expect(response.statusCode).toBe(400);
    // And nothing leaked in the rejection body.
    expect(response.payload).not.toContain('actor-alpha');
  });

  it('REJECTS an offset that would push the read window past the ceiling', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: 200, offset: 400 }),
      headers: headersWithScopes(['admin'], 'admin-offsetover'),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a non-positive limit', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: 0 }),
      headers: headersWithScopes(['admin'], 'admin-zero'),
    });

    expect(response.statusCode).toBe(400);
  });

  it('pages with offset without overlapping the previous page', async () => {
    const admin = headersWithScopes(['admin'], 'admin-paging');
    const first = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: 5, offset: 0 }),
      headers: admin,
    });
    const second = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: 5, offset: 5 }),
      headers: admin,
    });

    const firstIds = (JSON.parse(first.payload) as AuditListBody).data.map((r) => r['id']);
    const secondBody = JSON.parse(second.payload) as AuditListBody;
    const secondIds = secondBody.data.map((r) => r['id']);

    expect(firstIds.length).toBe(5);
    expect(secondIds.length).toBe(5);
    expect(secondBody.offset).toBe(5);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
  });
});

describe('GET /api/v1/audit-events — project binding', () => {
  it('is classified `deny`, so a project-bound token cannot read the trail', () => {
    expect(findBindingRule('GET', '/api/v1/audit-events')).toEqual({ kind: 'deny' });
    // The trailing-slash form Fastify also registers must land on the same rule.
    expect(findBindingRule('GET', '/api/v1/audit-events/')).toEqual({ kind: 'deny' });
  });

  it('refuses a bound admin token with 403 project_scope_denied', async () => {
    const projectId = Number(
      app.db.prepare(`INSERT INTO projects (name, description) VALUES ('binding-probe', '')`).run()
        .lastInsertRowid,
    );

    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR }),
      headers: authHeaders(app.db, {
        displayName: 'bound-admin',
        name: 'bound-admin',
        scopes: ['admin'],
        projectId,
      }),
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.payload).error).toBe('project_scope_denied');
  });

  it('leaves an UNBOUND admin token untouched (the operator path still works)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR }),
      headers: authHeaders(app.db, {
        displayName: 'unbound-admin',
        name: 'unbound-admin',
        scopes: ['admin'],
        projectId: null,
      }),
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('GET /api/v1/audit-events — no credential material surfaces', () => {
  it('exposes exactly the audit-row columns and nothing resembling a secret', async () => {
    const response = await server.inject({
      method: 'GET',
      url: url({ actor_id: SEEDED_ACTOR, limit: 1 }),
      headers: headersWithScopes(['admin'], 'admin-secrets'),
    });

    const row = (JSON.parse(response.payload) as AuditListBody).data[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      [
        'action',
        'actor_id',
        'actor_type',
        'id',
        'metadata',
        'prev_hash',
        'request_id',
        'resource_id',
        'resource_type',
        'row_hash',
        'timestamp',
        'token_id',
      ].sort(),
    );

    // `token_id` is the api_tokens ROW ID, never a token/prefix/suffix/hash.
    expect(row['token_id']).toBe('7');

    // The whole payload must not carry PAT material. The seeded PATs are real
    // tokens minted into api_tokens; assert neither the raw form nor the
    // stored hash/prefix/suffix appears anywhere in the response.
    const secrets = app.db.prepare('SELECT prefix, suffix, hash FROM api_tokens').all() as Array<
      Record<string, unknown>
    >;
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(response.payload).not.toContain(String(secret['hash']));
      expect(response.payload).not.toContain(String(secret['suffix']));
    }
    expect(response.payload).not.toContain('wft_pat_');
  });
});
