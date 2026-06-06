import { EventEmitter } from 'events';
import { TaskEvent, ProjectEvent } from './types.js';

/**
 * Options for {@link EventBus.subscribe}.
 *
 * `ignoreTransaction`: when true, the handler is invoked immediately on emit
 * even while a transactional buffer is active (see {@link EventBus.runInTransaction}).
 * Use this for handlers that drive control flow inside the transaction itself
 * (e.g. WorkflowEngine cascade recursion) and therefore cannot wait for commit.
 * All other subscribers (SSE relay, Slack notifier, MCP event mirror, etc.)
 * should leave this flag at its default (`false`) so they only see committed
 * events.
 */
export interface SubscribeOptions {
  ignoreTransaction?: boolean;
}

/**
 * Type-safe EventBus using native Node.js EventEmitter with TypeScript generics
 *
 * Provides pub/sub for domain events with compile-time type safety.
 * Each event type is mapped to its payload type via the Events generic parameter.
 *
 * Error handling: Subscriber errors are caught and logged to prevent one subscriber
 * from crashing the EventBus or blocking other subscribers.
 *
 * Transactional buffering: {@link runInTransaction} captures every emit fired
 * during the wrapped function into a per-call buffer. On successful return the
 * buffer is flushed to all normal subscribers; on throw the buffer is
 * discarded. Subscribers registered with `ignoreTransaction: true` bypass the
 * buffer and fire synchronously on emit (needed so the WorkflowEngine can
 * drive cascade recursion inside the transaction).
 */
export class EventBus<Events extends Record<string, unknown>> {
  private emitter: EventEmitter;
  // Stack of buffers — supports nested runInTransaction calls. Each entry
  // collects events emitted while that transaction is active. Only the
  // OUTERMOST transaction flushes events to subscribers on commit; inner
  // (nested) transactions merge their buffer up to their parent so the whole
  // chain commits or rolls back atomically with the outer scope.
  private bufferStack: Array<Array<{ event: string; payload: unknown }>> = [];
  // Per-handler bypass flag tracked outside the EventEmitter so we can route
  // around the buffer for handlers that opted into immediate delivery.
  private bypassHandlers: WeakSet<(...args: unknown[]) => void> = new WeakSet();

  constructor() {
    this.emitter = new EventEmitter();
  }

  /**
   * Emit an event to all subscribers.
   *
   * If a transaction is active (see {@link runInTransaction}), the event is
   * appended to the active buffer instead of dispatched to normal subscribers —
   * subscribers that registered with `ignoreTransaction: true` still receive
   * the event immediately so they can drive in-transaction control flow.
   *
   * @param event - The event name (must be a key in Events type)
   * @param payload - The event payload (type enforced by Events[event])
   */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    if (this.bufferStack.length > 0) {
      // Dispatch ONLY to bypass handlers synchronously; everyone else gets
      // queued into the active buffer for post-commit flush.
      const eventName = event as string;
      for (const listener of this.emitter.listeners(eventName)) {
        if (this.bypassHandlers.has(listener as (...args: unknown[]) => void)) {
          try {
            (listener as (p: unknown) => void)(payload);
          } catch (error) {
            console.error(`Error in bypass event handler for ${String(event)}:`, error);
          }
        }
      }
      // length > 0 guarded above, so the top-of-stack buffer is present.
      const activeBuffer = this.bufferStack[this.bufferStack.length - 1];
      if (activeBuffer === undefined) throw new Error('event-bus: active buffer missing');
      activeBuffer.push({
        event: eventName,
        payload,
      });
      return;
    }
    this.emitter.emit(event as string, payload);
  }

  /**
   * Run `fn` with a transactional emit buffer active. Events emitted inside
   * `fn` are queued and only delivered to non-bypass subscribers if `fn`
   * returns normally. If `fn` throws, the buffer is discarded — no phantom
   * events leak to SSE/Slack/MCP for work that the database did not commit.
   *
   * Nested transactions merge their buffer into the parent buffer on commit,
   * so the outermost {@link runInTransaction} call is the only one that
   * actually delivers events. This matches better-sqlite3's nested-transaction
   * (savepoint) semantics.
   *
   * @returns whatever `fn` returns
   */
  runInTransaction<T>(fn: () => T): T {
    const buffer: Array<{ event: string; payload: unknown }> = [];
    this.bufferStack.push(buffer);
    let threw = false;
    try {
      return fn();
    } catch (error) {
      threw = true;
      throw error;
    } finally {
      // Pop our buffer off the stack regardless of outcome.
      const popped = this.bufferStack.pop();
      if (!threw && popped) {
        if (this.bufferStack.length > 0) {
          // Nested transaction committing — defer to the parent's buffer.
          // length > 0 guarded above, so the parent buffer is present.
          const parent = this.bufferStack[this.bufferStack.length - 1];
          if (parent === undefined) throw new Error('event-bus: parent buffer missing');
          for (const entry of popped) parent.push(entry);
        } else {
          // Outermost transaction committing — flush to live subscribers
          // EXCLUDING bypass handlers (they already received each event
          // synchronously during emit, so re-delivering here would double-fire
          // them. For the WorkflowEngine the second delivery happens after
          // cascadeDepth has reset to 0, retriggering an unbounded cascade
          // that bypasses the depth guard — exactly the bug the
          // workflow-engine.test.ts "cascade depth limit" case guards).
          for (const entry of popped) {
            for (const listener of this.emitter.listeners(entry.event)) {
              if (this.bypassHandlers.has(listener as (...args: unknown[]) => void)) {
                continue;
              }
              try {
                (listener as (p: unknown) => void)(entry.payload);
              } catch (error) {
                console.error(
                  `Error in event handler during transaction flush for ${entry.event}:`,
                  error,
                );
              }
            }
          }
        }
      }
      // If `threw`, popped buffer is intentionally dropped on the floor.
    }
  }

  /**
   * Subscribe to an event
   *
   * @param event - The event name to subscribe to
   * @param handler - Callback invoked when event is emitted
   * @param options - Optional subscription options. See {@link SubscribeOptions}.
   * @returns Cleanup function to unsubscribe
   */
  subscribe<K extends keyof Events>(
    event: K,
    handler: (payload: Events[K]) => void,
    options?: SubscribeOptions,
  ): () => void {
    // Wrap handler in try/catch to prevent subscriber errors from crashing EventBus
    const wrappedHandler = (payload: Events[K]) => {
      try {
        handler(payload);
      } catch (error) {
        // Log error but don't rethrow - other subscribers should still execute
        console.error(`Error in event handler for ${String(event)}:`, error);
      }
    };

    if (options?.ignoreTransaction) {
      this.bypassHandlers.add(wrappedHandler as (...args: unknown[]) => void);
    }

    this.emitter.on(event as string, wrappedHandler);

    // Return cleanup function for unsubscribe
    return () => {
      this.emitter.off(event as string, wrappedHandler);
      if (options?.ignoreTransaction) {
        this.bypassHandlers.delete(wrappedHandler as (...args: unknown[]) => void);
      }
    };
  }

  /**
   * Check if event bus is active (has listeners)
   */
  isActive(): boolean {
    // EventBus is always active if instantiated
    return true;
  }

  /**
   * Get event bus statistics
   */
  getStats(): { listenerCount: number } {
    return {
      listenerCount:
        this.emitter.listenerCount('task.created') +
        this.emitter.listenerCount('task.updated') +
        this.emitter.listenerCount('task.deleted') +
        this.emitter.listenerCount('task.status_changed') +
        this.emitter.listenerCount('task.claimed') +
        this.emitter.listenerCount('project.created') +
        this.emitter.listenerCount('project.updated') +
        this.emitter.listenerCount('project.deleted'),
    };
  }
}

/**
 * Application event types mapped to their payloads
 * Note: task.claimed defined for type safety but emission deferred to Phase 15
 */
type AppEvents = {
  'task.created': TaskEvent;
  'task.updated': TaskEvent;
  'task.deleted': TaskEvent;
  'task.status_changed': TaskEvent;
  'task.claimed': TaskEvent;
  'project.created': ProjectEvent;
  'project.updated': ProjectEvent;
  'project.deleted': ProjectEvent;
};

/**
 * Singleton EventBus instance for application-wide event pub/sub
 */
export const eventBus = new EventBus<AppEvents>();
