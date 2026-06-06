import type { FastifyReply } from 'fastify';
import { EventPayload, getEventProjectId } from './types.js';

interface SSEConnection {
  id: string;
  reply: FastifyReply;
  filters: {
    project_id?: number;
    event_types?: string[];
  };
  lastEventId: number;
  createdAt: Date;
  // task #185: per-key/per-IP attribution for connection caps.
  // task #194: stores a short SHA-256 fingerprint (16 hex chars) of the API
  // key, never the raw key. Hashing both sides of the per-key comparison
  // means a heap dump or core file no longer leaks live API credentials.
  // Same hash function as the auth plugin, so the same key always maps to
  // the same fingerprint and the per-key cap still aggregates correctly.
  apiKeyFingerprint: string;
  ip: string;
}

/**
 * Reason the SSEManager rejected a new connection request. Used by the route
 * handler to shape the 429 response (which cap was hit).
 */
export type SSECapDenyReason = 'per-key' | 'per-ip' | 'global';

/**
 * Result of {@link SSEManager.canAccept}.
 *
 * - `ok: true` — connection is allowed; route may proceed to `addConnection`.
 * - `ok: false` — caller MUST reject the request with HTTP 429 + `Retry-After`
 *   header. `reason` identifies which cap was breached so error messages can
 *   point operators at the right env var to raise.
 */
export type SSECapDecision =
  | { ok: true }
  | { ok: false; reason: SSECapDenyReason; retryAfterSeconds: number };

/**
 * task #185: how long clients should wait before reconnecting after a cap
 * rejection. Picked to be roughly one heartbeat interval — long enough that
 * an attacker's brute-force loop hits real backpressure, short enough that
 * legitimate clients recover quickly when an over-quota connection drops.
 */
const SSE_CAP_RETRY_AFTER_SECONDS = 30;

export class SSEManager {
  private connections = new Map<string, SSEConnection>();
  private eventBuffer: Array<{ id: number; event: EventPayload<unknown> }> = [];
  private nextEventId = 1;
  private heartbeatInterval?: NodeJS.Timeout;
  private createdAt = Date.now();
  private totalEventsSent = 0;

  constructor(
    private readonly maxBufferSize = 100,
    private readonly bufferTtlMs = 5 * 60 * 1000, // 5 minutes
    private readonly heartbeatIntervalMs = 30000, // 30 seconds
    private readonly maxConnectionAgeMs = 10 * 60 * 1000, // 10 minutes
    // task #185: per-key, per-IP and global concurrent connection caps.
    // Defaults are conservative — operators raise via env. The values are
    // stored read-only and consulted on every `canAccept` call.
    private readonly maxConnectionsPerKey = 4,
    private readonly maxConnectionsPerIp = 8,
    private readonly maxConnections = 200,
  ) {
    this.startHeartbeat();
  }

  /**
   * task #185: synchronous cap check. The events route MUST call this
   * BEFORE `addConnection` so a denied request never half-registers state.
   *
   * Counts are derived from the live connection map on each call. n is
   * bounded by `maxConnections` (default 200), so O(n) iteration is fine
   * and avoids drift bugs that a separate per-key/per-IP index would
   * introduce when connections close out-of-band (raw `close` / `error`
   * events run on a different tick).
   */
  canAccept(apiKeyFingerprint: string, ip: string): SSECapDecision {
    if (this.connections.size >= this.maxConnections) {
      return { ok: false, reason: 'global', retryAfterSeconds: SSE_CAP_RETRY_AFTER_SECONDS };
    }

    let perKey = 0;
    let perIp = 0;
    for (const conn of this.connections.values()) {
      if (conn.apiKeyFingerprint === apiKeyFingerprint) perKey++;
      if (conn.ip === ip) perIp++;
    }
    if (perKey >= this.maxConnectionsPerKey) {
      return { ok: false, reason: 'per-key', retryAfterSeconds: SSE_CAP_RETRY_AFTER_SECONDS };
    }
    if (perIp >= this.maxConnectionsPerIp) {
      return { ok: false, reason: 'per-ip', retryAfterSeconds: SSE_CAP_RETRY_AFTER_SECONDS };
    }
    return { ok: true };
  }

  addConnection(
    connectionId: string,
    reply: FastifyReply,
    filters: { project_id?: number; event_types?: string[] },
    lastEventId?: number,
    meta: { apiKeyFingerprint: string; ip: string } = { apiKeyFingerprint: '', ip: '' },
  ): void {
    // Store connection. task #194: only the fingerprint is retained — the
    // caller (events route) computes it via hashKey(rawKey).slice(0,16) so
    // the raw key never crosses this boundary.
    this.connections.set(connectionId, {
      id: connectionId,
      reply,
      filters,
      lastEventId: lastEventId || 0,
      createdAt: new Date(),
      apiKeyFingerprint: meta.apiKeyFingerprint,
      ip: meta.ip,
    });

    // Replay missed events if Last-Event-ID provided
    if (lastEventId !== undefined) {
      this.replayEvents(connectionId, lastEventId);
    }

    // Cleanup on connection close
    reply.raw.on('close', () => this.removeConnection(connectionId));
    reply.raw.on('error', () => this.removeConnection(connectionId));
  }

  removeConnection(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  broadcast(event: EventPayload<unknown>): void {
    const eventId = this.nextEventId++;

    // Add to buffer for Last-Event-ID replay
    this.eventBuffer.push({ id: eventId, event });
    this.pruneEventBuffer();

    // Send to all matching connections
    for (const conn of this.connections.values()) {
      if (this.matchesFilters(event, conn.filters)) {
        this.sendEvent(conn, eventId, event);
      }
    }
  }

  private matchesFilters(
    event: EventPayload<unknown>,
    filters: { project_id?: number; event_types?: string[] },
  ): boolean {
    // Filter by event type
    if (filters.event_types && !filters.event_types.includes(event.eventType)) {
      return false;
    }

    // Filter by project_id (only applies to task/project events). The typed
    // accessor narrows event.data without an unsafe cast: it returns the
    // numeric project_id when present, else undefined (e.g. control events).
    if (filters.project_id) {
      const eventProjectId = getEventProjectId(event);
      if (eventProjectId !== undefined) {
        return eventProjectId === filters.project_id;
      }
    }

    return true;
  }

  private sendEvent(conn: SSEConnection, eventId: number, event: EventPayload<unknown>): void {
    // Send SSE message (fire-and-forget, catch errors to prevent unhandled rejections)
    conn.reply.sse
      .send({
        id: String(eventId),
        event: event.eventType,
        data: event,
      })
      .then(() => {
        conn.lastEventId = eventId;
        this.totalEventsSent++;
      })
      .catch(() => {
        // Connection likely closed, remove it
        this.removeConnection(conn.id);
      });
  }

  private replayEvents(connectionId: string, fromEventId: number): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    // task #206: if the client asked for an event older than anything we
    // still have in the buffer (because we pruned it for size/TTL), they
    // missed events we can no longer replay. Send an explicit `replay-gap`
    // hint so the client knows to refetch via REST instead of silently
    // believing they have a complete event stream. We only signal a gap
    // when fromEventId > 0 AND the buffer's smallest live id is greater
    // than fromEventId+1 — i.e. there is genuinely a missing range.
    if (fromEventId > 0 && this.eventBuffer.length > 0) {
      const earliestBufferedId = this.eventBuffer[0]!.id;
      if (earliestBufferedId > fromEventId + 1) {
        // Fire-and-forget; if the send fails the close/error handler will
        // clean up. We intentionally do not increment totalEventsSent for
        // this control message — it's not a domain event.
        conn.reply.sse
          .send({
            event: 'replay-gap',
            data: JSON.stringify({
              requestedLastEventId: fromEventId,
              earliestAvailableId: earliestBufferedId,
              hint: 'Some events were pruned from the server buffer. Refetch state via REST.',
            }),
          })
          .catch(() => {
            this.removeConnection(connectionId);
          });
      }
    }

    const missedEvents = this.eventBuffer.filter((e) => e.id > fromEventId);
    for (const { id, event } of missedEvents) {
      if (this.matchesFilters(event, conn.filters)) {
        this.sendEvent(conn, id, event);
      }
    }
  }

  private pruneEventBuffer(): void {
    // Keep only last maxBufferSize events
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer = this.eventBuffer.slice(-this.maxBufferSize);
    }

    // Remove events older than TTL
    const cutoff = Date.now() - this.bufferTtlMs;
    this.eventBuffer = this.eventBuffer.filter(
      (e) => new Date(e.event.timestamp).getTime() > cutoff,
    );
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();

      for (const conn of this.connections.values()) {
        // Send heartbeat ping (fire-and-forget)
        conn.reply.sse.send({ event: 'ping', data: '' }).catch(() => {
          // Connection closed, remove it
          this.removeConnection(conn.id);
        });

        // Enforce max connection age
        const age = now - conn.createdAt.getTime();
        if (age > this.maxConnectionAgeMs) {
          this.removeConnection(conn.id);
        }
      }
    }, this.heartbeatIntervalMs);
  }

  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.connections.clear();
    this.eventBuffer = [];
  }

  /**
   * Check if SSE manager is healthy (has active heartbeat)
   */
  isHealthy(): boolean {
    return this.heartbeatInterval !== undefined;
  }

  /**
   * Get SSE manager statistics for health monitoring
   */
  getStats(): { clientCount: number; uptime: number; totalEventsSent: number } {
    return {
      clientCount: this.connections.size,
      uptime: Date.now() - this.createdAt,
      totalEventsSent: this.totalEventsSent,
    };
  }
}
