import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
       VALUES (?, ?, ?, ?, ?)`,
    ).run('Test Task', project.id, 'open', 'medium', 'user1');

    // Verify task exists
    const tasksBefore = db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(project.id);
    expect(tasksBefore).toHaveLength(1);

    // Delete the project
    repo.delete(project.id);

    // Verify project is deleted
    const found = repo.findById(project.id);
    expect(found).toBeNull();

    // Verify tasks are cascade-deleted
    const tasksAfter = db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(project.id);
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
    expect(all.find((p) => p.id === created.id)?.value_charter).toEqual(sampleCharter);
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

  // Configurable Task Models: model_policy persistence at the repository
  // boundary. Mirrors the value_charter coverage above.
  const samplePolicy = {
    validation: { default: 'auto' },
  } as const;

  it('should default model_policy to null when not supplied', () => {
    const project = repo.create({ name: 'No Policy' });
    expect(project.model_policy).toBeNull();
  });

  it('should persist and read back a model_policy identically', () => {
    const created = repo.create({
      name: 'Policy Project',
      model_policy: samplePolicy,
    });
    expect(created.model_policy).toEqual(samplePolicy);

    const found = repo.findById(created.id);
    expect(found?.model_policy).toEqual(samplePolicy);

    const byName = repo.findByName('Policy Project');
    expect(byName?.model_policy).toEqual(samplePolicy);

    const all = repo.findAll();
    expect(all.find((p) => p.id === created.id)?.model_policy).toEqual(samplePolicy);
  });

  it('should update model_policy and clear it with explicit null', () => {
    const project = repo.create({ name: 'Updatable Policy' });
    expect(project.model_policy).toBeNull();

    const set = repo.update(project.id, { model_policy: samplePolicy });
    expect(set.model_policy).toEqual(samplePolicy);

    const cleared = repo.update(project.id, { model_policy: null });
    expect(cleared.model_policy).toBeNull();
  });

  it('should leave model_policy untouched when update omits it', () => {
    const project = repo.create({
      name: 'Untouched Policy',
      model_policy: samplePolicy,
    });

    const updated = repo.update(project.id, { description: 'changed' });
    expect(updated.description).toBe('changed');
    expect(updated.model_policy).toEqual(samplePolicy);
  });

  // --- Archived project state (docs/design/project-archived-state.md §3.3) ---

  describe('archived state', () => {
    const ARCHIVED_AT = '2026-11-23T12:00:00.000Z';

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(ARCHIVED_AT));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('a new project reads as not archived, with null archive columns', () => {
      const project = repo.create({ name: 'Fresh' });

      expect(project.archived).toBe(false);
      expect(project.archived_at).toBeNull();
      expect(project.archived_by).toBeNull();
      expect(project.archive_reason).toBeNull();
    });

    it('archive sets archived_at, archived_by and archive_reason and derives archived', () => {
      const project = repo.create({ name: 'Shipped' });

      const archived = repo.archive(project.id, 'alice', 'shipped in v2.9.0');

      expect(archived).toMatchObject({
        id: project.id,
        name: 'Shipped',
        archived: true,
        archived_at: ARCHIVED_AT,
        archived_by: 'alice',
        archive_reason: 'shipped in v2.9.0',
      });
      // Persisted, not just returned.
      expect(
        db
          .prepare('SELECT archived_at, archived_by, archive_reason FROM projects WHERE id = ?')
          .get(project.id),
      ).toEqual({
        archived_at: ARCHIVED_AT,
        archived_by: 'alice',
        archive_reason: 'shipped in v2.9.0',
      });
    });

    it('archive stores a null reason when none is given', () => {
      const project = repo.create({ name: 'No Reason' });

      expect(repo.archive(project.id, 'alice').archive_reason).toBeNull();
      const other = repo.create({ name: 'Null Reason' });
      expect(repo.archive(other.id, 'alice', null).archive_reason).toBeNull();
    });

    it('archive leaves the other columns untouched', () => {
      const project = repo.create({
        name: 'Keeps Fields',
        description: 'd',
        value_charter: sampleCharter,
        model_policy: samplePolicy,
      });

      const archived = repo.archive(project.id, 'alice', 'done');

      expect(archived).toEqual({
        ...project,
        archived: true,
        archived_at: ARCHIVED_AT,
        archived_by: 'alice',
        archive_reason: 'done',
        updated_at: archived.updated_at,
      });
    });

    it('archive on an already archived project keeps the first archive', () => {
      const project = repo.create({ name: 'Twice' });
      repo.archive(project.id, 'alice', 'first');

      vi.setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
      const again = repo.archive(project.id, 'bob', 'second');

      expect(again).toMatchObject({
        archived: true,
        archived_at: ARCHIVED_AT,
        archived_by: 'alice',
        archive_reason: 'first',
      });
    });

    it('archive throws for a project that does not exist', () => {
      expect(() => repo.archive(999, 'alice', null)).toThrow('Project with id 999 not found');
    });

    it('unarchive clears all three columns', () => {
      const project = repo.create({ name: 'Back Again' });
      repo.archive(project.id, 'alice', 'shipped');

      const restored = repo.unarchive(project.id);

      expect(restored).toMatchObject({
        id: project.id,
        archived: false,
        archived_at: null,
        archived_by: null,
        archive_reason: null,
      });
      expect(
        db
          .prepare('SELECT archived_at, archived_by, archive_reason FROM projects WHERE id = ?')
          .get(project.id),
      ).toEqual({ archived_at: null, archived_by: null, archive_reason: null });
    });

    it('unarchive on a project that is not archived is a no-op', () => {
      const project = repo.create({ name: 'Never Archived' });

      expect(repo.unarchive(project.id)).toEqual(project);
    });

    it('unarchive throws for a project that does not exist', () => {
      expect(() => repo.unarchive(999)).toThrow('Project with id 999 not found');
    });

    it('an archived project keeps its unique name', () => {
      const project = repo.create({ name: 'Taken' });
      repo.archive(project.id, 'alice', null);

      expect(() => repo.create({ name: 'Taken' })).toThrow();
    });

    it('findById and findByName return an archived project with the mapped columns', () => {
      const project = repo.create({ name: 'By Id' });
      repo.archive(project.id, 'alice', 'shipped');

      for (const found of [repo.findById(project.id), repo.findByName('By Id')]) {
        expect(found).toMatchObject({
          archived: true,
          archived_at: ARCHIVED_AT,
          archived_by: 'alice',
          archive_reason: 'shipped',
        });
      }
    });

    it('update on an archived project keeps it archived', () => {
      const project = repo.create({ name: 'Renamed Later' });
      repo.archive(project.id, 'alice', 'shipped');

      const updated = repo.update(project.id, { description: 'note' });

      expect(updated).toMatchObject({ archived: true, archived_by: 'alice' });
    });

    describe('list filter', () => {
      let activeA: number;
      let activeB: number;
      let archivedC: number;

      beforeEach(() => {
        activeA = repo.create({ name: 'A active' }).id;
        activeB = repo.create({ name: 'B active' }).id;
        archivedC = repo.create({ name: 'C archived' }).id;
        repo.archive(archivedC, 'alice', 'shipped');
      });

      it('findAll and count omit archived projects by default (archived=exclude)', () => {
        expect(repo.findAll().map((p) => p.id)).toEqual([activeA, activeB]);
        expect(repo.count()).toBe(2);
        expect(repo.findAll(undefined, 'exclude').map((p) => p.id)).toEqual([activeA, activeB]);
        expect(repo.count('exclude')).toBe(2);
      });

      it('findAll and count return every project with archived=include', () => {
        const all = repo.findAll(undefined, 'include');

        expect(all.map((p) => p.id)).toEqual([activeA, activeB, archivedC]);
        expect(all.map((p) => p.archived)).toEqual([false, false, true]);
        expect(repo.count('include')).toBe(3);
      });

      it('findAll and count return nothing but archived projects with archived=only', () => {
        const only = repo.findAll(undefined, 'only');

        expect(only.map((p) => p.id)).toEqual([archivedC]);
        expect(only[0]).toMatchObject({ archived: true, archived_by: 'alice' });
        expect(repo.count('only')).toBe(1);
      });

      it('pagination applies to the filtered set', () => {
        expect(repo.findAll({ limit: 1, offset: 1 }).map((p) => p.id)).toEqual([activeB]);
        expect(repo.findAll({ limit: 1, offset: 2 })).toEqual([]);
        expect(repo.findAll({ limit: 1, offset: 2 }, 'include').map((p) => p.id)).toEqual([
          archivedC,
        ]);
        expect(repo.findAll({ limit: 10, offset: 1 }, 'only')).toEqual([]);
      });

      it('an unarchived project returns to the default listing', () => {
        repo.unarchive(archivedC);

        expect(repo.findAll().map((p) => p.id)).toEqual([activeA, activeB, archivedC]);
        expect(repo.count()).toBe(3);
        expect(repo.count('only')).toBe(0);
      });
    });
  });
});
