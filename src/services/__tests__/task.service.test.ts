import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { TaskService } from '../task.service.js';
import { ProjectService } from '../project.service.js';
import { ValidationError, BusinessError, NotFoundError } from '../errors.js';
import type { App } from '../../index.js';

describe('TaskService', () => {
  let app: App;
  let taskService: TaskService;
  let projectService: ProjectService;
  let testProjectId: number;

  beforeEach(async () => {
    // Create test app with in-memory database
    app = await createTestApp();
    taskService = app.taskService;
    projectService = app.projectService;

    // Create a test project for tasks
    const project = projectService.createProject({
      name: 'Test Project',
      description: 'For testing',
    });
    testProjectId = project.id;
  });

  describe('createTask', () => {
    it('creates task with valid input and returns all fields with tags', () => {
      const input = {
        title: 'Test Task',
        description: 'A test task',
        priority: 'high' as const,
        project_id: testProjectId,
        assignee: 'test-user',
        created_by: 'creator',
        due_date: '2024-12-31T23:59:59Z',
        tags: ['bug', 'urgent'],
      };

      const task = taskService.createTask(input);

      expect(task.id).toBeGreaterThan(0);
      expect(task.title).toBe('Test Task');
      expect(task.description).toBe('A test task');
      expect(task.status).toBe('open'); // Always starts as open
      expect(task.priority).toBe('high');
      expect(task.project_id).toBe(testProjectId);
      expect(task.assignee).toBe('test-user');
      expect(task.created_by).toBe('creator');
      expect(task.due_date).toBe('2024-12-31T23:59:59Z');
      expect(task.tags).toEqual(['bug', 'urgent']);
      expect(task.created_at).toBeDefined();
      expect(task.updated_at).toBeDefined();
    });

    it('always sets status to open', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      expect(task.status).toBe('open');
    });

    it('throws ValidationError when title is missing', () => {
      expect(() =>
        taskService.createTask({
          project_id: testProjectId,
          created_by: 'user',
        })
      ).toThrow(ValidationError);

      try {
        taskService.createTask({
          project_id: testProjectId,
          created_by: 'user',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const validationError = error as ValidationError;
        expect(validationError.fieldErrors.title).toBeDefined();
      }
    });

    it('throws ValidationError when created_by is missing', () => {
      expect(() =>
        taskService.createTask({
          title: 'Test',
          project_id: testProjectId,
        })
      ).toThrow(ValidationError);

      try {
        taskService.createTask({
          title: 'Test',
          project_id: testProjectId,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const validationError = error as ValidationError;
        expect(validationError.fieldErrors.created_by).toBeDefined();
      }
    });

    it('throws BusinessError when project_id does not exist', () => {
      expect(() =>
        taskService.createTask({
          title: 'Test',
          project_id: 999,
          created_by: 'user',
        })
      ).toThrow(BusinessError);

      try {
        taskService.createTask({
          title: 'Test',
          project_id: 999,
          created_by: 'user',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessError);
        expect((error as BusinessError).message).toContain('Project with id 999 does not exist');
      }
    });

    it('creates task with tags', () => {
      const task = taskService.createTask({
        title: 'Tagged Task',
        project_id: testProjectId,
        created_by: 'user',
        tags: ['feature', 'backend'],
      });

      expect(task.tags).toHaveLength(2);
      expect(task.tags).toContain('feature');
      expect(task.tags).toContain('backend');
    });

    it('throws ValidationError with invalid due_date format', () => {
      expect(() =>
        taskService.createTask({
          title: 'Test',
          project_id: testProjectId,
          created_by: 'user',
          due_date: '2024-12-31', // Not ISO8601 datetime
        })
      ).toThrow(ValidationError);
    });
  });

  describe('getTask', () => {
    it('returns task by ID with tags', () => {
      const created = taskService.createTask({
        title: 'Test Task',
        project_id: testProjectId,
        created_by: 'user',
        tags: ['test'],
      });

      const task = taskService.getTask(created.id);

      expect(task.id).toBe(created.id);
      expect(task.title).toBe('Test Task');
      expect(task.tags).toEqual(['test']);
    });

    it('throws NotFoundError when task does not exist', () => {
      expect(() => taskService.getTask(999)).toThrow(NotFoundError);

      try {
        taskService.getTask(999);
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
        const notFoundError = error as NotFoundError;
        expect(notFoundError.entity).toBe('Task');
        expect(notFoundError.id).toBe(999);
      }
    });
  });

  describe('updateTask', () => {
    it('changes title', () => {
      const created = taskService.createTask({
        title: 'Original',
        project_id: testProjectId,
        created_by: 'user',
      });

      const updated = taskService.updateTask(created.id, { title: 'Updated' });

      expect(updated.title).toBe('Updated');
    });

    it('changes priority', () => {
      const created = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      const updated = taskService.updateTask(created.id, { priority: 'urgent' });

      expect(updated.priority).toBe('urgent');
    });

    it('changes assignee', () => {
      const created = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      const updated = taskService.updateTask(created.id, { assignee: 'new-user' });

      expect(updated.assignee).toBe('new-user');
    });

    it('changes due_date', () => {
      const created = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      const updated = taskService.updateTask(created.id, {
        due_date: '2025-01-15T10:00:00Z',
      });

      expect(updated.due_date).toBe('2025-01-15T10:00:00Z');
    });

    it('replaces tags', () => {
      const created = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
        tags: ['old'],
      });

      const updated = taskService.updateTask(created.id, { tags: ['new', 'tags'] });

      expect(updated.tags).toEqual(['new', 'tags']);
    });
  });

  describe('status lifecycle', () => {
    // Valid transitions
    it('open -> in_progress succeeds', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      const updated = taskService.updateTask(task.id, { status: 'in_progress' });

      expect(updated.status).toBe('in_progress');
    });

    it('open -> blocked succeeds', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      const updated = taskService.updateTask(task.id, { status: 'blocked' });

      expect(updated.status).toBe('blocked');
    });

    it('open -> closed succeeds', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      const updated = taskService.updateTask(task.id, { status: 'closed' });

      expect(updated.status).toBe('closed');
    });

    it('open -> done throws BusinessError', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      expect(() => taskService.updateTask(task.id, { status: 'done' })).toThrow(BusinessError);

      try {
        taskService.updateTask(task.id, { status: 'done' });
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessError);
        expect((error as BusinessError).message).toContain('Invalid status transition');
        expect((error as BusinessError).message).toContain("'open' to 'done'");
      }
    });

    it('in_progress -> done succeeds', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.updateTask(task.id, { status: 'in_progress' });
      const updated = taskService.updateTask(task.id, { status: 'done' });

      expect(updated.status).toBe('done');
    });

    it('in_progress -> blocked succeeds', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.updateTask(task.id, { status: 'in_progress' });
      const updated = taskService.updateTask(task.id, { status: 'blocked' });

      expect(updated.status).toBe('blocked');
    });

    it('in_progress -> open succeeds (revert)', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.updateTask(task.id, { status: 'in_progress' });
      const updated = taskService.updateTask(task.id, { status: 'open' });

      expect(updated.status).toBe('open');
    });

    it('done -> closed succeeds', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.updateTask(task.id, { status: 'in_progress' });
      taskService.updateTask(task.id, { status: 'done' });
      const updated = taskService.updateTask(task.id, { status: 'closed' });

      expect(updated.status).toBe('closed');
    });

    it('done -> open succeeds (reopen)', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.updateTask(task.id, { status: 'in_progress' });
      taskService.updateTask(task.id, { status: 'done' });
      const updated = taskService.updateTask(task.id, { status: 'open' });

      expect(updated.status).toBe('open');
    });

    it('done -> in_progress throws BusinessError', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.updateTask(task.id, { status: 'in_progress' });
      taskService.updateTask(task.id, { status: 'done' });

      expect(() => taskService.updateTask(task.id, { status: 'in_progress' })).toThrow(
        BusinessError
      );
    });

    it('closed -> open succeeds (reopen)', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.updateTask(task.id, { status: 'closed' });
      const updated = taskService.updateTask(task.id, { status: 'open' });

      expect(updated.status).toBe('open');
    });

    it('closed -> in_progress throws BusinessError', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.updateTask(task.id, { status: 'closed' });

      expect(() => taskService.updateTask(task.id, { status: 'in_progress' })).toThrow(
        BusinessError
      );
    });

    it('blocked -> open succeeds', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.updateTask(task.id, { status: 'blocked' });
      const updated = taskService.updateTask(task.id, { status: 'open' });

      expect(updated.status).toBe('open');
    });

    it('blocked -> in_progress succeeds', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.updateTask(task.id, { status: 'blocked' });
      const updated = taskService.updateTask(task.id, { status: 'in_progress' });

      expect(updated.status).toBe('in_progress');
    });

    it('blocked -> done throws BusinessError', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.updateTask(task.id, { status: 'blocked' });

      expect(() => taskService.updateTask(task.id, { status: 'done' })).toThrow(BusinessError);
    });
  });

  describe('deleteTask', () => {
    it('removes task', () => {
      const created = taskService.createTask({
        title: 'To Delete',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.deleteTask(created.id);

      expect(() => taskService.getTask(created.id)).toThrow(NotFoundError);
    });

    it('throws NotFoundError when task does not exist', () => {
      expect(() => taskService.deleteTask(999)).toThrow(NotFoundError);
    });
  });

  describe('filter tests', () => {
    beforeEach(() => {
      // Create multiple tasks with different attributes
      taskService.createTask({
        title: 'Bug in login',
        description: 'Users cannot login',
        status: 'open',
        priority: 'high',
        project_id: testProjectId,
        assignee: 'alice',
        created_by: 'bob',
        due_date: '2024-12-15T00:00:00Z',
        tags: ['bug', 'auth'],
      });

      const task2 = taskService.createTask({
        title: 'Feature request',
        description: 'Add dark mode',
        priority: 'medium',
        project_id: testProjectId,
        assignee: 'bob',
        created_by: 'alice',
        due_date: '2025-01-20T00:00:00Z',
        tags: ['feature', 'ui'],
      });
      taskService.updateTask(task2.id, { status: 'in_progress' });

      const task3 = taskService.createTask({
        title: 'Database migration bug',
        description: 'Migration fails on production',
        priority: 'urgent',
        project_id: testProjectId,
        assignee: 'alice',
        created_by: 'bob',
        due_date: '2024-11-30T00:00:00Z',
        tags: ['bug', 'database'],
      });
      taskService.updateTask(task3.id, { status: 'in_progress' });
      taskService.updateTask(task3.id, { status: 'done' });
    });

    it('listTasks with no filters returns all tasks', () => {
      const tasks = taskService.listTasks();
      expect(tasks.length).toBe(3);
    });

    it('listTasks with status filter returns matching tasks', () => {
      const tasks = taskService.listTasks({ status: 'open' });
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Bug in login');
    });

    it('listTasks with project_id filter', () => {
      const tasks = taskService.listTasks({ project_id: testProjectId });
      expect(tasks.length).toBe(3);
    });

    it('listTasks with assignee filter', () => {
      const tasks = taskService.listTasks({ assignee: 'alice' });
      expect(tasks.length).toBe(2);
      expect(tasks.every(t => t.assignee === 'alice')).toBe(true);
    });

    it('listTasks with tags filter', () => {
      const tasks = taskService.listTasks({ tags: ['bug'] });
      expect(tasks.length).toBe(2);
      expect(tasks.every(t => t.tags.includes('bug'))).toBe(true);
    });

    it('listTasks with date range filter', () => {
      const tasks = taskService.listTasks({
        due_after: '2024-12-01T00:00:00Z',
        due_before: '2025-01-01T00:00:00Z',
      });
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Bug in login');
    });

    it('listTasks with combined filters', () => {
      const tasks = taskService.listTasks({
        status: 'in_progress',
        project_id: testProjectId,
      });
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Feature request');
    });
  });

  describe('search tests', () => {
    beforeEach(() => {
      taskService.createTask({
        title: 'Fix login bug',
        description: 'The authentication system is broken',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.createTask({
        title: 'Database migration',
        description: 'Migrate users to new schema',
        project_id: testProjectId,
        created_by: 'user',
      });

      taskService.createTask({
        title: 'UI redesign',
        description: 'Make the interface prettier',
        project_id: testProjectId,
        created_by: 'user',
      });
    });

    it('listTasks with search finds by title keyword', () => {
      const tasks = taskService.listTasks({ search: 'login' });
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Fix login bug');
    });

    it('listTasks with search finds by description keyword', () => {
      const tasks = taskService.listTasks({ search: 'schema' });
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Database migration');
    });

    it('searchTasks convenience method works', () => {
      const tasks = taskService.searchTasks('migration');
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe('Database migration');
    });

    it('countTasks returns correct count with and without filters', () => {
      const totalCount = taskService.countTasks();
      expect(totalCount).toBe(3);

      const filteredCount = taskService.countTasks({ status: 'open' });
      expect(filteredCount).toBe(3); // All created tasks start as open
    });
  });

  describe('parent_task_id and subtasks', () => {
    it('should create task with parent_task_id pointing to existing task', () => {
      const parentTask = taskService.createTask({
        title: 'Parent Task',
        project_id: testProjectId,
        created_by: 'user',
      });

      const childTask = taskService.createTask({
        title: 'Child Task',
        project_id: testProjectId,
        parent_task_id: parentTask.id,
        created_by: 'user',
      });

      expect(childTask.parent_task_id).toBe(parentTask.id);
    });

    it('should reject parent_task_id pointing to nonexistent task', () => {
      expect(() =>
        taskService.createTask({
          title: 'Child Task',
          project_id: testProjectId,
          parent_task_id: 9999,
          created_by: 'user',
        })
      ).toThrow(BusinessError);

      try {
        taskService.createTask({
          title: 'Child Task',
          project_id: testProjectId,
          parent_task_id: 9999,
          created_by: 'user',
        });
      } catch (err: any) {
        expect(err.message).toContain('Parent task with id 9999 does not exist');
      }
    });

    it('should reject parent_task_id pointing to task in different project', () => {
      // Create another project
      const project2 = projectService.createProject({
        name: 'Project 2',
      });

      // Create task in project 2
      const taskInProject2 = taskService.createTask({
        title: 'Task in Project 2',
        project_id: project2.id,
        created_by: 'user',
      });

      // Attempt to create task in project 1 with parent in project 2
      expect(() =>
        taskService.createTask({
          title: 'Child Task',
          project_id: testProjectId,
          parent_task_id: taskInProject2.id,
          created_by: 'user',
        })
      ).toThrow(BusinessError);

      try {
        taskService.createTask({
          title: 'Child Task',
          project_id: testProjectId,
          parent_task_id: taskInProject2.id,
          created_by: 'user',
        });
      } catch (err: any) {
        expect(err.message).toContain('Parent task must be in the same project');
      }
    });

    it('should return children of a parent task via getSubtasks', () => {
      const parentTask = taskService.createTask({
        title: 'Parent Task',
        project_id: testProjectId,
        created_by: 'user',
      });

      const child1 = taskService.createTask({
        title: 'Child 1',
        project_id: testProjectId,
        parent_task_id: parentTask.id,
        created_by: 'user',
      });

      const child2 = taskService.createTask({
        title: 'Child 2',
        project_id: testProjectId,
        parent_task_id: parentTask.id,
        created_by: 'user',
      });

      const subtasks = taskService.getSubtasks(parentTask.id);

      expect(subtasks).toHaveLength(2);
      expect(subtasks.map((t) => t.id)).toContain(child1.id);
      expect(subtasks.map((t) => t.id)).toContain(child2.id);
    });

    it('should return empty array for task with no children', () => {
      const task = taskService.createTask({
        title: 'Task with no children',
        project_id: testProjectId,
        created_by: 'user',
      });

      const subtasks = taskService.getSubtasks(task.id);
      expect(subtasks).toEqual([]);
    });

    it('should throw NotFoundError for getSubtasks with nonexistent task', () => {
      expect(() => taskService.getSubtasks(9999)).toThrow(NotFoundError);
    });
  });

  describe('createApp tests', () => {
    it('createTestApp returns db, projectService, taskService, dependencyService', async () => {
      const testApp = await createTestApp();

      expect(testApp.db).toBeDefined();
      expect(testApp.projectService).toBeDefined();
      expect(testApp.taskService).toBeDefined();
      expect(testApp.dependencyService).toBeDefined();
    });

    it('createApp initializes database with WAL mode', async () => {
      const { db } = await createTestApp();

      const result = db.pragma('journal_mode', { simple: true }) as string;
      expect(result).toBe('memory'); // In-memory databases use 'memory' journal mode, not WAL
    });
  });
});
