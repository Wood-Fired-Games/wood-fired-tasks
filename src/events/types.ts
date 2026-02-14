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
