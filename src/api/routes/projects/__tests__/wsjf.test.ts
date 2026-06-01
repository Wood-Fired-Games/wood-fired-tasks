import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { App } from '../../../../index.js';
import { WsjfRescoreRepository } from '../../../../repositories/wsjf-rescore.repository.js';
import type { ValueCharter } from '../../../../types/task.js';

/**
 * WSJF 4.5 (task #645) — integration tests for the project WSJF REST surface:
 *   GET /api/v1/projects/:id/charter-history  (chronological)
 *   GET /api/v1/projects/:id/rescore-runs     (chronological)
 */

const TEST_KEY = 'test-key-project-wsjf';
const TEST_LABEL = 'project-wsjf-route';

function charter(version: number, mission: string): ValueCharter {
  return {
    mission,
    value_themes: [{ name: 'core', weight: 8, description: 'core theme' }],
    time_context: 'now',
    risk_posture: 'balanced',
    out_of_scope: [],
    interview_version: version,
    updated_at: new Date().toISOString(),
  };
}

describe('project WSJF REST surface', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let projectId: number;
  let prevApiKeys: string | undefined;
  const headers = { 'x-api-key': TEST_KEY };

  beforeAll(async () => {
    prevApiKeys = process.env.API_KEYS;
    process.env.API_KEYS = `${TEST_KEY}:${TEST_LABEL}`;
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;

    // Project with an initial charter, then re-interviewed twice → two prior
    // snapshots in project_charter_history.
    const project = app.projectService.createProject({
      name: 'WSJF Projects',
      value_charter: charter(1, 'mission v1'),
    });
    projectId = project.id;
    app.projectService.updateProject(projectId, {
      value_charter: charter(2, 'mission v2'),
    });
    app.projectService.updateProject(projectId, {
      value_charter: charter(3, 'mission v3'),
    });

    // Seed two rescore runs directly via the repo (its write-lifecycle owner).
    const runs = new WsjfRescoreRepository(db);
    const r1 = runs.open({ projectId, charterVersion: 2 });
    runs.finalize({
      runId: r1,
      tasksEvaluated: 3,
      tasksChanged: 1,
      tasksSkippedLocked: 0,
      summary: 'run one',
    });
    const r2 = runs.open({ projectId, charterVersion: 3 });
    runs.finalize({
      runId: r2,
      tasksEvaluated: 4,
      tasksChanged: 2,
      tasksSkippedLocked: 1,
      summary: 'run two',
    });
  });

  afterAll(async () => {
    await server.close();
    db.close();
    if (prevApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = prevApiKeys;
  });

  it('GET /:id/charter-history returns prior snapshots oldest-first', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/charter-history`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.project_id).toBe(projectId);
    expect(body.total).toBe(body.history.length);
    // Two overwrites → two prior-charter snapshots.
    expect(body.history.length).toBe(2);
    // Chronological by changed_at.
    const times = body.history.map((r: { changed_at: string }) => r.changed_at);
    expect(times).toEqual([...times].sort());
    // First snapshot is the v1 charter that was replaced when v2 landed.
    expect(body.history[0].interview_version).toBe(2);
    expect(body.history[0].charter.mission).toBe('mission v1');
    expect(body.history[1].charter.mission).toBe('mission v2');
  });

  it('GET /:id/rescore-runs returns runs oldest-first with rollup counts', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/rescore-runs`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.project_id).toBe(projectId);
    expect(body.total).toBe(2);
    expect(body.runs.length).toBe(2);
    const times = body.runs.map((r: { triggered_at: string }) => r.triggered_at);
    expect(times).toEqual([...times].sort());
    expect(body.runs[0].summary).toBe('run one');
    expect(body.runs[0].tasks_evaluated).toBe(3);
    expect(body.runs[1].summary).toBe('run two');
    expect(body.runs[1].tasks_skipped_locked).toBe(1);
  });

  it('GET /:id/charter-history returns an empty list for a charter-less project', async () => {
    const bare = app.projectService.createProject({ name: 'No Charter' });
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${bare.id}/charter-history`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(0);
    expect(response.json().history).toEqual([]);
  });

  it('GET /:id/charter-history returns 404 for a missing project', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/99999/charter-history`,
      headers,
    });
    expect(response.statusCode).toBe(404);
  });

  it('GET /:id/rescore-runs returns 404 for a missing project', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/99999/rescore-runs`,
      headers,
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication (no x-api-key → 401)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/charter-history`,
    });
    expect(response.statusCode).toBe(401);
  });
});
