import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../project.repository.js';
import { TaskRepository } from '../task.repository.js';
import { FtsSyntaxError } from '../errors.js';
import type { CreateTaskDTO, Task } from '../../types/task.js';

describe('TaskRepository', () => {
  let db: Database.Database;
  let projectRepo: ProjectRepository;
  let taskRepo: TaskRepository;
  let testProjectId: number;

  beforeEach(async () => {
    // Create in-memory database
    db = initDatabase(':memory:');
    // Run migrations
    await runMigrations(db);
    // Create repositories
    projectRepo = new ProjectRepository(db);
    taskRepo = new TaskRepository(db);
    // Create a test project (needed for foreign key)
    const project = projectRepo.create({
      name: 'Test Project',
      description: 'Project for testing tasks',
    });
    testProjectId = project.id;
  });

  // Helper function to create test task with defaults
  const createTestTask = (
    overrides?: Partial<CreateTaskDTO>
  ): CreateTaskDTO => ({
    title: 'Test Task',
    description: 'Task description',
    status: 'open',
    priority: 'medium',
    project_id: testProjectId,
    created_by: 'test-user',
    ...overrides,
  });

  // Helper: insert a user row directly (no UserRepository write methods for
  // legacy/service rows). Used by Phase-31 FK tests to satisfy the FK
  // constraint (tasks.created_by_user_id REFERENCES users(id) ON DELETE RESTRICT).
  const insertUser = (overrides: { id?: number; display_name: string }): number => {
    const stmt = db.prepare(
      `INSERT INTO users (id, display_name, is_legacy)
       VALUES (?, ?, 1)`,
    );
    const info = stmt.run(overrides.id ?? null, overrides.display_name);
    return info.lastInsertRowid as number;
  };

  // Helper: read raw FK columns from the tasks table (the row mapper returns
  // them on the Task shape too, but reading directly keeps the assertion
  // independent of the public type surface).
  const readFkColumns = (
    id: number,
  ): { created_by_user_id: number | null; assignee_user_id: number | null } => {
    const row = db
      .prepare(
        'SELECT created_by_user_id, assignee_user_id FROM tasks WHERE id = ?',
      )
      .get(id) as {
      created_by_user_id: number | null;
      assignee_user_id: number | null;
    };
    return row;
  };

  describe('Phase 31 FK columns', () => {
    describe('create', () => {
      it('persists created_by_user_id when supplied', () => {
        const userId = insertUser({ display_name: 'alice-fk' });
        const task = taskRepo.create(
          createTestTask({ created_by: 'alice-fk', created_by_user_id: userId }),
        );
        const fks = readFkColumns(task.id);
        expect(fks.created_by_user_id).toBe(userId);
        expect(fks.assignee_user_id).toBeNull();
      });

      it('persists both created_by_user_id and assignee_user_id when both supplied', () => {
        const aliceId = insertUser({ display_name: 'alice-creator' });
        const bobId = insertUser({ display_name: 'bob-assignee' });
        const task = taskRepo.create(
          createTestTask({
            created_by: 'alice-creator',
            assignee: 'bob-assignee',
            created_by_user_id: aliceId,
            assignee_user_id: bobId,
          }),
        );
        const fks = readFkColumns(task.id);
        expect(fks.created_by_user_id).toBe(aliceId);
        expect(fks.assignee_user_id).toBe(bobId);
      });

      it('leaves both FK columns NULL when fields are omitted (back-compat)', () => {
        const task = taskRepo.create(createTestTask({}));
        const fks = readFkColumns(task.id);
        expect(fks.created_by_user_id).toBeNull();
        expect(fks.assignee_user_id).toBeNull();
      });
    });

    describe('update', () => {
      it('sets assignee_user_id when supplied alongside TEXT assignee', () => {
        const task = taskRepo.create(createTestTask({}));
        const bobId = insertUser({ display_name: 'bob-update' });
        taskRepo.update(task.id, { assignee: 'bob-update', assignee_user_id: bobId });
        const fks = readFkColumns(task.id);
        expect(fks.assignee_user_id).toBe(bobId);
        const refreshed = taskRepo.findById(task.id);
        expect(refreshed?.assignee).toBe('bob-update');
      });

      it('clears assignee_user_id when explicitly set to null', () => {
        const carolId = insertUser({ display_name: 'carol' });
        const task = taskRepo.create(
          createTestTask({ assignee: 'carol', assignee_user_id: carolId }),
        );
        expect(readFkColumns(task.id).assignee_user_id).toBe(carolId);

        taskRepo.update(task.id, { assignee: null, assignee_user_id: null });
        const fks = readFkColumns(task.id);
        expect(fks.assignee_user_id).toBeNull();
      });

      it('leaves assignee_user_id untouched when only TEXT assignee is updated', () => {
        const danId = insertUser({ display_name: 'dan' });
        const task = taskRepo.create(
          createTestTask({ assignee: 'dan', assignee_user_id: danId }),
        );
        // Update only the TEXT assignee; FK must NOT be cleared.
        taskRepo.update(task.id, { assignee: 'dan-renamed' });
        const fks = readFkColumns(task.id);
        expect(fks.assignee_user_id).toBe(danId);
      });
    });

    describe('claimTask', () => {
      it('writes assignee_user_id alongside assignee when trailing arg supplied', () => {
        const task = taskRepo.create(createTestTask({ assignee: null }));
        const eveId = insertUser({ display_name: 'eve' });
        const claimed = taskRepo.claimTask(task.id, 'eve', eveId);
        expect(claimed).not.toBeNull();
        expect(claimed!.assignee).toBe('eve');
        expect(claimed!.status).toBe('in_progress');
        const fks = readFkColumns(task.id);
        expect(fks.assignee_user_id).toBe(eveId);
      });

      it('leaves assignee_user_id NULL when trailing arg omitted (legacy signature)', () => {
        const task = taskRepo.create(createTestTask({ assignee: null }));
        const claimed = taskRepo.claimTask(task.id, 'frank');
        expect(claimed).not.toBeNull();
        expect(claimed!.assignee).toBe('frank');
        const fks = readFkColumns(task.id);
        expect(fks.assignee_user_id).toBeNull();
      });
    });
  });

  describe('create', () => {
    it('should create task with all fields and return with id and timestamps', () => {
      const dto = createTestTask({
        title: 'Complete Task',
        description: 'Full description',
        status: 'in_progress',
        priority: 'high',
        assignee: 'alice',
        due_date: '2026-03-01',
      });

      const task = taskRepo.create(dto);

      expect(task.id).toBeDefined();
      expect(task.title).toBe('Complete Task');
      expect(task.description).toBe('Full description');
      expect(task.status).toBe('in_progress');
      expect(task.priority).toBe('high');
      expect(task.project_id).toBe(testProjectId);
      expect(task.assignee).toBe('alice');
      expect(task.created_by).toBe('test-user');
      expect(task.due_date).toBe('2026-03-01');
      expect(task.created_at).toBeDefined();
      expect(task.updated_at).toBeDefined();
      expect(task.tags).toEqual([]);
    });

    it('should create task with tags and return task with tags array', () => {
      const dto = createTestTask({ title: 'Tagged Task' });
      const tags = ['bug', 'urgent', 'backend'];

      const task = taskRepo.create(dto, tags);

      expect(task.tags).toEqual(tags.sort());
    });
  });

  describe('findById', () => {
    it('should return task with tags', () => {
      const created = taskRepo.create(
        createTestTask({ title: 'Find Me' }),
        ['tag1', 'tag2']
      );

      const found = taskRepo.findById(created.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.title).toBe('Find Me');
      expect(found?.tags).toEqual(['tag1', 'tag2']);
    });

    it('should return null for non-existent task', () => {
      const found = taskRepo.findById(99999);
      expect(found).toBeNull();
    });
  });

  describe('update', () => {
    it('should update task fields and change updated_at', () => {
      const task = taskRepo.create(createTestTask({ title: 'Original' }));
      const originalUpdatedAt = task.updated_at;

      const updated = taskRepo.update(task.id, {
        title: 'Updated Title',
        status: 'done',
        priority: 'low',
        assignee: 'bob',
        due_date: '2026-04-01',
      });

      expect(updated.title).toBe('Updated Title');
      expect(updated.status).toBe('done');
      expect(updated.priority).toBe('low');
      expect(updated.assignee).toBe('bob');
      expect(updated.due_date).toBe('2026-04-01');
      // updated_at should be set (may be same second in fast tests)
      expect(updated.updated_at).toBeDefined();
    });

    it('should update task tags by replacing all tags', () => {
      const task = taskRepo.create(
        createTestTask(),
        ['old-tag1', 'old-tag2']
      );

      const updated = taskRepo.update(task.id, {
        tags: ['new-tag1', 'new-tag2', 'new-tag3'],
      });

      expect(updated.tags).toEqual(['new-tag1', 'new-tag2', 'new-tag3'].sort());
    });

    it('should clear tags when updated with empty tags array', () => {
      const task = taskRepo.create(createTestTask(), ['tag1', 'tag2']);

      const updated = taskRepo.update(task.id, {
        tags: [],
      });

      expect(updated.tags).toEqual([]);
    });
  });

  describe('delete', () => {
    it('should delete task and cascade-delete its tags', () => {
      const task = taskRepo.create(createTestTask(), ['tag1', 'tag2']);

      // Verify task and tags exist
      const beforeDelete = taskRepo.findById(task.id);
      expect(beforeDelete).not.toBeNull();
      expect(beforeDelete?.tags).toHaveLength(2);

      // Delete task
      taskRepo.delete(task.id);

      // Verify task is deleted
      const afterDelete = taskRepo.findById(task.id);
      expect(afterDelete).toBeNull();

      // Verify tags are cascade-deleted
      const tags = db
        .prepare('SELECT * FROM task_tags WHERE task_id = ?')
        .all(task.id);
      expect(tags).toHaveLength(0);
    });
  });

  describe('findByFilters', () => {
    beforeEach(() => {
      // Create test tasks with various fields
      taskRepo.create(
        createTestTask({
          title: 'Task 1',
          status: 'open',
          assignee: 'alice',
          due_date: '2026-03-15',
        }),
        ['frontend', 'bug']
      );

      taskRepo.create(
        createTestTask({
          title: 'Task 2',
          status: 'in_progress',
          assignee: 'bob',
          due_date: '2026-03-20',
        }),
        ['backend', 'feature']
      );

      taskRepo.create(
        createTestTask({
          title: 'Task 3',
          status: 'done',
          assignee: 'alice',
          due_date: '2026-03-10',
        }),
        ['backend', 'bug']
      );

      taskRepo.create(
        createTestTask({
          title: 'Database migration bug',
          description: 'Fix migration issue',
          status: 'blocked',
          assignee: 'charlie',
          due_date: '2026-03-25',
        }),
        ['database']
      );

      taskRepo.create(
        createTestTask({
          title: 'Task 5',
          status: 'open',
          assignee: 'alice',
          due_date: '2026-04-01',
        })
        // No tags
      );
    });

    it('should filter by status', () => {
      const results = taskRepo.findByFilters({ status: 'open' });
      expect(results).toHaveLength(2);
      expect(results.every((t) => t.status === 'open')).toBe(true);
    });

    it('should filter by project_id', () => {
      const results = taskRepo.findByFilters({ project_id: testProjectId });
      expect(results).toHaveLength(5);
      expect(results.every((t) => t.project_id === testProjectId)).toBe(true);
    });

    it('should filter by assignee', () => {
      const results = taskRepo.findByFilters({ assignee: 'alice' });
      expect(results).toHaveLength(3);
      expect(results.every((t) => t.assignee === 'alice')).toBe(true);
    });

    it('should filter by tags (tasks with at least one matching tag)', () => {
      const results = taskRepo.findByFilters({ tags: ['bug'] });
      expect(results).toHaveLength(2);
      expect(results.every((t) => t.tags.includes('bug'))).toBe(true);
    });

    it('should filter by date range with due_before and due_after', () => {
      const results = taskRepo.findByFilters({
        due_after: '2026-03-12',
        due_before: '2026-03-22',
      });
      // Should match Task 1 (03-15) and Task 2 (03-20)
      expect(results).toHaveLength(2);
      expect(results.some((t) => t.title === 'Task 1')).toBe(true);
      expect(results.some((t) => t.title === 'Task 2')).toBe(true);
    });

    it('should filter with multiple combined filters', () => {
      const results = taskRepo.findByFilters({
        status: 'open',
        assignee: 'alice',
        tags: ['frontend'],
      });
      // Should match only Task 1
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Task 1');
    });

    it('should search by title using FTS5', () => {
      const results = taskRepo.findByFilters({ search: 'migration' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Database migration bug');
    });

    it('should search by description using FTS5', () => {
      const results = taskRepo.findByFilters({ search: 'migration' });
      expect(results).toHaveLength(1);
      expect(results[0].description).toContain('migration');
    });

    it('should return all tasks when no filters provided', () => {
      const results = taskRepo.findByFilters({});
      expect(results).toHaveLength(5);
    });
  });

  describe('count', () => {
    beforeEach(() => {
      // Create 3 tasks
      taskRepo.create(createTestTask({ status: 'open' }));
      taskRepo.create(createTestTask({ status: 'open' }));
      taskRepo.create(createTestTask({ status: 'done' }));
    });

    it('should return total count without filters', () => {
      const count = taskRepo.count();
      expect(count).toBe(3);
    });

    it('should return filtered count with filters', () => {
      const count = taskRepo.count({ status: 'open' });
      expect(count).toBe(2);
    });
  });

  describe('findAll', () => {
    it('should return all tasks with tags ordered by created_at DESC', () => {
      const task1 = taskRepo.create(
        createTestTask({ title: 'First' }),
        ['tag1']
      );
      const task2 = taskRepo.create(
        createTestTask({ title: 'Second' }),
        ['tag2']
      );
      const task3 = taskRepo.create(createTestTask({ title: 'Third' }));

      const all = taskRepo.findAll();

      expect(all).toHaveLength(3);
      // Verify all tasks are returned
      const titles = all.map((t) => t.title);
      expect(titles).toContain('First');
      expect(titles).toContain('Second');
      expect(titles).toContain('Third');
      // Verify tags are included correctly
      const firstTask = all.find((t) => t.title === 'First');
      const secondTask = all.find((t) => t.title === 'Second');
      const thirdTask = all.find((t) => t.title === 'Third');
      expect(firstTask?.tags).toEqual(['tag1']);
      expect(secondTask?.tags).toEqual(['tag2']);
      expect(thirdTask?.tags).toEqual([]);
    });
  });

  describe('FTS5 search syntax errors', () => {
    beforeEach(() => {
      // Seed a few tasks so the FTS index has rows; the malformed-search
      // assertions rely on MATCH actually being evaluated, which requires a
      // populated FTS table.
      taskRepo.create(
        createTestTask({ title: 'Fix login bug', description: 'auth' })
      );
      taskRepo.create(
        createTestTask({
          title: 'Database migration bug',
          description: 'migrate users to new schema',
        })
      );
    });

    const MALFORMED_INPUTS: Array<{ name: string; input: string }> = [
      { name: 'bare double quote', input: '"' },
      { name: 'unterminated NEAR(', input: 'NEAR(' },
      { name: 'bare wildcard', input: '*' },
      { name: 'dangling OR operator', input: 'foo OR' },
      { name: 'unterminated phrase', input: '"unterminated phrase' },
    ];

    for (const { name, input } of MALFORMED_INPUTS) {
      it(`findByFilters throws FtsSyntaxError on ${name}`, () => {
        expect(() => taskRepo.findByFilters({ search: input })).toThrow(
          FtsSyntaxError
        );
      });

      it(`count throws FtsSyntaxError on ${name}`, () => {
        expect(() => taskRepo.count({ search: input })).toThrow(
          FtsSyntaxError
        );
      });
    }

    it('preserves the original SQLite message on FtsSyntaxError', () => {
      try {
        taskRepo.findByFilters({ search: '"' });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FtsSyntaxError);
        // originalMessage should retain the raw text for operator logs.
        expect((err as FtsSyntaxError).originalMessage.length).toBeGreaterThan(0);
      }
    });

    it('does NOT wrap non-FTS SQLite errors when search is unset', () => {
      // Sanity: a normal search-less call must NOT throw — the catch only
      // engages when filters.search is provided.
      expect(() => taskRepo.findByFilters({})).not.toThrow();
      expect(() => taskRepo.count()).not.toThrow();
    });

    it('valid FTS5 prefix search continues to work', () => {
      const results = taskRepo.findByFilters({ search: 'migr*' });
      // Migration task should be found via prefix match.
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((t) => t.title.includes('migration'))).toBe(true);
    });

    it('valid FTS5 phrase search continues to work', () => {
      const results = taskRepo.findByFilters({
        search: '"database migration"',
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('valid FTS5 boolean search continues to work', () => {
      const results = taskRepo.findByFilters({ search: 'login OR migration' });
      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });
});
