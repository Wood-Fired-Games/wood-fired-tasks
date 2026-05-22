import type Database from 'better-sqlite3';
import type { Comment, CreateCommentDTO } from '../types/task.js';
import {
  DEFAULT_PAGE_LIMIT,
  DEFAULT_PAGE_OFFSET,
  MAX_PAGE_LIMIT,
} from '../types/task.js';
import type { ICommentRepository, PaginationOptions } from './interfaces.js';
import { mapRow, mapRows } from './row-mapper.js';

function resolvePagination(pagination?: PaginationOptions): {
  limit: number;
  offset: number;
} {
  const rawLimit = pagination?.limit ?? DEFAULT_PAGE_LIMIT;
  const rawOffset = pagination?.offset ?? DEFAULT_PAGE_OFFSET;
  const limit = Number.isFinite(rawLimit) && Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_PAGE_LIMIT)
    : DEFAULT_PAGE_LIMIT;
  const offset = Number.isFinite(rawOffset) && Number.isInteger(rawOffset) && rawOffset >= 0
    ? rawOffset
    : DEFAULT_PAGE_OFFSET;
  return { limit, offset };
}

export class CommentRepository implements ICommentRepository {
  private insertStmt: Database.Statement;
  private findByIdStmt: Database.Statement;
  private findByTaskIdStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private countByTaskIdStmt: Database.Statement;

  constructor(private db: Database.Database) {
    // Prepare reusable statements
    this.insertStmt = db.prepare(`
      INSERT INTO task_comments (task_id, author, content, created_at)
      VALUES (@task_id, @author, @content, @created_at)
    `);

    this.findByIdStmt = db.prepare(
      'SELECT * FROM task_comments WHERE id = ?'
    );

    this.findByTaskIdStmt = db.prepare(
      'SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?'
    );

    this.deleteStmt = db.prepare('DELETE FROM task_comments WHERE id = ?');

    this.countByTaskIdStmt = db.prepare(
      'SELECT COUNT(*) as count FROM task_comments WHERE task_id = ?'
    );
  }

  create(dto: CreateCommentDTO): Comment {
    const now = new Date().toISOString();

    const info = this.insertStmt.run({
      task_id: dto.task_id,
      author: dto.author,
      content: dto.content,
      created_at: now,
    });

    const commentId = info.lastInsertRowid as number;
    const comment = this.findById(commentId);

    if (!comment) {
      throw new Error('Failed to create comment');
    }

    return comment;
  }

  findByTaskId(taskId: number, pagination?: PaginationOptions): Comment[] {
    const { limit, offset } = resolvePagination(pagination);
    return mapRows<Comment>(this.findByTaskIdStmt, taskId, limit, offset);
  }

  findById(id: number): Comment | null {
    const comment = mapRow<Comment>(this.findByIdStmt, id);
    return comment || null;
  }

  delete(id: number): boolean {
    const info = this.deleteStmt.run(id);
    return info.changes > 0;
  }

  countByTaskId(taskId: number): number {
    const result = mapRow<{ count: number }>(this.countByTaskIdStmt, taskId);
    // COUNT(*) always returns exactly one row — `result` is never undefined.
    return result?.count ?? 0;
  }
}
