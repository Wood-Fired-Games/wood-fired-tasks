import type Database from 'better-sqlite3';
import type { Dependency, CreateDependencyDTO } from '../types/task.js';
import type { IDependencyRepository } from './interfaces.js';
import { mapRows } from './row-mapper.js';

export class DependencyRepository implements IDependencyRepository {
  private insertStmt: Database.Statement;
  private findAllStmt: Database.Statement;
  private findByTaskIdStmt: Database.Statement;
  private findBlockingTaskStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private deleteByTaskIdStmt: Database.Statement;

  constructor(private db: Database.Database) {
    // Prepare reusable statements
    this.insertStmt = db.prepare(`
      INSERT INTO task_dependencies (task_id, blocks_task_id, created_at)
      VALUES (@task_id, @blocks_task_id, @created_at)
    `);

    this.findAllStmt = db.prepare('SELECT * FROM task_dependencies');

    this.findByTaskIdStmt = db.prepare(
      'SELECT * FROM task_dependencies WHERE task_id = ?'
    );

    this.findBlockingTaskStmt = db.prepare(
      'SELECT * FROM task_dependencies WHERE blocks_task_id = ?'
    );

    this.deleteStmt = db.prepare(
      'DELETE FROM task_dependencies WHERE task_id = ? AND blocks_task_id = ?'
    );

    this.deleteByTaskIdStmt = db.prepare(
      'DELETE FROM task_dependencies WHERE task_id = ?'
    );
  }

  create(dto: CreateDependencyDTO): Dependency {
    const now = new Date().toISOString();

    const info = this.insertStmt.run({
      task_id: dto.task_id,
      blocks_task_id: dto.blocks_task_id,
      created_at: now,
    });

    const id = info.lastInsertRowid as number;

    return {
      id,
      task_id: dto.task_id,
      blocks_task_id: dto.blocks_task_id,
      created_at: now,
    };
  }

  findAll(): Dependency[] {
    return mapRows<Dependency>(this.findAllStmt);
  }

  findByTaskId(taskId: number): Dependency[] {
    return mapRows<Dependency>(this.findByTaskIdStmt, taskId);
  }

  findBlockingTask(taskId: number): Dependency[] {
    return mapRows<Dependency>(this.findBlockingTaskStmt, taskId);
  }

  delete(taskId: number, blocksTaskId: number): boolean {
    const result = this.deleteStmt.run(taskId, blocksTaskId);
    return result.changes > 0;
  }

  deleteByTaskId(taskId: number): void {
    this.deleteByTaskIdStmt.run(taskId);
  }
}
