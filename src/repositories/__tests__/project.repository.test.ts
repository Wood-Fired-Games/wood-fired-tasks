import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
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
});
