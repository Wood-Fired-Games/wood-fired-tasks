import { describe, it, expect, beforeEach } from 'vitest';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { DependencyRepository } from '../../repositories/dependency.repository.js';
import { DependencyService } from '../dependency.service.js';
import { ValidationError, NotFoundError, BusinessError } from '../errors.js';

describe('DependencyService', () => {
  let db: Database.Database;
  let projectRepo: ProjectRepository;
  let taskRepo: TaskRepository;
  let dependencyRepo: DependencyRepository;
  let dependencyService: DependencyService;
  let testProjectId: number;
  let taskId1: number;
  let taskId2: number;
  let taskId3: number;

  beforeEach(async () => {
    // Create in-memory database
    db = initDatabase(':memory:');
    await runMigrations(db);

    // Create repositories
    projectRepo = new ProjectRepository(db);
    taskRepo = new TaskRepository(db);
    dependencyRepo = new DependencyRepository(db);

    // Create service
    dependencyService = new DependencyService(dependencyRepo, taskRepo, projectRepo);

    // Create test project
    const project = projectRepo.create({
      name: 'Test Project',
      description: 'Project for testing dependencies',
    });
    testProjectId = project.id;

    // Create test tasks
    const task1 = taskRepo.create({
      title: 'Task 1',
      status: 'open',
      priority: 'medium',
      project_id: testProjectId,
      created_by: 'test-user',
    });
    taskId1 = task1.id;

    const task2 = taskRepo.create({
      title: 'Task 2',
      status: 'open',
      priority: 'medium',
      project_id: testProjectId,
      created_by: 'test-user',
    });
    taskId2 = task2.id;

    const task3 = taskRepo.create({
      title: 'Task 3',
      status: 'open',
      priority: 'medium',
      project_id: testProjectId,
      created_by: 'test-user',
    });
    taskId3 = task3.id;
  });

  describe('addDependency', () => {
    it('should successfully create a dependency between two tasks', () => {
      const dependency = dependencyService.addDependency({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });

      expect(dependency.id).toBeDefined();
      expect(dependency.task_id).toBe(taskId1);
      expect(dependency.blocks_task_id).toBe(taskId2);
      expect(dependency.created_at).toBeDefined();
    });

    it('should reject dependency when task_id does not exist', () => {
      expect(() =>
        dependencyService.addDependency({
          task_id: 9999,
          blocks_task_id: taskId2,
        }),
      ).toThrow(NotFoundError);
    });

    it('should reject dependency when blocks_task_id does not exist', () => {
      expect(() =>
        dependencyService.addDependency({
          task_id: taskId1,
          blocks_task_id: 9999,
        }),
      ).toThrow(NotFoundError);
    });

    it('should reject self-dependency via validation', () => {
      expect(() =>
        dependencyService.addDependency({
          task_id: taskId1,
          blocks_task_id: taskId1,
        }),
      ).toThrow(ValidationError);
    });

    it('should reject circular dependency (A blocks B, B blocks A)', () => {
      // Create A -> B dependency
      dependencyService.addDependency({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });

      // Attempt B -> A (creates cycle)
      expect(() =>
        dependencyService.addDependency({
          task_id: taskId2,
          blocks_task_id: taskId1,
        }),
      ).toThrow(BusinessError);

      try {
        dependencyService.addDependency({
          task_id: taskId2,
          blocks_task_id: taskId1,
        });
      } catch (err: any) {
        expect(err.message).toContain('circular dependency');
      }
    });

    it('should reject transitive circular dependency (A blocks B, B blocks C, C blocks A)', () => {
      // Create A -> B
      dependencyService.addDependency({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });

      // Create B -> C
      dependencyService.addDependency({
        task_id: taskId2,
        blocks_task_id: taskId3,
      });

      // Attempt C -> A (creates cycle: A -> B -> C -> A)
      expect(() =>
        dependencyService.addDependency({
          task_id: taskId3,
          blocks_task_id: taskId1,
        }),
      ).toThrow(BusinessError);
    });

    it('should throw ValidationError with field errors for invalid input', () => {
      try {
        dependencyService.addDependency({
          task_id: 'invalid',
          blocks_task_id: taskId2,
        });
        expect.fail('Should have thrown ValidationError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ValidationError);
        expect(err.fieldErrors).toBeDefined();
      }
    });
  });

  describe('getBlockedBy', () => {
    it('should return tasks blocked by this task', () => {
      // Task 1 blocks Task 2 and Task 3
      dependencyService.addDependency({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });
      dependencyService.addDependency({
        task_id: taskId1,
        blocks_task_id: taskId3,
      });

      const blocked = dependencyService.getBlockedBy(taskId1);

      expect(blocked).toHaveLength(2);
      expect(blocked.map((d) => d.blocks_task_id)).toContain(taskId2);
      expect(blocked.map((d) => d.blocks_task_id)).toContain(taskId3);
    });

    it('should return empty array for task with no blocked tasks', () => {
      const blocked = dependencyService.getBlockedBy(taskId1);
      expect(blocked).toEqual([]);
    });
  });

  describe('getBlockers', () => {
    it('should return tasks that block this task', () => {
      // Task 1 blocks Task 3
      // Task 2 blocks Task 3
      dependencyService.addDependency({
        task_id: taskId1,
        blocks_task_id: taskId3,
      });
      dependencyService.addDependency({
        task_id: taskId2,
        blocks_task_id: taskId3,
      });

      const blockers = dependencyService.getBlockers(taskId3);

      expect(blockers).toHaveLength(2);
      expect(blockers.map((d) => d.task_id)).toContain(taskId1);
      expect(blockers.map((d) => d.task_id)).toContain(taskId2);
    });

    it('should return empty array for task with no blockers', () => {
      const blockers = dependencyService.getBlockers(taskId1);
      expect(blockers).toEqual([]);
    });
  });

  describe('removeDependency', () => {
    it('should successfully remove a dependency', () => {
      // Create dependency
      dependencyService.addDependency({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });

      // Remove it
      dependencyService.removeDependency(taskId1, taskId2);

      // Verify it's gone
      const blocked = dependencyService.getBlockedBy(taskId1);
      expect(blocked).toHaveLength(0);
    });

    it('should throw NotFoundError when removing non-existent dependency', () => {
      expect(() => dependencyService.removeDependency(taskId1, taskId2)).toThrow(NotFoundError);
    });
  });

  // --- Archived project state (docs/design/project-archived-state.md §2.3) ---

  describe('archived project write guard', () => {
    let archivedProjectId: number;
    let archivedTaskA: number;
    let archivedTaskB: number;

    const expectProjectArchived = (fn: () => unknown) => {
      let thrown: unknown;
      try {
        fn();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(BusinessError);
      expect((thrown as BusinessError).message).toMatch(/^project_archived/);
      return (thrown as BusinessError).message;
    };

    const newTask = (title: string, projectId: number) =>
      taskRepo.create({
        title,
        status: 'open',
        priority: 'medium',
        project_id: projectId,
        created_by: 'test-user',
      }).id;

    beforeEach(() => {
      archivedProjectId = projectRepo.create({ name: 'Archived Project' }).id;
      archivedTaskA = newTask('Archived A', archivedProjectId);
      archivedTaskB = newTask('Archived B', archivedProjectId);
      // Edges that exist before the archive: one inside the archived project,
      // one from it into the active project, one into it.
      dependencyService.addDependency({ task_id: archivedTaskA, blocks_task_id: archivedTaskB });
      dependencyService.addDependency({ task_id: archivedTaskA, blocks_task_id: taskId1 });
      dependencyService.addDependency({ task_id: taskId2, blocks_task_id: archivedTaskB });
      projectRepo.archive(archivedProjectId, 'alice', 'frozen');
    });

    it('rejects adding a dependency between two tasks of an archived project', () => {
      const message = expectProjectArchived(() =>
        dependencyService.addDependency({ task_id: archivedTaskB, blocks_task_id: archivedTaskA }),
      );
      expect(message).toContain(String(archivedProjectId));
    });

    it('rejects adding a dependency when only the blocking task is in an archived project', () => {
      expectProjectArchived(() =>
        dependencyService.addDependency({ task_id: archivedTaskB, blocks_task_id: taskId3 }),
      );
      expect(dependencyService.getBlockers(taskId3)).toEqual([]);
    });

    it('rejects adding a dependency when only the blocked task is in an archived project', () => {
      expectProjectArchived(() =>
        dependencyService.addDependency({ task_id: taskId3, blocks_task_id: archivedTaskA }),
      );
      expect(dependencyService.getBlockers(archivedTaskA)).toEqual([]);
    });

    it.each([
      ['inside the archived project', () => [archivedTaskA, archivedTaskB]],
      ['from the archived project into an active one', () => [archivedTaskA, taskId1]],
      ['from an active project into the archived one', () => [taskId2, archivedTaskB]],
    ])('rejects removing an edge %s, and the edge stays', (_what, edge) => {
      const [from, to] = edge() as [number, number];

      expectProjectArchived(() => dependencyService.removeDependency(from, to));

      expect(dependencyService.getBlockedBy(from).map((d) => d.blocks_task_id)).toContain(to);
    });

    it('existing edges stay readable after the archive', () => {
      expect(
        dependencyService
          .getBlockedBy(archivedTaskA)
          .map((d) => d.blocks_task_id)
          .sort(),
      ).toEqual([archivedTaskB, taskId1].sort());
      expect(
        dependencyService
          .getBlockers(archivedTaskB)
          .map((d) => d.task_id)
          .sort(),
      ).toEqual([archivedTaskA, taskId2].sort());
    });

    it('still allows adding and removing edges between tasks of unarchived projects', () => {
      dependencyService.addDependency({ task_id: taskId1, blocks_task_id: taskId3 });
      dependencyService.removeDependency(taskId1, taskId3);

      expect(dependencyService.getBlockedBy(taskId1)).toEqual([]);
    });

    it('not-found errors still come first', () => {
      expect(() =>
        dependencyService.addDependency({ task_id: 999999, blocks_task_id: archivedTaskA }),
      ).toThrow(NotFoundError);
      expect(() => dependencyService.removeDependency(taskId1, taskId2)).toThrow(NotFoundError);
    });

    it('edges can be changed again after unarchive', () => {
      projectRepo.unarchive(archivedProjectId);

      dependencyService.removeDependency(archivedTaskA, taskId1);
      dependencyService.addDependency({ task_id: archivedTaskB, blocks_task_id: taskId3 });

      expect(dependencyService.getBlockedBy(archivedTaskA).map((d) => d.blocks_task_id)).toEqual([
        archivedTaskB,
      ]);
    });
  });
});
