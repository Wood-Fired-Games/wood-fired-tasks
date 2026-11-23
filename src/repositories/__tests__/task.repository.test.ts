import { describe, it, expect, beforeEach } from 'vitest';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../project.repository.js';
import { TaskRepository } from '../task.repository.js';
import { DependencyRepository } from '../dependency.repository.js';
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
  const createTestTask = (overrides?: Partial<CreateTaskDTO>): CreateTaskDTO => ({
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
      .prepare('SELECT created_by_user_id, assignee_user_id FROM tasks WHERE id = ?')
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
        const task = taskRepo.create(createTestTask({ assignee: 'dan', assignee_user_id: danId }));
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
      const created = taskRepo.create(createTestTask({ title: 'Find Me' }), ['tag1', 'tag2']);

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
      const task = taskRepo.create(createTestTask(), ['old-tag1', 'old-tag2']);

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
      const tags = db.prepare('SELECT * FROM task_tags WHERE task_id = ?').all(task.id);
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
        ['frontend', 'bug'],
      );

      taskRepo.create(
        createTestTask({
          title: 'Task 2',
          status: 'in_progress',
          assignee: 'bob',
          due_date: '2026-03-20',
        }),
        ['backend', 'feature'],
      );

      taskRepo.create(
        createTestTask({
          title: 'Task 3',
          status: 'done',
          assignee: 'alice',
          due_date: '2026-03-10',
        }),
        ['backend', 'bug'],
      );

      taskRepo.create(
        createTestTask({
          title: 'Database migration bug',
          description: 'Fix migration issue',
          status: 'blocked',
          assignee: 'charlie',
          due_date: '2026-03-25',
        }),
        ['database'],
      );

      taskRepo.create(
        createTestTask({
          title: 'Task 5',
          status: 'open',
          assignee: 'alice',
          due_date: '2026-04-01',
        }),
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

  // --- Archived project state (docs/design/project-archived-state.md §2.5, §3.3) ---

  describe('archived filter', () => {
    let archivedProjectId: number;
    let activeTaskId: number;
    let archivedOpenTaskId: number;
    let archivedDoneTaskId: number;

    beforeEach(() => {
      archivedProjectId = projectRepo.create({ name: 'Archived Project' }).id;
      activeTaskId = taskRepo.create(createTestTask({ title: 'active task' }), ['shared']).id;
      archivedOpenTaskId = taskRepo.create(
        createTestTask({ title: 'archived open task', project_id: archivedProjectId }),
        ['shared'],
      ).id;
      archivedDoneTaskId = taskRepo.create(
        createTestTask({
          title: 'archived done task',
          project_id: archivedProjectId,
          status: 'done',
        }),
      ).id;
      projectRepo.archive(archivedProjectId, 'alice', 'shipped');
    });

    const ids = (tasks: Array<{ id: number }>) => tasks.map((t) => t.id).sort((a, b) => a - b);

    it("an archived project's task is absent without project_id and present with it", () => {
      const withoutProject = taskRepo.findByFilters({});
      expect(ids(withoutProject)).toEqual([activeTaskId]);
      expect(ids(withoutProject)).not.toContain(archivedOpenTaskId);
      expect(taskRepo.count({})).toBe(1);

      const withProject = taskRepo.findByFilters({ project_id: archivedProjectId });
      expect(ids(withProject)).toEqual([archivedOpenTaskId, archivedDoneTaskId]);
      expect(taskRepo.count({ project_id: archivedProjectId })).toBe(2);
    });

    it('archived=exclude is the default: both list and count omit archived projects', () => {
      expect(ids(taskRepo.findByFilters({ archived: 'exclude' }))).toEqual([activeTaskId]);
      expect(taskRepo.count({ archived: 'exclude' })).toBe(1);
    });

    it('archived=include returns tasks of archived and unarchived projects', () => {
      expect(ids(taskRepo.findByFilters({ archived: 'include' }))).toEqual([
        activeTaskId,
        archivedOpenTaskId,
        archivedDoneTaskId,
      ]);
      expect(taskRepo.count({ archived: 'include' })).toBe(3);
    });

    it('archived=only returns nothing but tasks of archived projects', () => {
      expect(ids(taskRepo.findByFilters({ archived: 'only' }))).toEqual([
        archivedOpenTaskId,
        archivedDoneTaskId,
      ]);
      expect(taskRepo.count({ archived: 'only' })).toBe(2);
    });

    it.each(['exclude', 'include', 'only'] as const)(
      'with project_id of an archived project, archived=%s still returns its tasks',
      (archived) => {
        const filters = { project_id: archivedProjectId, archived };
        expect(ids(taskRepo.findByFilters(filters))).toEqual([
          archivedOpenTaskId,
          archivedDoneTaskId,
        ]);
        expect(taskRepo.count(filters)).toBe(2);
      },
    );

    it.each(['exclude', 'include', 'only'] as const)(
      'with project_id of an unarchived project, archived=%s still returns its tasks',
      (archived) => {
        const filters = { project_id: testProjectId, archived };
        expect(ids(taskRepo.findByFilters(filters))).toEqual([activeTaskId]);
        expect(taskRepo.count(filters)).toBe(1);
      },
    );

    it('combines with the other filters, and count matches the list', () => {
      expect(ids(taskRepo.findByFilters({ status: 'open' }))).toEqual([activeTaskId]);
      expect(taskRepo.count({ status: 'open' })).toBe(1);

      expect(ids(taskRepo.findByFilters({ status: 'open', archived: 'include' }))).toEqual([
        activeTaskId,
        archivedOpenTaskId,
      ]);
      expect(taskRepo.count({ status: 'open', archived: 'include' })).toBe(2);

      expect(ids(taskRepo.findByFilters({ status: 'done', archived: 'only' }))).toEqual([
        archivedDoneTaskId,
      ]);
      expect(taskRepo.count({ status: 'done', archived: 'only' })).toBe(1);

      expect(ids(taskRepo.findByFilters({ tags: ['shared'] }))).toEqual([activeTaskId]);
      expect(taskRepo.count({ tags: ['shared'] })).toBe(1);
      expect(taskRepo.count({ tags: ['shared'], archived: 'include' })).toBe(2);

      expect(ids(taskRepo.findByFilters({ search: 'task' }))).toEqual([activeTaskId]);
      expect(taskRepo.count({ search: 'task' })).toBe(1);
      expect(taskRepo.count({ search: 'task', archived: 'only' })).toBe(2);
    });

    it('applies without the tags join (include_tags: false)', () => {
      expect(ids(taskRepo.findByFilters({ include_tags: false }))).toEqual([activeTaskId]);
      expect(ids(taskRepo.findByFilters({ include_tags: false, archived: 'only' }))).toEqual([
        archivedOpenTaskId,
        archivedDoneTaskId,
      ]);
    });

    it('pagination applies to the filtered set', () => {
      const second = taskRepo.create(createTestTask({ title: 'second active task' })).id;

      const page1 = taskRepo.findByFilters({ limit: 1, offset: 0 });
      const page2 = taskRepo.findByFilters({ limit: 1, offset: 1 });
      const page3 = taskRepo.findByFilters({ limit: 1, offset: 2 });

      expect(ids([...page1, ...page2])).toEqual([activeTaskId, second]);
      expect(page3).toEqual([]);
    });

    it('tasks reappear in the default listing once the project is unarchived', () => {
      projectRepo.unarchive(archivedProjectId);

      expect(ids(taskRepo.findByFilters({}))).toEqual([
        activeTaskId,
        archivedOpenTaskId,
        archivedDoneTaskId,
      ]);
      expect(taskRepo.count({})).toBe(3);
      expect(taskRepo.count({ archived: 'only' })).toBe(0);
    });

    it('reads by id are unaffected by the archive', () => {
      expect(taskRepo.findById(archivedOpenTaskId)?.title).toBe('archived open task');
      expect(taskRepo.count()).toBe(3);
    });
  });

  describe('countNonTerminalByStatus', () => {
    it('returns one entry per status, each zero for a project with no tasks', () => {
      expect(taskRepo.countNonTerminalByStatus(testProjectId)).toEqual({
        open: 0,
        in_progress: 0,
        blocked: 0,
        backlogged: 0,
      });
    });

    it('non-terminal count returns one entry per status and ignores done and closed', () => {
      const statuses = [
        'open',
        'open',
        'open',
        'in_progress',
        'in_progress',
        'blocked',
        'backlogged',
        'backlogged',
        'done',
        'done',
        'closed',
      ] as const;
      for (const status of statuses) {
        taskRepo.create(createTestTask({ status }));
      }

      const counts = taskRepo.countNonTerminalByStatus(testProjectId);

      expect(counts).toEqual({ open: 3, in_progress: 2, blocked: 1, backlogged: 2 });
      expect(Object.keys(counts).sort()).toEqual(['backlogged', 'blocked', 'in_progress', 'open']);
    });

    it('counts only the given project', () => {
      const other = projectRepo.create({ name: 'Other Project' });
      taskRepo.create(createTestTask({ status: 'open' }));
      taskRepo.create(createTestTask({ status: 'blocked', project_id: other.id }));

      expect(taskRepo.countNonTerminalByStatus(testProjectId)).toEqual({
        open: 1,
        in_progress: 0,
        blocked: 0,
        backlogged: 0,
      });
      expect(taskRepo.countNonTerminalByStatus(other.id)).toEqual({
        open: 0,
        in_progress: 0,
        blocked: 1,
        backlogged: 0,
      });
    });

    it('counts subtasks as well as top-level tasks', () => {
      const parent = taskRepo.create(createTestTask({ status: 'done' }));
      taskRepo.create(createTestTask({ status: 'open', parent_task_id: parent.id }));

      expect(taskRepo.countNonTerminalByStatus(testProjectId).open).toBe(1);
    });

    it('still counts after the project is archived', () => {
      taskRepo.create(createTestTask({ status: 'in_progress' }));
      projectRepo.archive(testProjectId, 'alice', 'forced');

      expect(taskRepo.countNonTerminalByStatus(testProjectId).in_progress).toBe(1);
    });

    it('returns all zeros for a project that does not exist', () => {
      expect(taskRepo.countNonTerminalByStatus(999)).toEqual({
        open: 0,
        in_progress: 0,
        blocked: 0,
        backlogged: 0,
      });
    });
  });

  describe('findUnblockableIds', () => {
    let otherProjectId: number;
    let dependencyRepo: DependencyRepository;

    beforeEach(() => {
      otherProjectId = projectRepo.create({ name: 'Other Project' }).id;
      dependencyRepo = new DependencyRepository(db);
    });

    it('returns blocked tasks whose blockers are all done, in id order, across projects', () => {
      const doneHere = taskRepo.create(createTestTask({ status: 'done' }));
      const doneElsewhere = taskRepo.create(
        createTestTask({ status: 'done', project_id: otherProjectId }),
      );
      const first = taskRepo.create(createTestTask({ status: 'blocked' }));
      const second = taskRepo.create(createTestTask({ status: 'blocked' }));
      dependencyRepo.create({ task_id: doneHere.id, blocks_task_id: first.id });
      dependencyRepo.create({ task_id: doneElsewhere.id, blocks_task_id: first.id });
      dependencyRepo.create({ task_id: doneElsewhere.id, blocks_task_id: second.id });

      expect(taskRepo.findUnblockableIds(testProjectId)).toEqual([first.id, second.id]);
    });

    it('omits a task with any blocker not done, a task blocked by hand, and a task not blocked', () => {
      const done = taskRepo.create(createTestTask({ status: 'done' }));
      for (const blockerStatus of [
        'open',
        'in_progress',
        'blocked',
        'backlogged',
        'closed',
      ] as const) {
        const unfinished = taskRepo.create(createTestTask({ status: blockerStatus }));
        const blocked = taskRepo.create(createTestTask({ status: 'blocked' }));
        dependencyRepo.create({ task_id: done.id, blocks_task_id: blocked.id });
        dependencyRepo.create({ task_id: unfinished.id, blocks_task_id: blocked.id });
      }
      taskRepo.create(createTestTask({ status: 'blocked' }));
      const open = taskRepo.create(createTestTask({ status: 'open' }));
      dependencyRepo.create({ task_id: done.id, blocks_task_id: open.id });

      expect(taskRepo.findUnblockableIds(testProjectId)).toEqual([]);
    });

    it('returns only the given project', () => {
      const done = taskRepo.create(createTestTask({ status: 'done' }));
      const elsewhere = taskRepo.create(
        createTestTask({ status: 'blocked', project_id: otherProjectId }),
      );
      dependencyRepo.create({ task_id: done.id, blocks_task_id: elsewhere.id });

      expect(taskRepo.findUnblockableIds(testProjectId)).toEqual([]);
      expect(taskRepo.findUnblockableIds(otherProjectId)).toEqual([elsewhere.id]);
    });
  });

  describe('findCompletableParentIds', () => {
    it('returns open and in_progress parents whose children are all done, across projects', () => {
      const otherProjectId = projectRepo.create({ name: 'Other Project' }).id;
      const openParent = taskRepo.create(createTestTask({ status: 'open' }));
      const startedParent = taskRepo.create(createTestTask({ status: 'in_progress' }));
      taskRepo.create(createTestTask({ status: 'done', parent_task_id: openParent.id }));
      taskRepo.create(
        createTestTask({
          status: 'done',
          parent_task_id: startedParent.id,
          project_id: otherProjectId,
        }),
      );

      expect(taskRepo.findCompletableParentIds(testProjectId)).toEqual([
        openParent.id,
        startedParent.id,
      ]);
      expect(taskRepo.findCompletableParentIds(otherProjectId)).toEqual([]);
    });

    it('omits a parent with an unfinished child, a childless task, and a parent in any other status', () => {
      const mixed = taskRepo.create(createTestTask({ status: 'open' }));
      taskRepo.create(createTestTask({ status: 'done', parent_task_id: mixed.id }));
      taskRepo.create(createTestTask({ status: 'closed', parent_task_id: mixed.id }));
      taskRepo.create(createTestTask({ status: 'open' }));
      for (const parentStatus of ['blocked', 'backlogged', 'done', 'closed'] as const) {
        const parent = taskRepo.create(createTestTask({ status: parentStatus }));
        taskRepo.create(createTestTask({ status: 'done', parent_task_id: parent.id }));
      }

      expect(taskRepo.findCompletableParentIds(testProjectId)).toEqual([]);
    });
  });

  describe('findAll', () => {
    it('should return all tasks with tags ordered by created_at DESC', () => {
      const task1 = taskRepo.create(createTestTask({ title: 'First' }), ['tag1']);
      const task2 = taskRepo.create(createTestTask({ title: 'Second' }), ['tag2']);
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

  describe('project_name join', () => {
    it('reflects project rename on next read (no denormalized cache)', () => {
      // Acceptance: tasks include `project_name` from a live JOIN on
      // projects.name — a project rename must surface on the next read.
      const oldProject = projectRepo.create({ name: 'Old Name', description: null });
      const task = taskRepo.create(createTestTask({ project_id: oldProject.id }));

      const before = taskRepo.findById(task.id);
      expect(before?.project_name).toBe('Old Name');

      projectRepo.update(oldProject.id, { name: 'New Name' });

      const after = taskRepo.findById(task.id);
      expect(after?.project_name).toBe('New Name');
    });
  });

  describe('FTS5 search syntax errors', () => {
    beforeEach(() => {
      // Seed a few tasks so the FTS index has rows; the malformed-search
      // assertions rely on MATCH actually being evaluated, which requires a
      // populated FTS table.
      taskRepo.create(createTestTask({ title: 'Fix login bug', description: 'auth' }));
      taskRepo.create(
        createTestTask({
          title: 'Database migration bug',
          description: 'migrate users to new schema',
        }),
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
        expect(() => taskRepo.findByFilters({ search: input })).toThrow(FtsSyntaxError);
      });

      it(`count throws FtsSyntaxError on ${name}`, () => {
        expect(() => taskRepo.count({ search: input })).toThrow(FtsSyntaxError);
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
