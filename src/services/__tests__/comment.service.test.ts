import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { CommentRepository } from '../../repositories/comment.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { CommentService } from '../comment.service.js';
import { ValidationError, NotFoundError } from '../errors.js';
import type Database from 'better-sqlite3';

describe('CommentService', () => {
  let db: Database.Database;
  let commentService: CommentService;
  let taskRepo: TaskRepository;
  let projectRepo: ProjectRepository;
  let projectId: number;
  let taskId: number;

  beforeEach(async () => {
    // Create in-memory database
    db = initDatabase(':memory:');
    await runMigrations(db);

    // Initialize repositories and service
    const commentRepo = new CommentRepository(db);
    taskRepo = new TaskRepository(db);
    projectRepo = new ProjectRepository(db);
    commentService = new CommentService(commentRepo, taskRepo);

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

  it('should successfully add comment to existing task', () => {
    const comment = commentService.addComment({
      task_id: taskId,
      author: 'John Doe',
      content: 'This is a great task!',
    });

    expect(comment.id).toBeGreaterThan(0);
    expect(comment.task_id).toBe(taskId);
    expect(comment.author).toBe('John Doe');
    expect(comment.content).toBe('This is a great task!');
  });

  it('should reject comment on nonexistent task', () => {
    expect(() => {
      commentService.addComment({
        task_id: 99999,
        author: 'John Doe',
        content: 'Comment on missing task',
      });
    }).toThrow(NotFoundError);
  });

  it('should reject comment with empty author', () => {
    expect(() => {
      commentService.addComment({
        task_id: taskId,
        author: '',
        content: 'Valid content',
      });
    }).toThrow(ValidationError);
  });

  it('should reject comment with empty content', () => {
    expect(() => {
      commentService.addComment({
        task_id: taskId,
        author: 'John Doe',
        content: '',
      });
    }).toThrow(ValidationError);
  });

  it('should reject comment with author too long', () => {
    expect(() => {
      commentService.addComment({
        task_id: taskId,
        author: 'a'.repeat(101),
        content: 'Valid content',
      });
    }).toThrow(ValidationError);
  });

  it('should reject comment with content too long', () => {
    expect(() => {
      commentService.addComment({
        task_id: taskId,
        author: 'John Doe',
        content: 'a'.repeat(5001),
      });
    }).toThrow(ValidationError);
  });

  it('should return comments in chronological order', () => {
    commentService.addComment({
      task_id: taskId,
      author: 'User 1',
      content: 'First',
    });

    commentService.addComment({
      task_id: taskId,
      author: 'User 2',
      content: 'Second',
    });

    commentService.addComment({
      task_id: taskId,
      author: 'User 3',
      content: 'Third',
    });

    const comments = commentService.getComments(taskId);
    expect(comments).toHaveLength(3);
    expect(comments[0].content).toBe('First');
    expect(comments[1].content).toBe('Second');
    expect(comments[2].content).toBe('Third');
  });

  it('should throw NotFoundError when getting comments for nonexistent task', () => {
    expect(() => {
      commentService.getComments(99999);
    }).toThrow(NotFoundError);
  });

  it('should delete comment successfully', () => {
    const comment = commentService.addComment({
      task_id: taskId,
      author: 'John Doe',
      content: 'To be deleted',
    });

    expect(() => {
      commentService.deleteComment(comment.id);
    }).not.toThrow();

    const comments = commentService.getComments(taskId);
    expect(comments).toHaveLength(0);
  });

  it('should throw NotFoundError when deleting nonexistent comment', () => {
    expect(() => {
      commentService.deleteComment(99999);
    }).toThrow(NotFoundError);
  });
});
