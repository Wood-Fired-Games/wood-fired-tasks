import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../../../db/driver.js';
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

/**
 * WSJF 1.10 remote-parity REST surface:
 *   GET  /api/v1/projects/:id/wsjf-ranking?scope=frontier|all
 *   GET  /api/v1/projects/:id/wsjf-health
 *   POST /api/v1/projects/:id/rescore  (MUTATION)
 *
 * These back the remote MCP proxy tools wsjf_ranking / wsjf_health /
 * rescore_project (the stdio↔remote parity rule). Seeding mirrors the
 * wsjf-rescore service tests: a charter with weighted themes + scored tasks
 * whose evidence spans are verbatim substrings of the task text so the
 * deterministic gate accepts the written-back submissions.
 */
const RANK_KEY = 'test-key-wsjf-rank';
const RANK_LABEL = 'wsjf-rank-route';

function rescoreCharter(): ValueCharter {
  return {
    mission: 'Ship a reliable storefront',
    value_themes: [
      { name: 'reliability', weight: 13, description: 'keep checkout working' },
      { name: 'growth', weight: 5, description: 'acquire new users' },
    ],
    time_context: 'launch window closes Q3',
    risk_posture: 'avoid data loss at all costs',
    out_of_scope: [],
    interview_version: 2,
    updated_at: '2026-06-01T00:00:00.000Z',
  };
}

describe('project WSJF remote-parity REST surface', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let projectId: number;
  let taskA: number;
  let prevApiKeys: string | undefined;
  const headers = { 'x-api-key': RANK_KEY };

  // A full auto WSJF write whose evidence spans are verbatim substrings of the
  // seed description (so the gate accepts the rescore submission).
  const seedDescription =
    'aligns with reliability theme; launch window closes Q3';
  const autoWsjf = {
    value: 13,
    timeCriticality: 8,
    riskOpportunity: 8,
    jobSize: 2,
    evidence: {
      value: 'aligns with reliability theme',
      timeCriticality: 'launch window closes Q3',
      riskOpportunity: 'launch window closes Q3',
      jobSize: 'aligns with reliability theme',
    },
    source: {
      value: 'auto' as const,
      timeCriticality: 'auto' as const,
      riskOpportunity: 'auto' as const,
      jobSize: 'auto' as const,
    },
    classifications: {
      themeName: 'reliability',
      alignment: 'core' as const,
      severity: 'data_loss' as const,
      decay: null,
      jobSizeTier: 2 as const,
      evidence: {
        value: 'aligns with reliability theme',
        timeCriticality: 'launch window closes Q3',
        riskOpportunity: 'launch window closes Q3',
        jobSize: 'aligns with reliability theme',
      },
    },
    features: {
      deadlineDate: null,
      daysUntilDeadline: 5,
      transitiveDependents: 0,
      filesTouched: 2,
      charterVersion: 2,
    },
  };

  // A WEAK-alignment submission → UBV (value) drops from 13 (core) to 5, so
  // the rescore changes the value component.
  const weakSubmission = {
    classification: {
      themeName: 'reliability',
      alignment: 'weak',
      severity: 'data_loss',
      decay: null,
      jobSizeTier: 2,
      evidence: {
        value: 'aligns with reliability theme',
        timeCriticality: 'launch window closes Q3',
        riskOpportunity: 'launch window closes Q3',
        jobSize: 'aligns with reliability theme',
      },
    },
    features: {
      deadlineDate: null,
      daysUntilDeadline: 5,
      transitiveDependents: 0,
      filesTouched: 2,
      charterVersion: 2,
    },
  };

  beforeAll(async () => {
    prevApiKeys = process.env.API_KEYS;
    process.env.API_KEYS = `${RANK_KEY}:${RANK_LABEL}`;
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;

    const project = app.projectService.createProject({
      name: 'Rescore Project',
      value_charter: rescoreCharter(),
    });
    projectId = project.id;

    taskA = app.taskService.createTask({
      title: 'Fix checkout',
      description: seedDescription,
      priority: 'medium',
      project_id: projectId,
      created_by: 'tester',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsjf: autoWsjf as any,
    }).id;
    app.taskService.createTask({
      title: 'Improve onboarding',
      description: seedDescription,
      priority: 'low',
      project_id: projectId,
      created_by: 'tester',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsjf: {
        ...autoWsjf,
        value: 5,
        timeCriticality: 3,
        riskOpportunity: 2,
        jobSize: 8,
      } as any,
    });
  });

  afterAll(async () => {
    await server.close();
    db.close();
    if (prevApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = prevApiKeys;
  });

  it('GET /:id/wsjf-ranking returns tasks ordered by descending effectiveWsjf', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/wsjf-ranking?scope=all`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.project_id).toBe(projectId);
    expect(body.scope).toBe('all');
    expect(body.total).toBe(body.ranking.length);
    expect(body.ranking.length).toBe(2);
    for (let i = 1; i < body.ranking.length; i++) {
      expect(body.ranking[i - 1].effectiveWsjf).toBeGreaterThanOrEqual(
        body.ranking[i].effectiveWsjf,
      );
    }
    // The high-value task (13/8/8 over jobSize 2) ranks first.
    expect(body.ranking[0].taskId).toBe(taskA);
    expect(body.ranking[0]).toHaveProperty('propagation');
  });

  it('GET /:id/wsjf-ranking defaults scope to frontier', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/wsjf-ranking`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().scope).toBe('frontier');
  });

  it('GET /:id/wsjf-ranking returns 404 for a missing project', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/99999/wsjf-ranking`,
      headers,
    });
    expect(response.statusCode).toBe(404);
  });

  it('GET /:id/wsjf-health returns findings on a degenerate fixture', async () => {
    // A fresh project whose two scored tasks have near-identical scores →
    // degenerate-spread finding (warning).
    const degenerate = app.projectService.createProject({
      name: 'Degenerate',
      value_charter: rescoreCharter(),
    });
    for (const t of ['One', 'Two', 'Three']) {
      app.taskService.createTask({
        title: t,
        description: seedDescription,
        priority: 'medium',
        project_id: degenerate.id,
        created_by: 'tester',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wsjf: { ...autoWsjf, value: 8, timeCriticality: 8, riskOpportunity: 8, jobSize: 8 } as any,
      });
    }
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${degenerate.id}/wsjf-health`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.project_id).toBe(degenerate.id);
    expect(body.scored_task_count).toBe(3);
    expect(body.healthy).toBe(false);
    expect(body.findings.length).toBeGreaterThan(0);
    expect(body.findings.every((f: { check: string }) => typeof f.check === 'string')).toBe(true);
  });

  it('GET /:id/wsjf-health returns 404 for a missing project', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/99999/wsjf-health`,
      headers,
    });
    expect(response.statusCode).toBe(404);
  });

  it('POST /:id/rescore writes a run + history row and respects locks', async () => {
    // Lock-aware project: one task with value LOCKED, one unlocked. The weak
    // submission would drop value to 5; the locked task preserves 13.
    const lockProject = app.projectService.createProject({
      name: 'Lock Project',
      value_charter: rescoreCharter(),
    });
    const lockedTask = app.taskService.createTask({
      title: 'Locked task',
      description: seedDescription,
      priority: 'medium',
      project_id: lockProject.id,
      created_by: 'tester',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsjf: {
        ...autoWsjf,
        locked: { value: true, timeCriticality: false, riskOpportunity: false, jobSize: false },
      } as any,
    }).id;
    const unlockedTask = app.taskService.createTask({
      title: 'Unlocked task',
      description: seedDescription,
      priority: 'medium',
      project_id: lockProject.id,
      created_by: 'tester',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsjf: autoWsjf as any,
    }).id;

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${lockProject.id}/rescore`,
      headers,
      payload: {
        submissions: [
          { task_id: lockedTask, classification: weakSubmission.classification, features: weakSubmission.features },
          { task_id: unlockedTask, classification: weakSubmission.classification, features: weakSubmission.features },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run_id).toBeGreaterThan(0);
    expect(body.project_id).toBe(lockProject.id);
    expect(body.tasks_evaluated).toBe(2);
    expect(body.tasks_skipped_locked).toBe(1);
    expect(body.errors).toEqual([]);

    // Locked task preserved value=13; unlocked task recomputed value to 5.
    const lockedResult = body.results.find((r: { taskId: number }) => r.taskId === lockedTask);
    const unlockedResult = body.results.find((r: { taskId: number }) => r.taskId === unlockedTask);
    expect(lockedResult.components.value).toBe(13);
    expect(lockedResult.skippedLocked).toContain('value');
    expect(unlockedResult.components.value).toBe(5);
    expect(unlockedResult.changed).toBe(true);

    // A run row was persisted (queryable via the sibling rescore-runs route).
    const runs = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${lockProject.id}/rescore-runs`,
      headers,
    });
    expect(runs.json().total).toBe(1);

    // The unlocked task gained a rescore-trigger history row.
    const hist = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${unlockedTask}/score-history`,
      headers,
    });
    expect(hist.statusCode).toBe(200);
    const histBody = hist.json();
    expect(
      histBody.history.some((h: { trigger: string }) => h.trigger === 'rescore'),
    ).toBe(true);
  });

  it('POST /:id/rescore rejects malformed input (bad task_id) with 400', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/rescore`,
      headers,
      payload: {
        submissions: [
          { task_id: -1, classification: {}, features: {} },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /:id/rescore surfaces contradictory submissions as per-task errors (200)', async () => {
    // A well-formed-but-bogus submission (evidence span not in the task text)
    // fails the deterministic gate → recorded in errors[], not a 400, matching
    // the stdio rescore_project semantics.
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/rescore`,
      headers,
      payload: {
        submissions: [
          {
            task_id: taskA,
            classification: {
              themeName: 'reliability',
              alignment: 'weak',
              severity: 'data_loss',
              decay: null,
              jobSizeTier: 2,
              evidence: {
                value: 'this span is not in the task text',
                timeCriticality: 'neither is this one',
                riskOpportunity: 'nor this',
                jobSize: 'and not this',
              },
            },
            features: weakSubmission.features,
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.errors.length).toBe(1);
    expect(body.errors[0].taskId).toBe(taskA);
  });

  it('POST /:id/rescore returns 404 for a missing project', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/99999/rescore`,
      headers,
      payload: { submissions: [] },
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication (no x-api-key → 401)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/wsjf-ranking`,
    });
    expect(response.statusCode).toBe(401);
  });
});
