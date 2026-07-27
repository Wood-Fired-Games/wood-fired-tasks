import type Database from '../db/driver.js';
import type { AuditEventRecord, AuditEventRow, IAuditEventRepository } from './interfaces.js';
import { mapRows } from './row-mapper.js';
import { parseJsonColumn } from '../utils/parse-json-column.js';

/**
 * Security Audit finding M5 (task #1629): append-only repository over the
 * `audit_events` table (created by migration 018, task #1628).
 *
 * This repository is the EXCLUSIVE owner of `audit_events`'s lifecycle —
 * nothing else in this codebase should read or write that table directly.
 *
 * Append-only is enforced in TWO independent layers:
 *  - SQL: migration 018's `BEFORE UPDATE` / `BEFORE DELETE` triggers
 *    `RAISE(ABORT, ...)` against any mutation attempt reaching SQLite.
 *  - Types: {@link IAuditEventRepository} (declared in `./interfaces.js`)
 *    exposes only `append` plus bounded query helpers — it has no
 *    `update`/`delete` member at all, so a caller cannot even compile a
 *    mutation call against this repository. Unlike the `wsjf_score_history` /
 *    `project_charter_history` repositories (which keep throwing `update()`/
 *    `delete()` stubs to satisfy their own interfaces), this repository
 *    deliberately omits those members entirely, per the M5 remediation's
 *    "no update/delete member" requirement.
 *
 * Every query helper is `limit`-bounded and returns rows newest-first
 * (`ORDER BY timestamp DESC, id DESC` — the `id` tiebreaker keeps ordering
 * deterministic when two events share a `timestamp` value).
 */
export class AuditEventRepository implements IAuditEventRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByActorStmt: Database.Statement;
  private readonly findByResourceStmt: Database.Statement;
  private readonly findByTimeRangeStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO audit_events (
        actor_type, actor_id, token_id, action, resource_type, resource_id, request_id, metadata
      ) VALUES (
        @actor_type, @actor_id, @token_id, @action, @resource_type, @resource_id, @request_id, @metadata
      )
    `);
    this.findByActorStmt = db.prepare(
      'SELECT * FROM audit_events WHERE actor_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?',
    );
    this.findByResourceStmt = db.prepare(
      'SELECT * FROM audit_events WHERE resource_type = ? AND resource_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?',
    );
    this.findByTimeRangeStmt = db.prepare(
      'SELECT * FROM audit_events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC, id DESC LIMIT ?',
    );
  }

  append(record: AuditEventRecord): number {
    const info = this.insertStmt.run({
      actor_type: record.actorType,
      actor_id: record.actorId,
      token_id: record.tokenId ?? null,
      action: record.action,
      resource_type: record.resourceType,
      resource_id: record.resourceId ?? null,
      request_id: record.requestId ?? null,
      metadata:
        record.metadata === undefined || record.metadata === null
          ? null
          : JSON.stringify(record.metadata),
    });
    return info.lastInsertRowid as number;
  }

  findByActor(actorId: string, limit: number): AuditEventRow[] {
    return this.toRows(mapRows<Record<string, unknown>>(this.findByActorStmt, actorId, limit));
  }

  findByResource(resourceType: string, resourceId: string, limit: number): AuditEventRow[] {
    return this.toRows(
      mapRows<Record<string, unknown>>(this.findByResourceStmt, resourceType, resourceId, limit),
    );
  }

  findByTimeRange(start: string, end: string, limit: number): AuditEventRow[] {
    return this.toRows(
      mapRows<Record<string, unknown>>(this.findByTimeRangeStmt, start, end, limit),
    );
  }

  private toRows(rows: Record<string, unknown>[]): AuditEventRow[] {
    return rows.map((row) => ({
      id: row['id'] as number,
      timestamp: row['timestamp'] as string,
      actor_type: row['actor_type'] as string,
      actor_id: row['actor_id'] as string,
      token_id: (row['token_id'] as string | null) ?? null,
      action: row['action'] as string,
      resource_type: row['resource_type'] as string,
      resource_id: (row['resource_id'] as string | null) ?? null,
      request_id: (row['request_id'] as string | null) ?? null,
      metadata: parseJsonColumn<Record<string, unknown>>(row['metadata']),
    }));
  }
}
