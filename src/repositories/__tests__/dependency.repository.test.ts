import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../project.repository.js';
import { TaskRepository } from '../task.repository.js';
import { DependencyRepository } from '../dependency.repository.js';
import type { CreateDependencyDTO } from '../../types/task.js';

describe('DependencyRepository', () => {
  let db: Database.Database;
  let projectRepo: ProjectRepository;
  let taskRepo: TaskRepository;
  let dependencyRepo: DependencyRepository;
  let testProjectId: number;
  let taskId1: number;
  let taskId2: number;
  let taskId3: number;

  beforeEach(async () => {
    // Create in-memory database
    db = initDatabase(':memory:');
    // Run migrations
    await runMigrations(db);
    // Create repositories
    projectRepo = new ProjectRepository(db);
    taskRepo = new TaskRepository(db);
    dependencyRepo = new DependencyRepository(db);

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

  describe('create', () => {
    it('should create dependency between two tasks', () => {
      const dto: CreateDependencyDTO = {
        task_id: taskId1,
        blocks_task_id: taskId2,
      };

      const dependency = dependencyRepo.create(dto);

      expect(dependency.id).toBeDefined();
      expect(dependency.task_id).toBe(taskId1);
      expect(dependency.blocks_task_id).toBe(taskId2);
      expect(dependency.created_at).toBeDefined();
    });

    it('should reject duplicate dependency due to UNIQUE constraint', () => {
      const dto: CreateDependencyDTO = {
        task_id: taskId1,
        blocks_task_id: taskId2,
      };

      // Create first dependency
      dependencyRepo.create(dto);

      // Attempt to create duplicate should throw
      expect(() => dependencyRepo.create(dto)).toThrow();
    });

    it('should reject self-dependency due to CHECK constraint', () => {
      const dto: CreateDependencyDTO = {
        task_id: taskId1,
        blocks_task_id: taskId1,
      };

      // Self-dependency should throw due to CHECK(task_id != blocks_task_id)
      expect(() => dependencyRepo.create(dto)).toThrow();
    });
  });

  describe('findByTaskId', () => {
    it('should return dependencies for a task (tasks this task blocks)', () => {
      // Task 1 blocks Task 2 and Task 3
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId3,
      });

      const dependencies = dependencyRepo.findByTaskId(taskId1);

      expect(dependencies).toHaveLength(2);
      expect(dependencies.map((d) => d.blocks_task_id)).toContain(taskId2);
      expect(dependencies.map((d) => d.blocks_task_id)).toContain(taskId3);
    });

    it('should return empty array for task with no dependencies', () => {
      const dependencies = dependencyRepo.findByTaskId(taskId1);
      expect(dependencies).toEqual([]);
    });
  });

  describe('findBlockingTask', () => {
    it('should return tasks that block this task', () => {
      // Task 1 blocks Task 3
      // Task 2 blocks Task 3
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId3,
      });
      dependencyRepo.create({
        task_id: taskId2,
        blocks_task_id: taskId3,
      });

      const blockers = dependencyRepo.findBlockingTask(taskId3);

      expect(blockers).toHaveLength(2);
      expect(blockers.map((d) => d.task_id)).toContain(taskId1);
      expect(blockers.map((d) => d.task_id)).toContain(taskId2);
    });

    it('should return empty array for task with no blockers', () => {
      const blockers = dependencyRepo.findBlockingTask(taskId1);
      expect(blockers).toEqual([]);
    });
  });

  describe('delete', () => {
    it('should delete specific dependency and return true', () => {
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });

      const deleted = dependencyRepo.delete(taskId1, taskId2);

      expect(deleted).toBe(true);

      // Verify it's gone
      const dependencies = dependencyRepo.findByTaskId(taskId1);
      expect(dependencies).toHaveLength(0);
    });

    it('should return false when deleting non-existent dependency', () => {
      const deleted = dependencyRepo.delete(taskId1, taskId2);
      expect(deleted).toBe(false);
    });

    it('should only delete specified dependency, not others', () => {
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId3,
      });

      dependencyRepo.delete(taskId1, taskId2);

      const remaining = dependencyRepo.findByTaskId(taskId1);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].blocks_task_id).toBe(taskId3);
    });
  });

  describe('CASCADE delete behavior', () => {
    it('should cascade delete dependencies when task is deleted', () => {
      // Task 1 blocks Task 2
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });

      // Delete Task 1
      taskRepo.delete(taskId1);

      // Dependency should be automatically removed via CASCADE
      const dependencies = dependencyRepo.findAll();
      expect(dependencies).toHaveLength(0);
    });

    it('should cascade delete dependencies for both task_id and blocks_task_id', () => {
      // Task 1 blocks Task 2
      // Task 2 blocks Task 3
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });
      dependencyRepo.create({
        task_id: taskId2,
        blocks_task_id: taskId3,
      });

      // Delete Task 2 (which appears in both columns)
      taskRepo.delete(taskId2);

      // Both dependencies should be removed
      const dependencies = dependencyRepo.findAll();
      expect(dependencies).toHaveLength(0);
    });
  });

  describe('findAll', () => {
    it('should return all dependencies', () => {
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });
      dependencyRepo.create({
        task_id: taskId2,
        blocks_task_id: taskId3,
      });

      const all = dependencyRepo.findAll();
      expect(all).toHaveLength(2);
    });

    it('should return empty array when no dependencies exist', () => {
      const all = dependencyRepo.findAll();
      expect(all).toEqual([]);
    });
  });

  describe('deleteByTaskId', () => {
    it('should delete all dependencies where task is the blocker', () => {
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId3,
      });

      dependencyRepo.deleteByTaskId(taskId1);

      const remaining = dependencyRepo.findAll();
      expect(remaining).toHaveLength(0);
    });

    it('should not affect dependencies where task is blocked (not blocker)', () => {
      dependencyRepo.create({
        task_id: taskId1,
        blocks_task_id: taskId2,
      });
      dependencyRepo.create({
        task_id: taskId2,
        blocks_task_id: taskId3,
      });

      // Delete dependencies where Task 1 is the blocker
      dependencyRepo.deleteByTaskId(taskId1);

      // Task 2 -> Task 3 should remain
      const remaining = dependencyRepo.findAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].task_id).toBe(taskId2);
      expect(remaining[0].blocks_task_id).toBe(taskId3);
    });
  });
});
