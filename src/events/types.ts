import { Task, Project, TaskStatus } from '../types/task.js';

/**
 * Event types for task lifecycle
 * Note: task.claimed is defined for type safety but emission deferred to Phase 15 (atomic claim endpoint)
 */
export type TaskEventType =
  | 'task.created'
  | 'task.updated'
  | 'task.deleted'
  | 'task.status_changed'
  | 'task.claimed' // Defined but not emitted in Phase 14
  | 'task.claim_released'; // Task #1003: TTL sweep released a stale claim

/**
 * Event types for project lifecycle
 */
export type ProjectEventType = 'project.created' | 'project.updated' | 'project.deleted';

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
  'task.claim_released',
  'project.created',
  'project.updated',
  'project.deleted',
] as const satisfies readonly (TaskEventType | ProjectEventType)[];

export type AllowedEventType = (typeof ALLOWED_EVENT_TYPES)[number];

export function isAllowedEventType(value: string): value is AllowedEventType {
  return (ALLOWED_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Origin of an emitted event — `user`-initiated or driven by the
 * {@link ../services/workflow-engine WorkflowEngine} cascade.
 */
export type EventSource = 'user' | 'workflow';

/**
 * Event metadata. `source` and `actor` apply to every event; `from`/`to`
 * are populated ONLY for `task.status_changed` events to record the status
 * transition (e.g. `blocked` → `open`). They are typed as optional here so a
 * single `EventPayload.metadata` shape covers all event types without an
 * unsafe cast at the emit site or at consumers (SSE filter, wait-for-unblock
 * predicate, workflow-engine tests).
 */
export interface EventMetadata {
  source: EventSource;
  actor?: string;
  /** Previous status — present on `task.status_changed` events. */
  from?: TaskStatus;
  /** New status — present on `task.status_changed` events. */
  to?: TaskStatus;
}

/**
 * Generic event payload structure
 */
export interface EventPayload<T> {
  eventType: string;
  timestamp: string; // ISO 8601
  data: T;
  metadata: EventMetadata;
}

/**
 * Task event with tags included
 */
export type TaskEvent = EventPayload<Task & { tags: string[] }>;

/**
 * Task #1003: payload for `task.claim_released` — emitted by the
 * ClaimReleaseService TTL sweep when a stale `in_progress` claim is
 * auto-released back to `open`. Carries the full (post-release) task plus
 * the claim's forensic trail so the former holder (and wft-router rules)
 * can react: who held it, when the expired claim was taken, and when the
 * sweep released it.
 */
export type ClaimReleasedEvent = EventPayload<
  Task & {
    tags: string[];
    /** Assignee that held the claim before the TTL sweep released it. */
    previous_assignee: string;
    /** The `claimed_at` timestamp that exceeded the TTL (pre-release value). */
    expired_claimed_at: string;
    /** When the sweep released the claim (ISO 8601). */
    released_at: string;
  }
>;

/**
 * Project event
 */
export type ProjectEvent = EventPayload<Project>;

/**
 * The typed status transition carried by a `task.status_changed` event.
 * Both ends are guaranteed present once {@link getStatusTransition} confirms
 * the event is a status change.
 */
export interface StatusTransition {
  from: TaskStatus;
  to: TaskStatus;
}

/**
 * Typed accessor for the `from`/`to` status transition on an event payload.
 *
 * Returns the transition when the event is a `task.status_changed` whose
 * metadata carries both ends, otherwise `undefined`. Lets consumers and tests
 * read the transition without an unsafe `event.metadata` cast.
 */
export function getStatusTransition(event: EventPayload<unknown>): StatusTransition | undefined {
  const { from, to } = event.metadata;
  if (from !== undefined && to !== undefined) {
    return { from, to };
  }
  return undefined;
}

/**
 * Narrow event payload `data` to the subset SSE filtering cares about: a
 * `project_id` for project-scoped filtering. Task and project event payloads
 * both expose `project_id`, but `EventPayload<unknown>` hides it — this typed
 * guard reads it without the unsafe `event.data` cast that previously lived
 * in {@link ../events/sse-manager SSEManager.matchesFilters}.
 */
export function getEventProjectId(event: EventPayload<unknown>): number | undefined {
  const data = event.data;
  if (typeof data === 'object' && data !== null && 'project_id' in data) {
    const projectId = (data as { project_id?: unknown }).project_id;
    return typeof projectId === 'number' ? projectId : undefined;
  }
  return undefined;
}
