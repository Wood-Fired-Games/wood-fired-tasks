import type { FastifyReply } from 'fastify';
import { EventPayload } from './types.js';

interface SSEConnection {
  id: string;
  reply: FastifyReply;
  filters: {
    project_id?: number;
    event_types?: string[];
  };
  lastEventId: number;
  createdAt: Date;
}

export class SSEManager {
  private connections = new Map<string, SSEConnection>();
  private eventBuffer: Array<{ id: number; event: EventPayload<unknown> }> = [];
  private nextEventId = 1;
  private heartbeatInterval?: NodeJS.Timeout;

  constructor(
    private readonly maxBufferSize = 1000,
    private readonly bufferTtlMs = 5 * 60 * 1000, // 5 minutes
    private readonly heartbeatIntervalMs = 30000, // 30 seconds
    private readonly maxConnectionAgeMs = 10 * 60 * 1000 // 10 minutes
  ) {
    this.startHeartbeat();
  }

  addConnection(
    connectionId: string,
    reply: FastifyReply,
    filters: { project_id?: number; event_types?: string[] },
    lastEventId?: number
  ): void {
    // Store connection
    this.connections.set(connectionId, {
      id: connectionId,
      reply,
      filters,
      lastEventId: lastEventId || 0,
      createdAt: new Date(),
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
    filters: { project_id?: number; event_types?: string[] }
  ): boolean {
    // Filter by event type
    if (filters.event_types && !filters.event_types.includes(event.eventType)) {
      return false;
    }

    // Filter by project_id (only applies to task/project events)
    if (filters.project_id && 'project_id' in (event.data as any)) {
      return (event.data as any).project_id === filters.project_id;
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
      })
      .catch(() => {
        // Connection likely closed, remove it
        this.removeConnection(conn.id);
      });
  }

  private replayEvents(connectionId: string, fromEventId: number): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

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
      (e) => new Date(e.event.timestamp).getTime() > cutoff
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
}
