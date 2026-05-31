import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventBus } from '../event-bus.js';
import { subscribeOnce, TimeoutError, AbortError } from '../subscribe-once.js';
import { TaskEvent } from '../types.js';

type TestEvents = {
  'task.created': TaskEvent;
  'task.updated': TaskEvent;
};

function makeEvent(id: number, title = 'Task'): TaskEvent {
  return {
    eventType: 'task.created',
    timestamp: new Date().toISOString(),
    data: {
      id,
      title,
      description: null,
      status: 'open',
      priority: 'medium',
      project_id: 1,
      parent_task_id: null,
      estimated_minutes: null,
      assignee: null,
      created_by: 'user1',
      due_date: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      version: 1,
      claimed_at: null,
      completed_at: null,
      tags: [],
    },
    metadata: { source: 'user' },
  };
}

describe('subscribeOnce', () => {
  let bus: EventBus<TestEvents>;

  beforeEach(() => {
    bus = new EventBus<TestEvents>();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the first event matching the predicate', async () => {
    const before = bus.getStats().listenerCount;
    const promise = subscribeOnce(
      bus,
      'task.created',
      (e) => e.data.id === 42,
      { timeoutMs: 1000 }
    );

    // Non-matching event should be ignored.
    bus.emit('task.created', makeEvent(1));
    // Matching event resolves.
    bus.emit('task.created', makeEvent(42, 'Target'));

    const result = await promise;
    expect(result.data.id).toBe(42);
    expect(result.data.title).toBe('Target');
    // No leak.
    expect(bus.getStats().listenerCount).toBe(before);
  });

  it('rejects with TimeoutError after timeoutMs and removes the listener', async () => {
    const before = bus.getStats().listenerCount;
    const promise = subscribeOnce(bus, 'task.created', () => true, {
      timeoutMs: 500,
    });

    // Subscribed while pending.
    expect(bus.getStats().listenerCount).toBe(before + 1);

    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    expect(bus.getStats().listenerCount).toBe(before);
  });

  it('rejects with AbortError when the signal aborts and removes the listener', async () => {
    const controller = new AbortController();
    const before = bus.getStats().listenerCount;
    const promise = subscribeOnce(bus, 'task.created', () => true, {
      timeoutMs: 5000,
      signal: controller.signal,
    });

    expect(bus.getStats().listenerCount).toBe(before + 1);

    const assertion = expect(promise).rejects.toBeInstanceOf(AbortError);
    controller.abort();
    await assertion;

    expect(bus.getStats().listenerCount).toBe(before);
  });

  it('rejects immediately with AbortError if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const before = bus.getStats().listenerCount;

    const promise = subscribeOnce(bus, 'task.created', () => true, {
      timeoutMs: 5000,
      signal: controller.signal,
    });

    await expect(promise).rejects.toBeInstanceOf(AbortError);
    // Never subscribed.
    expect(bus.getStats().listenerCount).toBe(before);
  });

  it('does not leak the timer after resolving (no late rejection)', async () => {
    const promise = subscribeOnce(bus, 'task.created', () => true, {
      timeoutMs: 1000,
    });
    bus.emit('task.created', makeEvent(7));
    await expect(promise).resolves.toBeDefined();

    // Advancing past the deadline must not throw an unhandled rejection.
    await vi.advanceTimersByTimeAsync(2000);
  });

  it('clears the timer on abort (no later TimeoutError)', async () => {
    const controller = new AbortController();
    const promise = subscribeOnce(bus, 'task.created', () => true, {
      timeoutMs: 1000,
      signal: controller.signal,
    });

    const assertion = expect(promise).rejects.toBeInstanceOf(AbortError);
    controller.abort();
    await assertion;

    // No pending timer should fire after abort.
    await vi.advanceTimersByTimeAsync(2000);
  });

  it('ignores events after the predicate has already matched (single settle)', async () => {
    const before = bus.getStats().listenerCount;
    const promise = subscribeOnce(bus, 'task.created', () => true, {
      timeoutMs: 1000,
    });

    bus.emit('task.created', makeEvent(1));
    bus.emit('task.created', makeEvent(2));

    const result = await promise;
    expect(result.data.id).toBe(1);
    expect(bus.getStats().listenerCount).toBe(before);
  });
});
