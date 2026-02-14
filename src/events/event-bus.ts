import { EventEmitter } from 'events';
import { TaskEvent, ProjectEvent } from './types.js';

/**
 * Type-safe EventBus using native Node.js EventEmitter with TypeScript generics
 *
 * Provides pub/sub for domain events with compile-time type safety.
 * Each event type is mapped to its payload type via the Events generic parameter.
 *
 * Error handling: Subscriber errors are caught and logged to prevent one subscriber
 * from crashing the EventBus or blocking other subscribers.
 */
export class EventBus<Events extends Record<string, unknown>> {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
  }

  /**
   * Emit an event to all subscribers
   *
   * @param event - The event name (must be a key in Events type)
   * @param payload - The event payload (type enforced by Events[event])
   */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.emitter.emit(event as string, payload);
  }

  /**
   * Subscribe to an event
   *
   * @param event - The event name to subscribe to
   * @param handler - Callback invoked when event is emitted
   * @returns Cleanup function to unsubscribe
   */
  subscribe<K extends keyof Events>(
    event: K,
    handler: (payload: Events[K]) => void
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

    this.emitter.on(event as string, wrappedHandler);

    // Return cleanup function for unsubscribe
    return () => {
      this.emitter.off(event as string, wrappedHandler);
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
