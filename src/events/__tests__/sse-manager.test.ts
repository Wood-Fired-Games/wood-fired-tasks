import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSEManager } from '../sse-manager.js';
import { EventPayload } from '../types.js';
import { EventEmitter } from 'events';

// Mock FastifyReply for testing
function createMockReply(): any {
  const raw = new EventEmitter();
  const sentEvents: any[] = [];

  return {
    raw,
    sse: {
      send: vi.fn((data: any) => {
        sentEvents.push(data);
        return Promise.resolve();
      }),
    },
    _getSentEvents: () => sentEvents,
  };
}

describe('SSEManager', () => {
  let manager: SSEManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (manager) {
      manager.shutdown();
    }
    vi.useRealTimers();
  });

  describe('addConnection', () => {
    it('should store connection in registry', () => {
      manager = new SSEManager();
      const reply = createMockReply();

      manager.addConnection('conn-1', reply, {});

      // Broadcast an event to verify connection exists
      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event);
      expect(reply.sse.send).toHaveBeenCalled();
    });

    it('should replay missed events when Last-Event-ID provided', () => {
      manager = new SSEManager();

      // Broadcast two events before connection
      const event1: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Event 1', project_id: 1 },
        metadata: { source: 'user' },
      };
      const event2: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 2, title: 'Event 2', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event1); // event ID 1
      manager.broadcast(event2); // event ID 2

      // Connect with Last-Event-ID = 1 (should replay event 2)
      const reply = createMockReply();
      manager.addConnection('conn-1', reply, {}, 1);

      const sentEvents = reply._getSentEvents();
      expect(sentEvents.length).toBe(1);
      expect(sentEvents[0].id).toBe('2');
      expect(sentEvents[0].data).toMatchObject(event2);
    });

    it('should cleanup connection on close event', () => {
      manager = new SSEManager();
      const reply = createMockReply();

      manager.addConnection('conn-1', reply, {});

      // Trigger close event
      reply.raw.emit('close');

      // Verify connection removed by broadcasting
      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event);
      expect(reply.sse.send).not.toHaveBeenCalled(); // Should not be called since connection was removed
    });

    it('should cleanup connection on error event', () => {
      manager = new SSEManager();
      const reply = createMockReply();

      manager.addConnection('conn-1', reply, {});

      // Trigger error event
      reply.raw.emit('error', new Error('Connection error'));

      // Verify connection removed
      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event);
      expect(reply.sse.send).not.toHaveBeenCalled();
    });
  });

  describe('removeConnection', () => {
    it('should remove connection from registry', () => {
      manager = new SSEManager();
      const reply = createMockReply();

      manager.addConnection('conn-1', reply, {});
      manager.removeConnection('conn-1');

      // Verify connection removed by broadcasting
      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event);
      expect(reply.sse.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcast', () => {
    it('should send event to all connections without filters', () => {
      manager = new SSEManager();
      const reply1 = createMockReply();
      const reply2 = createMockReply();

      manager.addConnection('conn-1', reply1, {});
      manager.addConnection('conn-2', reply2, {});

      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event);

      expect(reply1.sse.send).toHaveBeenCalledWith({
        id: '1',
        event: 'task.created',
        data: event,
      });
      expect(reply2.sse.send).toHaveBeenCalledWith({
        id: '1',
        event: 'task.created',
        data: event,
      });
    });

    it('should filter events by project_id', () => {
      manager = new SSEManager();
      const reply1 = createMockReply();
      const reply2 = createMockReply();

      manager.addConnection('conn-1', reply1, { project_id: 1 });
      manager.addConnection('conn-2', reply2, { project_id: 2 });

      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event);

      expect(reply1.sse.send).toHaveBeenCalledWith({
        id: '1',
        event: 'task.created',
        data: event,
      });
      expect(reply2.sse.send).not.toHaveBeenCalled(); // Filtered out
    });

    it('should filter events by event_types', () => {
      manager = new SSEManager();
      const reply1 = createMockReply();
      const reply2 = createMockReply();

      manager.addConnection('conn-1', reply1, { event_types: ['task.created'] });
      manager.addConnection('conn-2', reply2, { event_types: ['task.updated'] });

      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event);

      expect(reply1.sse.send).toHaveBeenCalledWith({
        id: '1',
        event: 'task.created',
        data: event,
      });
      expect(reply2.sse.send).not.toHaveBeenCalled(); // Filtered out
    });

    it('should add events to buffer for Last-Event-ID replay', () => {
      manager = new SSEManager();

      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event);

      // Verify buffer contains event by connecting with Last-Event-ID = 0
      const reply = createMockReply();
      manager.addConnection('conn-1', reply, {}, 0);

      const sentEvents = reply._getSentEvents();
      expect(sentEvents.length).toBe(1);
      expect(sentEvents[0].data).toMatchObject(event);
    });

    it('should remove connection if send fails', async () => {
      manager = new SSEManager();
      const reply = createMockReply();

      // Make sse.send reject
      reply.sse.send.mockRejectedValue(new Error('Connection closed'));

      manager.addConnection('conn-1', reply, {});

      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event);

      // Wait for promise rejection to be handled and connection to be removed
      await Promise.resolve();
      await Promise.resolve();

      // Reset mock
      reply.sse.send.mockClear();
      reply.sse.send.mockResolvedValue(undefined);

      // Try to broadcast again - connection should be removed, so send should not be called
      manager.broadcast(event);

      expect(reply.sse.send).not.toHaveBeenCalled(); // Connection was removed, no call
    });
  });

  describe('heartbeat', () => {
    it('should send ping every 30 seconds', () => {
      manager = new SSEManager();
      const reply = createMockReply();

      manager.addConnection('conn-1', reply, {});

      // Advance time by 30 seconds
      vi.advanceTimersByTime(30000);

      expect(reply.sse.send).toHaveBeenCalledWith({ event: 'ping', data: '' });
    });

    it('should remove stale connections on heartbeat failure', async () => {
      manager = new SSEManager();
      const reply = createMockReply();

      manager.addConnection('conn-1', reply, {});

      // Make heartbeat fail
      reply.sse.send.mockRejectedValueOnce(new Error('Connection closed'));

      // Advance time to trigger heartbeat
      vi.advanceTimersByTime(30000);

      // Wait for promise rejection to be handled
      await Promise.resolve();

      // Verify connection removed
      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      reply.sse.send.mockResolvedValue(undefined);

      manager.broadcast(event);

      expect(reply.sse.send).toHaveBeenCalledTimes(1); // Only the failed heartbeat call
    });

    it('should enforce max connection age', () => {
      manager = new SSEManager(1000, 5 * 60 * 1000, 30000, 10 * 60 * 1000); // 10 minute max age
      const reply = createMockReply();

      manager.addConnection('conn-1', reply, {});

      // Advance time by 10 minutes + 1 second
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000);

      // Advance to next heartbeat
      vi.advanceTimersByTime(30000);

      // Verify connection removed
      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event);
      expect(reply.sse.send).not.toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'task.created',
        }),
      );
    });
  });

  describe('buffer pruning', () => {
    it('should limit buffer to maxBufferSize', () => {
      manager = new SSEManager(5); // Max 5 events

      // Broadcast 10 events
      for (let i = 1; i <= 10; i++) {
        const event: EventPayload<unknown> = {
          eventType: 'task.created',
          timestamp: new Date().toISOString(),
          data: { id: i, title: `Event ${i}`, project_id: 1 },
          metadata: { source: 'user' },
        };
        manager.broadcast(event);
      }

      // Connect with Last-Event-ID = 0 (should only get last 5 events)
      const reply = createMockReply();
      manager.addConnection('conn-1', reply, {}, 0);

      const sentEvents = reply._getSentEvents();
      expect(sentEvents.length).toBe(5);
      expect(sentEvents[0].id).toBe('6'); // Events 6-10
      expect(sentEvents[4].id).toBe('10');
    });

    it('should remove events older than TTL', () => {
      manager = new SSEManager(1000, 60000); // 1 minute TTL

      const oldEvent: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago
        data: { id: 1, title: 'Old event', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(oldEvent);

      // Advance time by 1 second
      vi.advanceTimersByTime(1000);

      const recentEvent: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 2, title: 'Recent event', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(recentEvent);

      // Connect with Last-Event-ID = 0
      const reply = createMockReply();
      manager.addConnection('conn-1', reply, {}, 0);

      const sentEvents = reply._getSentEvents();
      expect(sentEvents.length).toBe(1); // Only recent event
      expect(sentEvents[0].id).toBe('2');
    });
  });

  describe('shutdown', () => {
    it('should clear heartbeat interval and connections', () => {
      manager = new SSEManager();
      const reply = createMockReply();

      manager.addConnection('conn-1', reply, {});
      manager.shutdown();

      // Advance time - no heartbeat should fire
      vi.advanceTimersByTime(30000);
      expect(reply.sse.send).not.toHaveBeenCalled();

      // Broadcast should not reach any connections
      const event: EventPayload<unknown> = {
        eventType: 'task.created',
        timestamp: new Date().toISOString(),
        data: { id: 1, title: 'Test', project_id: 1 },
        metadata: { source: 'user' },
      };

      manager.broadcast(event);
      expect(reply.sse.send).not.toHaveBeenCalled();
    });
  });
});
