import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from '../../db/driver.js';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../api/server.js';
import type { Project } from '../../types/task.js';
import { eventBus } from '../event-bus.js';
import { ALLOWED_EVENT_TYPES, isAllowedEventType, type ProjectEvent } from '../types.js';
import { ALLOWED_EVENT_TYPES as ROUTER_ALLOWED } from '../../../packages/wft-router/src/config/event-types.js';

/**
 * Archived project state, A03: the `project.archived` and `project.unarchived`
 * event types are REGISTERED on every surface that enumerates event types
 * (docs/design/project-archived-state.md §2.7, §3.11). Nothing emits them yet
 * — the project service does that in A06 — so these tests emit by hand.
 */
const ARCHIVE_EVENT_TYPES = ['project.archived', 'project.unarchived'] as const;

const archivedProject: Project = {
  id: 7,
  name: 'Shipped',
  description: null,
  created_at: '2026-11-01 00:00:00',
  updated_at: '2026-11-23 12:00:00',
  value_charter: null,
  model_policy: null,
  scm: null,
  archived: true,
  archived_at: '2026-11-23T12:00:00.000Z',
  archived_by: 'alice',
  archive_reason: 'shipped',
};

function eventFor(eventType: (typeof ARCHIVE_EVENT_TYPES)[number]): ProjectEvent {
  return {
    eventType,
    timestamp: '2026-11-23T12:00:00.000Z',
    data: archivedProject,
    metadata: { source: 'user', actor: 'alice' },
  };
}

describe('project.archived / project.unarchived event types', () => {
  const unsubscribers: Array<() => void> = [];

  afterEach(() => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  });

  it.each(ARCHIVE_EVENT_TYPES)('%s is in the root allowlist', (eventType) => {
    expect(ALLOWED_EVENT_TYPES).toContain(eventType);
    expect(isAllowedEventType(eventType)).toBe(true);
  });

  it.each(ARCHIVE_EVENT_TYPES)('%s is in the wft-router allowlist', (eventType) => {
    expect(ROUTER_ALLOWED).toContain(eventType);
  });

  it('keeps the existing event types and their order (additive change)', () => {
    expect([...ALLOWED_EVENT_TYPES]).toEqual([
      'task.created',
      'task.updated',
      'task.deleted',
      'task.status_changed',
      'task.claimed',
      'task.claim_released',
      'project.created',
      'project.updated',
      'project.deleted',
      'project.archived',
      'project.unarchived',
    ]);
  });

  it.each(ARCHIVE_EVENT_TYPES)(
    'the application event bus delivers %s carrying the full project',
    (eventType) => {
      const received: ProjectEvent[] = [];
      unsubscribers.push(eventBus.subscribe(eventType, (event) => received.push(event)));

      eventBus.emit(eventType, eventFor(eventType));

      expect(received).toEqual([eventFor(eventType)]);
      expect(received[0]?.data).toEqual(archivedProject);
    },
  );

  it.each(ARCHIVE_EVENT_TYPES)('getStats() counts %s listeners', (eventType) => {
    const before = eventBus.getStats().listenerCount;
    unsubscribers.push(eventBus.subscribe(eventType, () => {}));
    expect(eventBus.getStats().listenerCount).toBe(before + 1);
  });

  describe('SSE fan-out in the API server', () => {
    let server: FastifyInstance | undefined;
    let db: Database.Database | undefined;

    afterEach(async () => {
      await server?.close();
      db?.close();
      server = undefined;
      db = undefined;
    });

    it.each(ARCHIVE_EVENT_TYPES)('broadcasts %s to SSE clients', async (eventType) => {
      const created = await createServer({ dbPath: ':memory:' });
      server = created.server;
      db = created.app.db;
      const broadcast = vi.spyOn(server.sseManager, 'broadcast');

      eventBus.emit(eventType, eventFor(eventType));

      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith(eventFor(eventType));
    });

    it('stops broadcasting once the server is closed (no listener leak)', async () => {
      const before = eventBus.getStats().listenerCount;
      const created = await createServer({ dbPath: ':memory:' });
      // One SSE listener per allowed event type (other server components may
      // subscribe too, so this is a floor, not an exact count).
      expect(eventBus.getStats().listenerCount).toBeGreaterThanOrEqual(
        before + ALLOWED_EVENT_TYPES.length,
      );

      await created.server.close();
      created.app.db.close();

      expect(eventBus.getStats().listenerCount).toBe(before);
    });
  });
});
