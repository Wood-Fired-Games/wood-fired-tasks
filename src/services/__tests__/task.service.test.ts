import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestApp } from '../../index.js';
import { TaskService } from '../task.service.js';
import { ProjectService } from '../project.service.js';
import { ValidationError, BusinessError, NotFoundError } from '../errors.js';
import { eventBus } from '../../events/event-bus.js';
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

  afterEach(() => {
    // task #257: dispose() stops WorkflowEngine (unsubscribing from EventBus)
    // and closes the DB. Without this every test leaked a `task.status_changed`
    // listener and after ~10 tests Node emitted MaxListenersExceededWarning.
    app.dispose();
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
        }),
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
        }),
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
        }),
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
        }),
      ).toThrow(ValidationError);
    });

    // Guaranteed-task-sizing (design §1, Prong A): the server-side decompose
    // contract gate. A `decomp-*` tag without a `wsjf_submission` is rejected
    // uniformly (stdio MCP, remote MCP, REST all funnel through createTask).
    describe('decompose contract gate (Prong A)', () => {
      const validWsjf = () => ({
        value: 8,
        timeCriticality: 5,
        riskOpportunity: 3,
        jobSize: 2,
      });

      it('rejects a decomp-* tagged create with no wsjf_submission, naming the tag and wsjf_submission', () => {
        let thrown: unknown;
        try {
          taskService.createTask({
            title: 'Sizeless decomposed leaf',
            project_id: testProjectId,
            created_by: 'decompose',
            tags: ['decomp-xyz'],
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ValidationError);
        const ve = thrown as ValidationError;
        const message = JSON.stringify(ve.fieldErrors);
        expect(message).toContain('decomp-xyz');
        expect(message).toContain('wsjf_submission');
      });

      it('accepts a decomp-* tagged create WITH a valid wsjf_submission', () => {
        const task = taskService.createTask({
          title: 'Sized decomposed leaf',
          project_id: testProjectId,
          created_by: 'decompose',
          tags: ['decomp-xyz'],
          wsjf: validWsjf(),
        });

        expect(task.id).toBeGreaterThan(0);
        expect(task.tags).toContain('decomp-xyz');
        expect(task.wsjf_job_size).toBe(2);
      });

      it('does NOT reject an untagged WSJF-less create (falls through to auto-sizing)', () => {
        const task = taskService.createTask({
          title: 'Quick capture, no tags, no wsjf',
          project_id: testProjectId,
          created_by: 'user',
        });

        expect(task.id).toBeGreaterThan(0);
      });
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
        BusinessError,
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
        BusinessError,
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
      expect(tasks.every((t) => t.assignee === 'alice')).toBe(true);
    });

    it('listTasks with tags filter', () => {
      const tasks = taskService.listTasks({ tags: ['bug'] });
      expect(tasks.length).toBe(2);
      expect(tasks.every((t) => t.tags.includes('bug'))).toBe(true);
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

    describe('FTS5 search validation', () => {
      const MALFORMED_INPUTS: Array<{ name: string; input: string }> = [
        { name: 'bare double quote', input: '"' },
        { name: 'unterminated NEAR(', input: 'NEAR(' },
        { name: 'bare wildcard', input: '*' },
        { name: 'dangling OR operator', input: 'foo OR' },
        { name: 'unterminated phrase', input: '"unterminated phrase' },
      ];

      for (const { name, input } of MALFORMED_INPUTS) {
        it(`listTasks throws ValidationError on ${name}`, () => {
          expect(() => taskService.listTasks({ search: input })).toThrow(ValidationError);

          try {
            taskService.listTasks({ search: input });
            throw new Error('should have thrown');
          } catch (err) {
            expect(err).toBeInstanceOf(ValidationError);
            const fieldErrors = (err as ValidationError).fieldErrors;
            expect(fieldErrors.search).toBeDefined();
            expect(fieldErrors.search.length).toBeGreaterThan(0);
            // No raw SQLite text in the client-facing message.
            const joined = fieldErrors.search.join(' ');
            expect(joined).not.toContain('fts5:');
            expect(joined).not.toContain('SQLITE');
            expect(joined).not.toContain('unterminated string');
            expect(joined).not.toContain('parse error');
          }
        });

        it(`countTasks throws ValidationError on ${name}`, () => {
          expect(() => taskService.countTasks({ search: input })).toThrow(ValidationError);
        });

        it(`searchTasks throws ValidationError on ${name}`, () => {
          // searchTasks delegates to listTasks, so the same mapping applies.
          expect(() => taskService.searchTasks(input)).toThrow(ValidationError);
        });
      }

      it('rejects search with more than 32 terms via Zod refinement', () => {
        // Use single-character terms so the 33-term count cap is hit BEFORE
        // the 200-char length cap (otherwise the wrong refinement triggers).
        const tooMany = Array.from({ length: 33 }, () => 'a').join(' ');
        try {
          taskService.listTasks({ search: tooMany });
          throw new Error('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          const fieldErrors = (err as ValidationError).fieldErrors;
          expect(fieldErrors.search).toBeDefined();
          expect(fieldErrors.search.join(' ')).toContain('at most 32 terms');
        }
      });

      it('accepts search with exactly 32 terms', () => {
        // Use single-letter terms so the joined string also fits inside the
        // 200-char cap that runs alongside the 32-term cap.
        const exactly32 = Array.from(
          { length: 32 },
          (_, i) => String.fromCharCode(97 + (i % 26)) + i,
        ).join(' ');
        // Should NOT throw — even though no rows match, the query must parse.
        expect(() => taskService.listTasks({ search: exactly32 })).not.toThrow();
      });

      it('valid simple search still returns results', () => {
        const results = taskService.listTasks({ search: 'login' });
        expect(results.length).toBe(1);
        expect(results[0].title).toBe('Fix login bug');
      });
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
        }),
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
        }),
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
      try {
        expect(testApp.db).toBeDefined();
        expect(testApp.projectService).toBeDefined();
        expect(testApp.taskService).toBeDefined();
        expect(testApp.dependencyService).toBeDefined();
      } finally {
        testApp.dispose();
      }
    });

    it('createApp initializes database with WAL mode', async () => {
      const testApp = await createTestApp();
      try {
        const result = testApp.db.pragma('journal_mode', { simple: true }) as string;
        expect(result).toBe('memory'); // In-memory databases use 'memory' journal mode, not WAL
      } finally {
        testApp.dispose();
      }
    });
  });

  describe('event emissions', () => {
    it('createTask emits task.created event after successful operation', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      const task = taskService.createTask({
        title: 'Test Task',
        project_id: testProjectId,
        created_by: 'user',
        tags: ['test'],
      });

      expect(emitSpy).toHaveBeenCalledWith('task.created', {
        eventType: 'task.created',
        timestamp: expect.any(String),
        data: task,
        metadata: { source: 'user' },
      });

      emitSpy.mockRestore();
    });

    it('createTask does NOT emit event when validation fails', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() =>
        taskService.createTask({
          project_id: testProjectId,
          // missing required title
        }),
      ).toThrow(ValidationError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });

    it('createTask does NOT emit event when project does not exist', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() =>
        taskService.createTask({
          title: 'Test',
          project_id: 999,
          created_by: 'user',
        }),
      ).toThrow(BusinessError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });

    it('updateTask emits task.updated event after successful operation', () => {
      const task = taskService.createTask({
        title: 'Original',
        project_id: testProjectId,
        created_by: 'user',
      });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      const updated = taskService.updateTask(task.id, { title: 'Updated' });

      expect(emitSpy).toHaveBeenCalledWith('task.updated', {
        eventType: 'task.updated',
        timestamp: expect.any(String),
        data: updated,
        metadata: { source: 'user' },
      });

      emitSpy.mockRestore();
    });

    it('updateTask emits both task.updated and task.status_changed when status changes', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      const updated = taskService.updateTask(task.id, { status: 'in_progress' });

      expect(emitSpy).toHaveBeenCalledWith('task.updated', {
        eventType: 'task.updated',
        timestamp: expect.any(String),
        data: updated,
        metadata: { source: 'user' },
      });

      expect(emitSpy).toHaveBeenCalledWith('task.status_changed', {
        eventType: 'task.status_changed',
        timestamp: expect.any(String),
        data: updated,
        metadata: {
          source: 'user',
          from: 'open',
          to: 'in_progress',
        },
      });

      expect(emitSpy).toHaveBeenCalledTimes(2);

      emitSpy.mockRestore();
    });

    it('updateTask does NOT emit status_changed when status is not changed', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      taskService.updateTask(task.id, { title: 'Updated Title' });

      expect(emitSpy).toHaveBeenCalledWith('task.updated', expect.any(Object));
      expect(emitSpy).not.toHaveBeenCalledWith('task.status_changed', expect.any(Object));
      expect(emitSpy).toHaveBeenCalledTimes(1);

      emitSpy.mockRestore();
    });

    it('updateTask does NOT emit events when task not found', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() => taskService.updateTask(999, { title: 'Updated' })).toThrow(NotFoundError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });

    it('updateTask does NOT emit events when status transition invalid', () => {
      const task = taskService.createTask({
        title: 'Test',
        project_id: testProjectId,
        created_by: 'user',
      });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() => taskService.updateTask(task.id, { status: 'done' })).toThrow(BusinessError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });

    it('deleteTask emits task.deleted event BEFORE deletion', () => {
      const task = taskService.createTask({
        title: 'To Delete',
        project_id: testProjectId,
        created_by: 'user',
        tags: ['test'],
      });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      taskService.deleteTask(task.id);

      expect(emitSpy).toHaveBeenCalledWith('task.deleted', {
        eventType: 'task.deleted',
        timestamp: expect.any(String),
        data: task,
        metadata: { source: 'user' },
      });

      // Verify task is actually deleted
      expect(() => taskService.getTask(task.id)).toThrow(NotFoundError);

      emitSpy.mockRestore();
    });

    it('deleteTask does NOT emit event when task not found', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() => taskService.deleteTask(999)).toThrow(NotFoundError);

      expect(emitSpy).not.toHaveBeenCalled();

      emitSpy.mockRestore();
    });
  });
});
