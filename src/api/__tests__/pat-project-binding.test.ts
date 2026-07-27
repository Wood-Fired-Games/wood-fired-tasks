import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { createServer } from '../server.js';
import { resetConfig } from '../../config/env.js';
import { seedAuth } from './helpers/auth.js';
import { findBindingRule, normalizeRouteUrl } from '../plugins/auth/project-binding.js';
import { bindingSatisfiesProjects } from '../../schemas/pat-scope.schema.js';

/**
 * Security Audit finding M1 (task #1635) — PAT project-binding enforcement.
 *
 * The tier gate from #1620/#1621 answers "how much may this token do?". It
 * still lets a `write` token reach EVERY project, which for a multi-agent
 * backlog is most of the blast radius M1 was about. The binding adds the
 * second dimension — "*where* may it do it?" — and this file is its contract.
 *
 * The load-bearing case is the INDIRECT one. A binding that only worked when
 * `project_id` appears as a path param would be trivially bypassable: an
 * attacker holding a token bound to project A mutates a task in project B by
 * TASK id and never names a project at all. The `PUT /api/v1/tasks/:id` cases
 * below are therefore the ones that actually prove the boundary holds; the
 * `/api/v1/projects/:id` cases only prove the easy half.
 */

interface Harness {
  server: FastifyInstance;
  db: Database.Database;
  /** A project the bound token is allowed to touch. */
  projectA: number;
  /** A project the bound token must never touch. */
  projectB: number;
  /** A task inside project A. */
  taskA: number;
  /** A task inside project B. */
  taskB: number;
}

let harness: Harness;

/** Insert a project directly and return its id. */
function seedProject(db: Database.Database, name: string): number {
  return Number(db.prepare('INSERT INTO projects (name) VALUES (?)').run(name).lastInsertRowid);
}

/** Insert a task directly into `projectId` and return its id. */
function seedTask(db: Database.Database, projectId: number, title: string): number {
  return Number(
    db
      .prepare('INSERT INTO tasks (title, project_id, created_by) VALUES (?, ?, ?)')
      .run(title, projectId, 'seed').lastInsertRowid,
  );
}

beforeAll(async () => {
  delete process.env.NODE_ENV;
  resetConfig();
  const result = await createServer({ dbPath: ':memory:' });
  const db = result.app.db;
  const projectA = seedProject(db, 'project-a');
  const projectB = seedProject(db, 'project-b');
  harness = {
    server: result.server,
    db,
    projectA,
    projectB,
    taskA: seedTask(db, projectA, 'task in project A'),
    taskB: seedTask(db, projectB, 'task in project B'),
  };
  await harness.server.ready();
});

afterAll(async () => {
  await harness.server.close();
  harness.db.close();
  resetConfig();
});

/** Bearer headers for a `write`-scoped token bound to `projectId`. */
function boundWriteHeaders(projectId: number): { Authorization: string } {
  return seedAuth(harness.db, {
    displayName: `bound-${projectId}-${Math.random()}`,
    scopes: ['write'],
    projectId,
  }).headers;
}

/** Bearer headers for a `write`-scoped token with NO binding. */
function unboundWriteHeaders(): { Authorization: string } {
  return seedAuth(harness.db, {
    displayName: `unbound-${Math.random()}`,
    scopes: ['write'],
  }).headers;
}

describe('project binding — direct resolution (project id in the path)', () => {
  it('a token bound to A may mutate project A', async () => {
    const res = await harness.server.inject({
      method: 'PUT',
      url: `/api/v1/projects/${harness.projectA}`,
      headers: boundWriteHeaders(harness.projectA),
      payload: { description: 'touched by a token bound to A' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('the SAME token is refused 403 on project B even though its tier allows the write', async () => {
    const headers = boundWriteHeaders(harness.projectA);
    // Same credential, same verb, same tier requirement — only the target
    // project differs, so a 403 here can only come from the binding.
    const allowed = await harness.server.inject({
      method: 'PUT',
      url: `/api/v1/projects/${harness.projectA}`,
      headers,
      payload: { description: 'in-binding write' },
    });
    expect(allowed.statusCode).toBe(200);

    const denied = await harness.server.inject({
      method: 'PUT',
      url: `/api/v1/projects/${harness.projectB}`,
      headers,
      payload: { description: 'out-of-binding write' },
    });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).error).toBe('project_scope_denied');
  });

  it('the 403 body does not disclose anything about the out-of-binding project', async () => {
    const res = await harness.server.inject({
      method: 'GET',
      url: `/api/v1/projects/${harness.projectB}`,
      headers: boundWriteHeaders(harness.projectA),
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('project-b');
    expect(res.body).not.toContain(String(harness.projectB));
  });
});

describe('project binding — INDIRECT resolution (project reached via task id)', () => {
  // This is the criterion the whole feature turns on: the route names a TASK,
  // never a project, so the gate has to dereference the task row to decide.

  it('a token bound to A gets 200 mutating a task in project A', async () => {
    const res = await harness.server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${harness.taskA}`,
      headers: boundWriteHeaders(harness.projectA),
      payload: { title: 'renamed inside the binding' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a token bound to A gets 403 mutating a task in project B', async () => {
    const res = await harness.server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${harness.taskB}`,
      headers: boundWriteHeaders(harness.projectA),
      payload: { title: 'attempted cross-project rename' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('project_scope_denied');

    // The refusal must be a real refusal, not a 403 emitted after the write.
    const row = harness.db.prepare('SELECT title FROM tasks WHERE id = ?').get(harness.taskB) as {
      title: string;
    };
    expect(row.title).toBe('task in project B');
  });

  it('DELETE of a cross-project task by task id is refused', async () => {
    const res = await harness.server.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/${harness.taskB}`,
      headers: boundWriteHeaders(harness.projectA),
    });
    expect(res.statusCode).toBe(403);
    const row = harness.db.prepare('SELECT id FROM tasks WHERE id = ?').get(harness.taskB);
    expect(row).toBeDefined();
  });

  it('a nested task subroute (comments) is gated by the OWNING project, not the path shape', async () => {
    const headers = boundWriteHeaders(harness.projectA);
    const allowed = await harness.server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${harness.taskA}/comments`,
      headers,
      payload: { content: 'in-binding comment', author: 'tester' },
    });
    expect(allowed.statusCode).toBe(201);

    const denied = await harness.server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${harness.taskB}/comments`,
      headers,
      payload: { content: 'out-of-binding comment', author: 'tester' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('a task id that names no row is refused (fail closed, not fail open)', async () => {
    const res = await harness.server.inject({
      method: 'PUT',
      url: '/api/v1/tasks/999999',
      headers: boundWriteHeaders(harness.projectA),
      payload: { title: 'nonexistent' },
    });
    // An unresolvable target must never be treated as "no project to check".
    expect(res.statusCode).toBe(403);
  });

  it('a dependency edge pointing OUT of the binding is refused even though the path task is in it', async () => {
    // Both endpoints of the edge are resolved: the path task is inside the
    // binding, the body task is not. Accepting because ONE side matched would
    // be the bypass.
    const res = await harness.server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${harness.taskA}/dependencies`,
      headers: boundWriteHeaders(harness.projectA),
      payload: { blocks_task_id: harness.taskB },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /tasks cannot create a task in a project outside the binding', async () => {
    const headers = boundWriteHeaders(harness.projectA);
    const allowed = await harness.server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'created inside the binding',
        project_id: harness.projectA,
        created_by: 'tester',
      },
    });
    expect(allowed.statusCode).toBe(201);

    const denied = await harness.server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'created outside the binding',
        project_id: harness.projectB,
        created_by: 'tester',
      },
    });
    expect(denied.statusCode).toBe(403);
    const count = harness.db
      .prepare("SELECT COUNT(*) AS c FROM tasks WHERE title = 'created outside the binding'")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });
});

describe('backward compatibility — a token with NO binding keeps cross-project access', () => {
  // The whole feature has to be inert for every credential minted before it
  // existed, which is every credential in every existing deployment.

  it('an unbound write token mutates tasks in BOTH projects', async () => {
    const headers = unboundWriteHeaders();

    const inA = await harness.server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${harness.taskA}`,
      headers,
      payload: { description: 'unbound token, project A' },
    });
    expect(inA.statusCode).toBe(200);

    const inB = await harness.server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${harness.taskB}`,
      headers,
      payload: { description: 'unbound token, project B' },
    });
    expect(inB.statusCode).toBe(200);
  });

  it('an unbound token still reaches the cross-project surfaces a bound one cannot', async () => {
    const unbound = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: unboundWriteHeaders(),
    });
    expect(unbound.statusCode).toBe(200);

    // …and the bound token is refused on the same route, because "every
    // project" is not narrowable to one.
    const bound = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: boundWriteHeaders(harness.projectA),
    });
    expect(bound.statusCode).toBe(403);
  });

  it('a legacy PAT (no scopes, no binding) is untouched by BOTH gates', async () => {
    // `scopes: []` + `projectId: null` is the exact shape of every token
    // minted before #1620/#1635.
    const legacy = seedAuth(harness.db, { displayName: 'legacy-pat' }).headers;
    const res = await harness.server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${harness.taskB}`,
      headers: legacy,
      payload: { description: 'legacy token still works everywhere' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('project binding — project-agnostic surfaces stay reachable', () => {
  it.each([
    ['/api/v1/me', 200],
    ['/api/v1/models', 200],
    ['/health/detailed', 200],
  ] as const)('GET %s is allowed for a bound token', async (url, expected) => {
    const res = await harness.server.inject({
      method: 'GET',
      url,
      headers: boundWriteHeaders(harness.projectA),
    });
    expect(res.statusCode).toBe(expected);
  });
});

describe('route-coverage drift guard — no authenticated route escapes classification', () => {
  // The counterpart to route-scope-coverage.test.ts. An unclassified route
  // resolves to `null` and is REFUSED for bound tokens, so a new route never
  // silently escapes the binding — but a silent denial is still a bug, and
  // this turns it into a loud one at the moment the route is added.
  it('every route in the built authenticated route table has a binding rule', () => {
    const audit = (
      harness.server as unknown as {
        authenticatedRouteAudit: Array<{ method: string; url: string }>;
      }
    ).authenticatedRouteAudit;

    // Sanity floor — an empty audit table would make the assertion vacuous.
    expect(audit.length).toBeGreaterThan(20);

    const unclassified = audit
      .filter((route) => findBindingRule(route.method, route.url) === undefined)
      .map((route) => `${route.method} ${normalizeRouteUrl(route.url)}`);

    expect(
      unclassified,
      `Routes with no project-binding rule (they would be denied to every bound token): ${unclassified.join(', ')}`,
    ).toEqual([]);
  });
});

describe('bindingSatisfiesProjects — the shared predicate', () => {
  it('an unbound principal satisfies everything, including an unresolvable target', () => {
    expect(bindingSatisfiesProjects(null, null)).toBe(true);
    expect(bindingSatisfiesProjects(null, [7])).toBe(true);
  });

  it('a bound principal is refused on an unresolvable target (fail closed)', () => {
    expect(bindingSatisfiesProjects(1, null)).toBe(false);
  });

  it('an empty target set means "no project dimension" and is allowed', () => {
    expect(bindingSatisfiesProjects(1, [])).toBe(true);
  });

  it('EVERY target must match, not merely one', () => {
    expect(bindingSatisfiesProjects(1, [1])).toBe(true);
    expect(bindingSatisfiesProjects(1, [1, 1])).toBe(true);
    expect(bindingSatisfiesProjects(1, [1, 2])).toBe(false);
    expect(bindingSatisfiesProjects(1, [2])).toBe(false);
  });
});
