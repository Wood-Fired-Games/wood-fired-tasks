import type Database from 'better-sqlite3';
import type { Comment, CreateCommentDTO } from '../types/task.js';
import type { ICommentRepository } from './interfaces.js';

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
      'SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC'
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

  findByTaskId(taskId: number): Comment[] {
    return this.findByTaskIdStmt.all(taskId) as Comment[];
  }

  findById(id: number): Comment | null {
    const comment = this.findByIdStmt.get(id) as Comment | undefined;
    return comment || null;
  }

  delete(id: number): boolean {
    const info = this.deleteStmt.run(id);
    return info.changes > 0;
  }

  countByTaskId(taskId: number): number {
    const result = this.countByTaskIdStmt.get(taskId) as { count: number };
    return result.count;
  }
}
