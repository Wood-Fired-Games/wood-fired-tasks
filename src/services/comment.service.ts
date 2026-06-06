import type { ICommentRepository } from '../repositories/interfaces.js';
import type { ITaskRepository } from '../repositories/interfaces.js';
import type { Comment, CreateCommentDTO, PaginatedResponse } from '../types/task.js';
import { DEFAULT_PAGE_LIMIT, DEFAULT_PAGE_OFFSET } from '../types/task.js';
import { CreateCommentSchema } from '../schemas/comment.schema.js';
import { ValidationError, NotFoundError } from './errors.js';

export class CommentService {
  constructor(
    private commentRepo: ICommentRepository,
    private taskRepo: ITaskRepository,
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
      const fieldErrors: Record<string, string[]> = {};
      result.error.issues.forEach((issue) => {
        const field = issue.path.join('.');
        if (!fieldErrors[field]) {
          fieldErrors[field] = [];
        }
        fieldErrors[field].push(issue.message);
      });
      throw new ValidationError(fieldErrors);
    }

    const parsed = result.data;

    // Verify task exists
    const task = this.taskRepo.findById(parsed.task_id);
    if (!task) {
      throw new NotFoundError('Task', parsed.task_id);
    }

    // Create comment. `author_user_id` is omitted when absent so the optional
    // FK column stays untouched (three-state: absent / null / value). Explicit
    // `null` is preserved by the conditional spread below.
    const dto: CreateCommentDTO = {
      task_id: parsed.task_id,
      author: parsed.author,
      content: parsed.content,
      ...(parsed.author_user_id !== undefined && { author_user_id: parsed.author_user_id }),
    };
    return this.commentRepo.create(dto);
  }

  /**
   * Get comments for a task in chronological order — current page only.
   * Internal callers use this; REST/MCP use {@link getCommentsPaginated}.
   * @throws NotFoundError if task does not exist
   */
  getComments(taskId: number, pagination?: { limit?: number; offset?: number }): Comment[] {
    // Verify task exists
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new NotFoundError('Task', taskId);
    }

    // Return comments (already ordered chronologically by repository)
    return this.commentRepo.findByTaskId(taskId, pagination);
  }

  /**
   * Paginated get-comments: `{ data, total, limit, offset }`.
   */
  getCommentsPaginated(
    taskId: number,
    pagination?: { limit?: number; offset?: number },
  ): PaginatedResponse<Comment> {
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new NotFoundError('Task', taskId);
    }
    const limit = pagination?.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = pagination?.offset ?? DEFAULT_PAGE_OFFSET;
    const data = this.commentRepo.findByTaskId(taskId, { limit, offset });
    const total = this.commentRepo.countByTaskId(taskId);
    return { data, total, limit, offset };
  }

  /**
   * Delete a comment
   *
   * @param id - Comment id to delete.
   * @param task_id - Optional parent task id. When provided, the comment is
   *   only deleted if it belongs to this task. This protects the
   *   `DELETE /tasks/:id/comments/:commentId` route from IDOR — a caller cannot
   *   delete a comment by guessing its id under an unrelated task. Mismatches
   *   are reported as NotFoundError to avoid leaking comment existence across
   *   tasks.
   * @throws NotFoundError if the comment does not exist, or if `task_id` is
   *   provided and the comment does not belong to that task.
   */
  deleteComment(id: number, task_id?: number): void {
    // Verify comment exists
    const comment = this.commentRepo.findById(id);
    if (!comment) {
      throw new NotFoundError('Comment', id);
    }

    // When a task_id scope is supplied, enforce ownership before deletion.
    // Surface the mismatch as NotFoundError to avoid leaking that the comment
    // exists under a different task.
    if (task_id !== undefined && comment.task_id !== task_id) {
      throw new NotFoundError('Comment', id);
    }

    // Delete comment
    this.commentRepo.delete(id);
  }
}
