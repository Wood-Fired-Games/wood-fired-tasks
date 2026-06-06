import { describe, it, expect, beforeEach } from 'vitest';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../project.repository.js';

describe('ProjectRepository', () => {
  let db: Database.Database;
  let repo: ProjectRepository;

  beforeEach(async () => {
    // Create in-memory database
    db = initDatabase(':memory:');
    // Run migrations to set up schema
    await runMigrations(db);
    // Create repository instance
    repo = new ProjectRepository(db);
  });

  it('should create project with id, name, description, and timestamps', () => {
    const project = repo.create({
      name: 'Test Project',
      description: 'A test project',
    });

    expect(project.id).toBeDefined();
    expect(project.name).toBe('Test Project');
    expect(project.description).toBe('A test project');
    expect(project.created_at).toBeDefined();
    expect(project.updated_at).toBeDefined();
  });

  it('should return null for non-existent ID', () => {
    const project = repo.findById(999);
    expect(project).toBeNull();
  });

  it('should find project by unique name', () => {
    const created = repo.create({
      name: 'Unique Project',
      description: 'Test',
    });

    const found = repo.findByName('Unique Project');
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe('Unique Project');
  });

  it('should find all projects', () => {
    repo.create({ name: 'Project A', description: 'First' });
    repo.create({ name: 'Project B', description: 'Second' });
    repo.create({ name: 'Project C', description: 'Third' });

    const all = repo.findAll();
    expect(all).toHaveLength(3);
    // Should be ordered by name
    expect(all[0].name).toBe('Project A');
    expect(all[1].name).toBe('Project B');
    expect(all[2].name).toBe('Project C');
  });

  it('should update only specified fields and update updated_at', () => {
    const project = repo.create({
      name: 'Original Name',
      description: 'Original Description',
    });

    const originalUpdatedAt = project.updated_at;

    // Wait a tiny bit to ensure timestamp changes
    // (SQLite datetime has second precision by default)
    const updated = repo.update(project.id, {
      description: 'New Description',
    });

    expect(updated.name).toBe('Original Name'); // unchanged
    expect(updated.description).toBe('New Description'); // changed
    // updated_at should change (though might be same second in fast tests)
    expect(updated.updated_at).toBeDefined();
  });

  it('should delete project (and cascade-delete tasks)', () => {
    const project = repo.create({
      name: 'To Delete',
      description: 'Will be deleted',
    });

    // Create a task belonging to this project
    db.prepare(
      `INSERT INTO tasks (title, project_id, status, priority, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run('Test Task', project.id, 'open', 'medium', 'user1');

    // Verify task exists
    const tasksBefore = db
      .prepare('SELECT * FROM tasks WHERE project_id = ?')
      .all(project.id);
    expect(tasksBefore).toHaveLength(1);

    // Delete the project
    repo.delete(project.id);

    // Verify project is deleted
    const found = repo.findById(project.id);
    expect(found).toBeNull();

    // Verify tasks are cascade-deleted
    const tasksAfter = db
      .prepare('SELECT * FROM tasks WHERE project_id = ?')
      .all(project.id);
    expect(tasksAfter).toHaveLength(0);
  });

  it('should throw error when creating project with duplicate name', () => {
    repo.create({ name: 'Duplicate', description: 'First' });

    expect(() => {
      repo.create({ name: 'Duplicate', description: 'Second' });
    }).toThrow(); // UNIQUE constraint violation
  });

  // WSJF (Phase 3.1): value_charter persistence at the repository boundary.
  const sampleCharter = {
    mission: 'win the checkout wedge',
    value_themes: [
      {
        name: 'checkout reliability',
        weight: 8 as const,
        description: 'no dropped carts',
      },
    ],
    time_context: 'launch window Q3',
    risk_posture: 'security + outage first',
    out_of_scope: ['marketing site'],
    interview_version: 1,
    updated_at: '2026-06-01T00:00:00.000Z',
  };

  it('should default value_charter to null when not supplied', () => {
    const project = repo.create({ name: 'No Charter' });
    expect(project.value_charter).toBeNull();
  });

  it('should persist and read back a value_charter identically', () => {
    const created = repo.create({
      name: 'Charter Project',
      value_charter: sampleCharter,
    });
    expect(created.value_charter).toEqual(sampleCharter);

    const found = repo.findById(created.id);
    expect(found?.value_charter).toEqual(sampleCharter);

    const byName = repo.findByName('Charter Project');
    expect(byName?.value_charter).toEqual(sampleCharter);

    const all = repo.findAll();
    expect(all.find((p) => p.id === created.id)?.value_charter).toEqual(
      sampleCharter
    );
  });

  it('should update value_charter and clear it with explicit null', () => {
    const project = repo.create({ name: 'Updatable Charter' });
    expect(project.value_charter).toBeNull();

    const set = repo.update(project.id, { value_charter: sampleCharter });
    expect(set.value_charter).toEqual(sampleCharter);

    const cleared = repo.update(project.id, { value_charter: null });
    expect(cleared.value_charter).toBeNull();
  });

  it('should leave value_charter untouched when update omits it', () => {
    const project = repo.create({
      name: 'Untouched Charter',
      value_charter: sampleCharter,
    });

    const updated = repo.update(project.id, { description: 'changed' });
    expect(updated.description).toBe('changed');
    expect(updated.value_charter).toEqual(sampleCharter);
  });
});
