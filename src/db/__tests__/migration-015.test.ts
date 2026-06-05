import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from '../driver.js';

/**
 * Integration tests for migration 015: append-only WSJF audit tables
 * (`wsjf_score_history`, `project_charter_history`, `wsjf_rescore_run`).
 *
 * Verifies (Phase 1 / plan task 1.4, spec §4.3):
 *  - all three tables exist after migrations run;
 *  - the required indexes exist:
 *      (task_id, changed_at), (rescore_run_id), (project_id, interview_version);
 *  - FK columns are present and reference projects(id) / tasks(id) only —
 *    NOT projects.value_charter (added by sibling migration 014);
 *  - an inserted wsjf_score_history row reads back identically;
 *  - down() drops all three tables; up() after down() restores the schema.
 */
describe('migration 015: WSJF audit tables', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  it('creates all three append-only audit tables', () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN
           ('wsjf_score_history','project_charter_history','wsjf_rescore_run')
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      'project_charter_history',
      'wsjf_rescore_run',
      'wsjf_score_history',
    ]);
  });

  it('creates the required indexes', () => {
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name IN
           ('idx_wsjf_score_history_task_changed',
            'idx_wsjf_score_history_rescore_run',
            'idx_project_charter_history_project_version')
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toEqual([
      'idx_project_charter_history_project_version',
      'idx_wsjf_score_history_rescore_run',
      'idx_wsjf_score_history_task_changed',
    ]);

    // Assert index key columns are exactly as the spec requires.
    const taskChanged = db
      .prepare("PRAGMA index_info('idx_wsjf_score_history_task_changed')")
      .all() as Array<{ name: string }>;
    expect(taskChanged.map((c) => c.name)).toEqual(['task_id', 'changed_at']);

    const rescoreRun = db
      .prepare("PRAGMA index_info('idx_wsjf_score_history_rescore_run')")
      .all() as Array<{ name: string }>;
    expect(rescoreRun.map((c) => c.name)).toEqual(['rescore_run_id']);

    const charterVersion = db
      .prepare("PRAGMA index_info('idx_project_charter_history_project_version')")
      .all() as Array<{ name: string }>;
    expect(charterVersion.map((c) => c.name)).toEqual([
      'project_id',
      'interview_version',
    ]);
  });

  it('declares FK columns against projects(id) / tasks(id) only', () => {
    const fks = db
      .prepare("PRAGMA foreign_key_list('wsjf_score_history')")
      .all() as Array<{ table: string; from: string; to: string }>;
    const targets = fks.map((f) => `${f.table}(${f.to})`).sort();
    expect(targets).toEqual([
      'projects(id)',
      'tasks(id)',
      'wsjf_rescore_run(id)',
    ]);
    // Critically: no FK references projects.value_charter (migration 014).
    expect(fks.every((f) => f.to === 'id')).toBe(true);
  });

  it('inserts a wsjf_score_history row that reads back identically', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;
    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by) VALUES (?, ?, ?)`
      )
      .run('t', projectId, 'tester').lastInsertRowid as number;

    const row = {
      task_id: taskId,
      project_id: projectId,
      changed_at: '2026-06-01T12:00:00.000Z',
      trigger: 'create',
      actor_type: 'agent',
      actor_id: 'sess-abc',
      charter_version: 2,
      rescore_run_id: null as number | null,
      value: 13,
      time_criticality: 8,
      risk_opportunity: 5,
      job_size: 5,
      classifications: JSON.stringify({
        themeName: 'reliability',
        alignment: 'core',
        severity: 'security',
        decay: null,
        jobSizeTier: 5,
      }),
      features: JSON.stringify({
        deadlineDate: null,
        daysUntilDeadline: null,
        transitiveDependents: 3,
        filesTouched: 6,
        charterVersion: 2,
      }),
      evidence: JSON.stringify({
        value: 'core reliability',
        timeCriticality: 'within the quarter',
        riskOpportunity: 'security hole',
        jobSize: 'touches six files',
      }),
      source: JSON.stringify({
        value: 'auto',
        timeCriticality: 'auto',
        riskOpportunity: 'auto',
        jobSize: 'auto',
      }),
      locked: JSON.stringify({
        value: false,
        timeCriticality: false,
        riskOpportunity: false,
        jobSize: false,
      }),
      wsjf_score: 5.2,
      prev_wsjf_score: null as number | null,
    };

    const id = db
      .prepare(
        `INSERT INTO wsjf_score_history
           (task_id, project_id, changed_at, trigger, actor_type, actor_id,
            charter_version, rescore_run_id, value, time_criticality,
            risk_opportunity, job_size, classifications, features, evidence,
            source, locked, wsjf_score, prev_wsjf_score)
         VALUES
           (@task_id, @project_id, @changed_at, @trigger, @actor_type, @actor_id,
            @charter_version, @rescore_run_id, @value, @time_criticality,
            @risk_opportunity, @job_size, @classifications, @features, @evidence,
            @source, @locked, @wsjf_score, @prev_wsjf_score)`
      )
      .run(row).lastInsertRowid as number;

    const readBack = db
      .prepare(
        `SELECT task_id, project_id, changed_at, trigger, actor_type, actor_id,
                charter_version, rescore_run_id, value, time_criticality,
                risk_opportunity, job_size, classifications, features, evidence,
                source, locked, wsjf_score, prev_wsjf_score
         FROM wsjf_score_history WHERE id = ?`
      )
      .get(id);

    expect(readBack).toEqual(row);
  });

  it('links wsjf_score_history.rescore_run_id to a wsjf_rescore_run row', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;
    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by) VALUES (?, ?, ?)`
      )
      .run('t', projectId, 'tester').lastInsertRowid as number;

    const runId = db
      .prepare(
        `INSERT INTO wsjf_rescore_run
           (project_id, charter_version, actor_type, actor_id,
            tasks_evaluated, tasks_changed, tasks_skipped_locked, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(projectId, 3, 'agent', 'sess-x', 10, 4, 1, JSON.stringify({ up: 4 }))
      .lastInsertRowid as number;

    const histId = db
      .prepare(
        `INSERT INTO wsjf_score_history
           (task_id, project_id, trigger, rescore_run_id, value)
         VALUES (?, ?, 'rescore', ?, 8)`
      )
      .run(taskId, projectId, runId).lastInsertRowid as number;

    const linked = db
      .prepare('SELECT rescore_run_id FROM wsjf_score_history WHERE id = ?')
      .get(histId) as { rescore_run_id: number };
    expect(linked.rescore_run_id).toBe(runId);
  });

  it('down() drops all three audit tables', async () => {
    const { down } = await import('../migrations/015-wsjf-audit.js');
    await down(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN
           ('wsjf_score_history','project_charter_history','wsjf_rescore_run')`
      )
      .all() as Array<{ name: string }>;
    expect(tables).toEqual([]);

    // Sanity: unrelated tables survive.
    const survivors = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
           AND name IN ('projects','tasks')`
      )
      .all() as Array<{ name: string }>;
    expect(survivors.map((s) => s.name).sort()).toEqual(['projects', 'tasks']);
  });

  it('up() after down() restores the schema (round-trip)', async () => {
    const snapshot = () =>
      db
        .prepare(
          `SELECT name, type, sql FROM sqlite_master
           WHERE name IN
             ('wsjf_score_history','project_charter_history','wsjf_rescore_run',
              'idx_wsjf_score_history_task_changed',
              'idx_wsjf_score_history_rescore_run',
              'idx_project_charter_history_project_version')
           ORDER BY name`
        )
        .all();

    const before = snapshot();
    const { up, down } = await import('../migrations/015-wsjf-audit.js');
    await down(db);
    await up(db);
    expect(snapshot()).toEqual(before);
  });
});
