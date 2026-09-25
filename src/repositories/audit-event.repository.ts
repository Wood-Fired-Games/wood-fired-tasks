import { createHash } from 'node:crypto';
import type Database from '../db/driver.js';
import type { AuditEventRecord, AuditEventRow, IAuditEventRepository } from './interfaces.js';
import { mapRows } from './row-mapper.js';
import { parseJsonColumn } from '../utils/parse-json-column.js';

/**
 * Security Audit finding M5 (task #1629): append-only repository over the
 * `audit_events` table (created by migration 018, task #1628; hash-chain
 * columns added by migration 019, task #1636).
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
 * Those two layers give tamper *resistance*. Tamper *evidence* — detecting an
 * edit made by someone who can write the SQLite file directly, around the
 * triggers — comes from the hash chain: see {@link computeAuditRowHash} and
 * {@link AuditEventRepository.verifyChain}.
 *
 * Every query helper is `limit`-bounded and returns rows newest-first
 * (`ORDER BY timestamp DESC, id DESC` — the `id` tiebreaker keeps ordering
 * deterministic when two events share a `timestamp` value).
 */

/**
 * `prev_hash` of the first row in the chain. 64 '0' hex characters — the same
 * width as a SHA-256 digest, and a value no SHA-256 output realistically
 * collides with, so "row 1" is unambiguous and a row cannot silently claim to
 * be the head of the chain by hashing to it.
 */
export const AUDIT_CHAIN_GENESIS_HASH = '0'.repeat(64);

/**
 * Domain-separation tag mixed into every digest. Bumping the suffix would
 * invalidate every existing hash, so it is versioned: if the hashed field set
 * ever changes, introduce `...v2` rather than silently redefining `v1`.
 */
const AUDIT_CHAIN_DOMAIN = 'wft.audit_events.hash-chain.v1';

/**
 * The content columns covered by a row's hash, in their raw stored form.
 *
 * `metadata` is the raw TEXT column (the `JSON.stringify` output), NOT the
 * parsed object: the chain must be verifiable from exactly what is on disk,
 * and re-serializing a parsed object is not guaranteed to reproduce the
 * original byte sequence.
 *
 * `id` is deliberately NOT hashed. It is not known until after the INSERT
 * completes, and the append-only triggers forbid the follow-up UPDATE that
 * would be needed to fold it in. Ordering is instead established by the chain
 * links themselves: each row commits to its predecessor's digest.
 */
export interface AuditChainContent {
  timestamp: string;
  actor_type: string;
  actor_id: string;
  token_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string | null;
  metadata: string | null;
}

/**
 * Canonical, order-stable serialization of one row's hashed content.
 *
 * A JSON array (not a delimiter-joined string) so that a value containing the
 * delimiter cannot be crafted to imitate a different field split — JSON
 * escaping makes the field boundaries unambiguous. Array order is fixed here
 * and must never be reordered without bumping {@link AUDIT_CHAIN_DOMAIN}.
 */
export function canonicalAuditPayload(content: AuditChainContent, prevHash: string): string {
  return JSON.stringify([
    AUDIT_CHAIN_DOMAIN,
    prevHash,
    content.timestamp,
    content.actor_type,
    content.actor_id,
    content.token_id,
    content.action,
    content.resource_type,
    content.resource_id,
    content.request_id,
    content.metadata,
  ]);
}

/** SHA-256 (hex) over {@link canonicalAuditPayload}. */
export function computeAuditRowHash(content: AuditChainContent, prevHash: string): string {
  return createHash('sha256')
    .update(canonicalAuditPayload(content, prevHash), 'utf8')
    .digest('hex');
}

/** Shape read back by the chain walk in {@link AuditEventRepository.verifyChain}. */
interface AuditChainRow extends AuditChainContent {
  id: number;
  prev_hash: string | null;
  row_hash: string | null;
}

export class AuditEventRepository implements IAuditEventRepository {
  private readonly insertStmt: Database.Statement;
  private readonly chainHeadStmt: Database.Statement;
  private readonly chainWalkStmt: Database.Statement;
  private readonly findByActorStmt: Database.Statement;
  private readonly findByResourceStmt: Database.Statement;
  private readonly findByTimeRangeStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO audit_events (
        timestamp, actor_type, actor_id, token_id, action, resource_type, resource_id,
        request_id, metadata, prev_hash, row_hash
      ) VALUES (
        @timestamp, @actor_type, @actor_id, @token_id, @action, @resource_type, @resource_id,
        @request_id, @metadata, @prev_hash, @row_hash
      )
    `);
    // One round-trip for both facts the chain link needs: the clock value the
    // row will store (computed here rather than by the column DEFAULT so the
    // hash can cover the exact stored string) and the tail row's digest.
    // `datetime('now')` matches migration 018's column default byte for byte.
    this.chainHeadStmt = db.prepare(`
      SELECT
        datetime('now') AS ts,
        (SELECT row_hash FROM audit_events ORDER BY id DESC LIMIT 1) AS tail_hash
    `);
    this.chainWalkStmt = db.prepare(`
      SELECT id, timestamp, actor_type, actor_id, token_id, action, resource_type,
             resource_id, request_id, metadata, prev_hash, row_hash
      FROM audit_events
      ORDER BY id ASC
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

  /**
   * Append one immutable, chain-linked audit row and return its id.
   *
   * Runs as a `BEGIN IMMEDIATE` transaction (same rationale as
   * `TaskRepository.claimTask`): reading the tail digest and inserting the
   * successor must be atomic, or two concurrent appends could both link to
   * the same predecessor and fork the chain.
   */
  append(record: AuditEventRecord): number {
    const appendTransaction = this.db.transaction((): number => {
      const head = this.chainHeadStmt.get() as { ts: string; tail_hash: string | null };
      const prevHash = head.tail_hash ?? AUDIT_CHAIN_GENESIS_HASH;

      const content: AuditChainContent = {
        timestamp: head.ts,
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
      };

      const info = this.insertStmt.run({
        ...content,
        prev_hash: prevHash,
        row_hash: computeAuditRowHash(content, prevHash),
      });
      return info.lastInsertRowid as number;
    });

    return appendTransaction.immediate();
  }

  /**
   * Walk the whole chain in `id` order and return the id of the FIRST row
   * that does not verify, or `null` when the trail is intact.
   *
   * A row fails when either
   *  - its `prev_hash` is not the digest of the row before it (genesis for the
   *    first row) — this is what catches a deleted or reordered row, since the
   *    survivor still commits to a predecessor that is no longer there; or
   *  - its `row_hash` is not the digest of its own stored content — this is
   *    what catches an edited field.
   * A row inserted around this repository has NULL in both columns and fails
   * on the first check.
   *
   * Known limitation, inherent to any append-only hash chain: truncation of
   * the TAIL is not detectable from the chain alone (the remaining prefix is
   * self-consistent). Detecting that needs an external anchor — a periodically
   * published head digest or a row count checkpoint — which is out of scope
   * here and is why the 018 DELETE trigger still matters.
   */
  verifyChain(): number | null {
    let expectedPrevHash = AUDIT_CHAIN_GENESIS_HASH;

    for (const raw of this.chainWalkStmt.iterate()) {
      const row = raw as AuditChainRow;
      if (row.prev_hash !== expectedPrevHash) {
        return row.id;
      }
      if (row.row_hash !== computeAuditRowHash(row, expectedPrevHash)) {
        return row.id;
      }
      expectedPrevHash = row.row_hash;
    }

    return null;
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
      prev_hash: (row['prev_hash'] as string | null) ?? null,
      row_hash: (row['row_hash'] as string | null) ?? null,
    }));
  }
}
