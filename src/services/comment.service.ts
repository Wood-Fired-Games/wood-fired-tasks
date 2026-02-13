import type { ICommentRepository } from '../repositories/interfaces.js';
import type { ITaskRepository } from '../repositories/interfaces.js';
import type { Comment } from '../types/task.js';
import { CreateCommentSchema } from '../schemas/comment.schema.js';
import { ValidationError, NotFoundError } from './errors.js';

export class CommentService {
  constructor(
    private commentRepo: ICommentRepository,
    private taskRepo: ITaskRepository
  ) {}

  /**
   * Add a comment to a task
   * @throws ValidationError if input is invalid
   * @throws NotFoundError if task does not exist
   */
  addComment(input: unknown): Comment {
    // Validate input
    const result = CreateCommentSchema.safeParse(input);
    if (!result.success) {
      const fieldErrors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      throw new ValidationError('Comment validation failed', fieldErrors);
    }

    const dto = result.data;

    // Verify task exists
    const task = this.taskRepo.findById(dto.task_id);
    if (!task) {
      throw new NotFoundError('Task', dto.task_id);
    }

    // Create comment
    return this.commentRepo.create(dto);
  }

  /**
   * Get all comments for a task in chronological order
   * @throws NotFoundError if task does not exist
   */
  getComments(taskId: number): Comment[] {
    // Verify task exists
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new NotFoundError('Task', taskId);
    }

    // Return comments (already ordered chronologically by repository)
    return this.commentRepo.findByTaskId(taskId);
  }

  /**
   * Delete a comment
   * @throws NotFoundError if comment does not exist
   */
  deleteComment(id: number): void {
    // Verify comment exists
    const comment = this.commentRepo.findById(id);
    if (!comment) {
      throw new NotFoundError('Comment', id);
    }

    // Delete comment
    this.commentRepo.delete(id);
  }
}
