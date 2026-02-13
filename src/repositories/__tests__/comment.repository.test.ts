import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { CommentRepository } from '../comment.repository.js';
import { TaskRepository } from '../task.repository.js';
import { ProjectRepository } from '../project.repository.js';
import type Database from 'better-sqlite3';

describe('CommentRepository', () => {
  let db: Database.Database;
  let commentRepo: CommentRepository;
  let taskRepo: TaskRepository;
  let projectRepo: ProjectRepository;
  let projectId: number;
  let taskId: number;

  beforeEach(async () => {
    // Create in-memory database
    db = initDatabase(':memory:');
    await runMigrations(db);

    // Initialize repositories
    commentRepo = new CommentRepository(db);
    taskRepo = new TaskRepository(db);
    projectRepo = new ProjectRepository(db);

    // Create test project and task
    const project = projectRepo.create({ name: 'Test Project' });
    projectId = project.id;

    const task = taskRepo.create({
      title: 'Test Task',
      status: 'open',
      priority: 'medium',
      project_id: projectId,
      created_by: 'test-user',
    });
    taskId = task.id;
  });

  it('should create a comment with all fields', () => {
    const comment = commentRepo.create({
      task_id: taskId,
      author: 'John Doe',
      content: 'This is a test comment',
    });

    expect(comment.id).toBeGreaterThan(0);
    expect(comment.task_id).toBe(taskId);
    expect(comment.author).toBe('John Doe');
    expect(comment.content).toBe('This is a test comment');
    expect(comment.created_at).toBeTruthy();
    expect(comment.updated_at).toBeNull();
  });

  it('should return comments in chronological order', () => {
    // Create 3 comments
    const comment1 = commentRepo.create({
      task_id: taskId,
      author: 'User 1',
      content: 'First comment',
    });

    const comment2 = commentRepo.create({
      task_id: taskId,
      author: 'User 2',
      content: 'Second comment',
    });

    const comment3 = commentRepo.create({
      task_id: taskId,
      author: 'User 3',
      content: 'Third comment',
    });

    // Retrieve comments
    const comments = commentRepo.findByTaskId(taskId);

    expect(comments).toHaveLength(3);
    expect(comments[0].id).toBe(comment1.id);
    expect(comments[1].id).toBe(comment2.id);
    expect(comments[2].id).toBe(comment3.id);
  });

  it('should count comments by task_id', () => {
    commentRepo.create({
      task_id: taskId,
      author: 'User 1',
      content: 'Comment 1',
    });

    commentRepo.create({
      task_id: taskId,
      author: 'User 2',
      content: 'Comment 2',
    });

    const count = commentRepo.countByTaskId(taskId);
    expect(count).toBe(2);
  });

  it('should delete a comment', () => {
    const comment = commentRepo.create({
      task_id: taskId,
      author: 'Test User',
      content: 'To be deleted',
    });

    const deleted = commentRepo.delete(comment.id);
    expect(deleted).toBe(true);

    const found = commentRepo.findById(comment.id);
    expect(found).toBeNull();
  });

  it('should return false when deleting non-existent comment', () => {
    const deleted = commentRepo.delete(99999);
    expect(deleted).toBe(false);
  });

  it('should CASCADE delete comments when task is deleted', () => {
    commentRepo.create({
      task_id: taskId,
      author: 'User 1',
      content: 'Comment 1',
    });

    commentRepo.create({
      task_id: taskId,
      author: 'User 2',
      content: 'Comment 2',
    });

    expect(commentRepo.countByTaskId(taskId)).toBe(2);

    // Delete the task
    taskRepo.delete(taskId);

    // Comments should be gone
    const comments = commentRepo.findByTaskId(taskId);
    expect(comments).toHaveLength(0);
  });

  it('should return empty array for task with no comments', () => {
    const comments = commentRepo.findByTaskId(taskId);
    expect(comments).toEqual([]);
  });
});
