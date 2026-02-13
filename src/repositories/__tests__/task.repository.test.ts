import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../project.repository.js';
import { TaskRepository } from '../task.repository.js';
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
});
