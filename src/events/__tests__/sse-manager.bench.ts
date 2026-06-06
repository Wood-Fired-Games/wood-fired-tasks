/**
 * Vitest benchmarks for SSEManager.broadcast hot path (task #212).
 *
 * Soft / advisory bench — see `task.repository.bench.ts` header. Bench is run
 * via `npm run test:bench`; vitest auto-excludes *.bench.ts from `npm test`.
 *
 * Strategy: register N mock FastifyReply objects, each with a fast in-memory
 * `sse.send` that just resolves. The bench measures the cost of fan-out
 * (Map iteration + filter check + per-connection sendEvent dispatch) without
 * the noise of real socket writes.
 *
 * NOTE: Vitest 4's bench mode does not reliably execute `beforeAll` for
 * setup; we initialize at module-load time instead.
 */
import { bench, describe } from 'vitest';
import { EventEmitter } from 'events';
import { SSEManager } from '../sse-manager.js';
import type { EventPayload } from '../types.js';

const CONNECTION_COUNT = 200; // matches the default global cap
const SOFT_CEILING_MS = 250;

function createMockReply(): any {
  const raw = new EventEmitter();
  return {
    raw,
    sse: {
      // Resolved promise lets us measure the synchronous fan-out cost without
      // microtask flushing dominating the bench. The real implementation
      // already treats send as fire-and-forget.
      send: () => Promise.resolve(),
    },
  };
}

// ---- module-level seeding (runs once before any bench iteration) ----
// Allow enough headroom for N connections + filter variants. Make heartbeat
// effectively infinite so it doesn't fire mid-bench and skew samples.
const manager = new SSEManager(
  100, // maxBufferSize
  5 * 60 * 1000, // bufferTtlMs
  60 * 60 * 1000, // heartbeatIntervalMs — large so heartbeat doesn't fire mid-bench
  24 * 60 * 60 * 1000, // maxConnectionAgeMs
  CONNECTION_COUNT + 10, // maxConnectionsPerKey — disable per-key cap
  CONNECTION_COUNT + 10, // maxConnectionsPerIp — disable per-ip cap
  CONNECTION_COUNT + 10, // maxConnections — disable global cap
);

// Register N mixed-filter connections so matchesFilters() exercises both
// pass and reject branches.
for (let i = 0; i < CONNECTION_COUNT; i++) {
  const filters: { project_id?: number; event_types?: string[] } = {};
  if (i % 3 === 0) filters.project_id = (i % 5) + 1;
  if (i % 4 === 0) filters.event_types = ['task.created', 'task.updated'];
  manager.addConnection(`bench-conn-${i}`, createMockReply(), filters, undefined, {
    apiKeyFingerprint: `fp-${i}`,
    ip: `10.0.0.${i % 250}`,
  });
}

// eslint-disable-next-line no-console
console.log(
  `[bench seed] sse_connections=${CONNECTION_COUNT} ` + `soft_ceiling_ms=${SOFT_CEILING_MS}`,
);

describe('SSEManager.broadcast (bench)', () => {
  bench(
    'broadcast() — task.created to all connections',
    () => {
      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Bench task', project_id: 1 },
        metadata: { source: 'user' },
      };
      manager.broadcast(event);
    },
    { time: 2000 },
  );

  bench(
    'broadcast() — event with project_id filter mismatch (common reject path)',
    () => {
      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Bench task', project_id: 999 },
        metadata: { source: 'user' },
      };
      manager.broadcast(event);
    },
    { time: 2000 },
  );
});
