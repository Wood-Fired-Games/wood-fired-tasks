import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { CommentRepository } from '../../repositories/comment.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { CommentService } from '../comment.service.js';
import { ValidationError, NotFoundError } from '../errors.js';
import type Database from '../../db/driver.js';

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

  // Regression for task 191 (IDOR audit, security.md SEV-MEDIUM #1).
  // deleteComment must reject a comment id that belongs to a different task
  // when called with a task_id scope — otherwise a caller could delete any
  // comment via DELETE /tasks/:wrong-task/comments/:commentId.
  it('should throw NotFoundError when deleting comment via wrong task id', () => {
    const comment = commentService.addComment({
      task_id: taskId,
      author: 'John Doe',
      content: 'Should not be deletable via another task',
    });

    // Create a second task that does NOT own the comment.
    const otherTask = taskRepo.create({
      title: 'Unrelated Task',
      status: 'open',
      priority: 'medium',
      project_id: projectId,
      created_by: 'test-user',
    });

    expect(() => {
      commentService.deleteComment(comment.id, otherTask.id);
    }).toThrow(NotFoundError);

    // Also reject when the supplied task id does not exist at all.
    expect(() => {
      commentService.deleteComment(comment.id, 99999);
    }).toThrow(NotFoundError);

    // The comment must still be present — wrong-task delete attempts must not
    // have removed it.
    const remaining = commentService.getComments(taskId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(comment.id);

    // Sanity: correct task id still deletes successfully.
    expect(() => {
      commentService.deleteComment(comment.id, taskId);
    }).not.toThrow();
    expect(commentService.getComments(taskId)).toHaveLength(0);
  });

  // --- Archived project state (docs/design/project-archived-state.md §2.3) ---
  // Comments are deliberately NOT behind the project_archived write guard: a
  // note such as "regression tracked in #N" on a finished task changes no state.

  describe('archived project', () => {
    beforeEach(() => {
      projectRepo.archive(projectId, 'alice', 'shipped');
    });

    it('still allows adding a comment to a task in an archived project', () => {
      const comment = commentService.addComment({
        task_id: taskId,
        author: 'bob',
        content: 'regression tracked in #42',
      });

      expect(comment).toMatchObject({
        task_id: taskId,
        author: 'bob',
        content: 'regression tracked in #42',
      });
      expect(commentService.getComments(taskId).map((c) => c.id)).toEqual([comment.id]);
    });

    it('adding a comment leaves the archived project and the task untouched', () => {
      const taskBefore = taskRepo.findById(taskId);
      const projectBefore = projectRepo.findById(projectId);

      commentService.addComment({ task_id: taskId, author: 'bob', content: 'note' });

      expect(taskRepo.findById(taskId)).toEqual(taskBefore);
      expect(projectRepo.findById(projectId)).toEqual(projectBefore);
      expect(projectBefore?.archived).toBe(true);
    });

    it('still allows deleting a comment on a task in an archived project', () => {
      const comment = commentService.addComment({ task_id: taskId, author: 'bob', content: 'x' });

      commentService.deleteComment(comment.id, taskId);

      expect(commentService.getComments(taskId)).toEqual([]);
    });
  });
});
