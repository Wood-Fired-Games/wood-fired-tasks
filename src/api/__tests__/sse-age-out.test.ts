/**
 * task #1001 — SSE maxConnectionAge eviction must CLOSE the peer stream.
 *
 * Root-caused bug (reproduced 3x during the Tiny Worlds orchestration pilot,
 * 2026-06-10): the heartbeat sweep evicted over-age connections with
 * `removeConnection()` (map delete only). The reply stream was never ended,
 * so the client kept an open TCP connection receiving no events, no pings
 * and no FIN — its reconnect logic never fired and it went silently deaf
 * after maxConnectionAgeMs (default 10 min).
 *
 * This suite proves the fix END-TO-END over a real listening socket:
 *   1. a real SSE client connects and receives live events;
 *   2. when the manager ages the connection out, the CLIENT observes the
 *      stream end (read() resolves done — i.e. a FIN arrived);
 *   3. a reconnecting client carrying `Last-Event-ID` replays the events it
 *      missed while disconnected and resumes live delivery.
 *
 * @fastify/sse does not support inject() (see events.test.ts), so we bind to
 * an ephemeral port and stream over real HTTP. Driving 10 minutes of fake
 * wall-clock against live sockets is not viable, so the test backdates the
 * connection's `createdAt` and invokes one `heartbeatSweep()` directly — the
 * exact code path the 30s interval runs in production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import type { EventPayload } from '../../events/types.js';
import { authHeaders } from './helpers/auth.js';

interface ParsedSSEFrame {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Minimal EventSource-style client over fetch. Accumulates parsed frames and
 * flips `ended` when the server ends the stream (FIN) or the socket errors.
 */
class SSETestClient {
  readonly frames: ParsedSSEFrame[] = [];
  ended = false;
  private buffer = '';
  private reader?: ReadableStreamDefaultReader<Uint8Array>;

  async connect(url: string, headers: Record<string, string>): Promise<void> {
    const res = await fetch(url, {
      headers: { ...headers, Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    if (!res.body) throw new Error('SSE response has no body');
    this.reader = res.body.getReader();
    void this.pump();
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await this.reader!.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.drainFrames();
      }
    } catch {
      // A reset/abort also means the peer is no longer attached — for this
      // suite both count as "the client observed the stream end".
    }
    this.ended = true;
  }

  private drainFrames(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      if (block.startsWith(':')) continue; // heartbeat comment
      const frame: ParsedSSEFrame = { data: '' };
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) frame.id = line.slice(3).trim();
        else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      frame.data = dataLines.join('\n');
      this.frames.push(frame);
    }
  }

  abort(): void {
    this.reader?.cancel().catch(() => {});
  }
}

/** Poll until `fn` returns a defined value or the timeout elapses. */
async function waitFor<T>(fn: () => T | undefined, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeEvent(id: number): EventPayload<unknown> {
  return {
    eventType: 'task.created',
    timestamp: new Date().toISOString(),
    data: { id, title: `Event ${id}`, project_id: 1 },
    metadata: { source: 'user' },
  };
}

describe('SSE age-out eviction over a real socket (task #1001)', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let baseUrl: string;
  let auth: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
    auth = authHeaders(db);
    baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('aged-out connection receives a stream close and a reconnecting client resumes events', async () => {
    const eventsUrl = `${baseUrl}/api/v1/events`;
    const mgr = server.sseManager as any;

    // --- Phase 1: live client receives events normally. -------------------
    const client1 = new SSETestClient();
    await client1.connect(eventsUrl, auth);
    await waitFor(
      () => client1.frames.find((f) => f.event === 'connected'),
      'connected handshake (client1)',
    );

    server.sseManager.broadcast(makeEvent(1)); // event ID 1
    const live = await waitFor(
      () => client1.frames.find((f) => f.event === 'task.created'),
      'live event delivery (client1)',
    );
    expect(live.id).toBe('1');
    expect(client1.ended).toBe(false);

    // --- Phase 2: age the connection out and run one heartbeat sweep. -----
    // Backdate createdAt past maxConnectionAgeMs instead of waiting 10 real
    // minutes; heartbeatSweep() is the exact production eviction path.
    expect(mgr.connections.size).toBe(1);
    for (const conn of mgr.connections.values()) {
      conn.createdAt = new Date(Date.now() - (10 * 60 * 1000 + 1000));
    }
    mgr.heartbeatSweep();

    // The CLIENT must observe the stream end (FIN). Before the fix this
    // timed out: the map entry vanished but the socket stayed open forever.
    await waitFor(
      () => (client1.ended ? true : undefined),
      'client1 to observe stream close after age-out',
    );
    expect(mgr.connections.size).toBe(0);

    // --- Phase 3: an event fires while the client is disconnected... ------
    server.sseManager.broadcast(makeEvent(2)); // event ID 2

    // --- Phase 4: ...and a reconnect with Last-Event-ID resumes delivery. -
    const client2 = new SSETestClient();
    await client2.connect(eventsUrl, { ...auth, 'Last-Event-ID': '1' });

    const replayed = await waitFor(
      () => client2.frames.find((f) => f.event === 'task.created' && f.id === '2'),
      'replay of the missed event (client2)',
    );
    expect(JSON.parse(replayed.data)).toMatchObject({ data: { id: 2 } });

    // Live delivery also resumes on the new connection.
    server.sseManager.broadcast(makeEvent(3)); // event ID 3
    await waitFor(
      () => client2.frames.find((f) => f.event === 'task.created' && f.id === '3'),
      'live event after reconnect (client2)',
    );

    client2.abort();
  });

  it('bufferTtlMs covers the full maxConnectionAgeMs window (replay-gap alignment)', () => {
    // task #1001 AC3: an aged-out client reconnects with Last-Event-Id and
    // must be able to replay anything it could have missed during its
    // previous connection's lifetime. That requires bufferTtlMs >=
    // maxConnectionAgeMs. Both values are the constructor defaults in
    // production (server.ts passes `undefined` for each), so asserting the
    // running server's manager pins the prod relationship.
    const mgr = server.sseManager as any;
    expect(mgr.bufferTtlMs).toBeGreaterThanOrEqual(mgr.maxConnectionAgeMs);
  });
});
