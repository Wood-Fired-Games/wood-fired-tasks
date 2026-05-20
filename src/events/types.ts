import { Task, Project } from '../types/task.js';

/**
 * Event types for task lifecycle
 * Note: task.claimed is defined for type safety but emission deferred to Phase 15 (atomic claim endpoint)
 */
export type TaskEventType =
  | 'task.created'
  | 'task.updated'
  | 'task.deleted'
  | 'task.status_changed'
  | 'task.claimed'; // Defined but not emitted in Phase 14

/**
 * Event types for project lifecycle
 */
export type ProjectEventType =
  | 'project.created'
  | 'project.updated'
  | 'project.deleted';

/**
 * Runtime allowlist of every event type that the system actually emits.
 * Used by subscriber-facing surfaces (e.g. the Slack /tasks subscribe command)
 * to reject arbitrary user-supplied strings before they reach persistence.
 *
 * Keep this in sync with the union types above and with the eventBus.subscribe
 * calls in `src/api/server.ts`.
 */
export const ALLOWED_EVENT_TYPES = [
  'task.created',
  'task.updated',
  'task.deleted',
  'task.status_changed',
  'task.claimed',
  'project.created',
  'project.updated',
  'project.deleted',
] as const satisfies readonly (TaskEventType | ProjectEventType)[];

export type AllowedEventType = (typeof ALLOWED_EVENT_TYPES)[number];

export function isAllowedEventType(value: string): value is AllowedEventType {
  return (ALLOWED_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Generic event payload structure
 */
export interface EventPayload<T> {
  eventType: string;
  timestamp: string; // ISO 8601
  data: T;
  metadata: {
    source: 'user' | 'workflow';
    actor?: string;
  };
}

/**
 * Task event with tags included
 */
export type TaskEvent = EventPayload<Task & { tags: string[] }>;

/**
 * Project event
 */
export type ProjectEvent = EventPayload<Project>;
