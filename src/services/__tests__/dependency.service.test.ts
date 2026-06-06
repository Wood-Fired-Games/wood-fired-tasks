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
    dependencyService = new DependencyService(dependencyRepo, taskRepo);

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
        })
      ).toThrow(NotFoundError);
    });

    it('should reject dependency when blocks_task_id does not exist', () => {
      expect(() =>
        dependencyService.addDependency({
          task_id: taskId1,
          blocks_task_id: 9999,
        })
      ).toThrow(NotFoundError);
    });

    it('should reject self-dependency via validation', () => {
      expect(() =>
        dependencyService.addDependency({
          task_id: taskId1,
          blocks_task_id: taskId1,
        })
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
        })
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
        })
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
      expect(() =>
        dependencyService.removeDependency(taskId1, taskId2)
      ).toThrow(NotFoundError);
    });
  });
});
