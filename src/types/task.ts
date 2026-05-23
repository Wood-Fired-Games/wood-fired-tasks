// Task status and priority enums
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'closed', 'blocked', 'backlogged'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

/**
 * Wave 1.4 (task #312): structured verification evidence stored in
 * `tasks.verification_evidence` as a JSON string. Surface-level callers see
 * the parsed object; the repository handles serialization on write and parse
 * on read. The authoritative shape lives in
 * `src/schemas/task.schema.ts#VerificationEvidenceSchema`.
 */
export interface VerificationCheck {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  evidence_url_or_text: string;
}

export interface VerificationEvidence {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'NOT_VERIFIED';
  checks?: VerificationCheck[];
  verifier_session_id?: string;
  verifier_request_id?: string;
  /** ISO8601 timestamp recorded by the verifier (not set by auto-NOT_VERIFIED). */
  verified_at?: string;
}

export type TaskStatus = typeof TASK_STATUSES[number];
export type TaskPriority = typeof TASK_PRIORITIES[number];

// Valid status transitions map
export const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['in_progress', 'blocked', 'closed', 'backlogged'],
  in_progress: ['done', 'blocked', 'open'],
  blocked: ['open', 'in_progress'],
  done: ['closed', 'open'],
  closed: ['open'],
  backlogged: ['open'],
};

// Core interfaces
export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  project_id: number;
  /**
   * Display name of the parent project, joined from `projects.name` at read
   * time. Returned by every repository SELECT that produces a Task row so
   * dashboards/CLI/MCP consumers don't have to maintain their own id→name
   * map. Renames are reflected on the next read (no denormalized copy).
   */
  project_name: string;
  parent_task_id: number | null;
  estimated_minutes: number | null;
  assignee: string | null;
  created_by: string;
  due_date: string | null; // ISO8601
  created_at: string; // ISO8601
  updated_at: string; // ISO8601
  version: number;
  claimed_at: string | null;
  completed_at: string | null; // ISO8601; set when status transitions to 'done'
  /**
   * Wave 1.3 (task #311): optional free-form acceptance criteria. Plain
   * markdown — what would prove this task is done. NULL for all rows that
   * pre-date migration 011 or for tasks the author chose not to populate.
   */
  acceptance_criteria: string | null;
  /**
   * Wave 1.4 (task #312): structured verification evidence. NULL for rows
   * that pre-date migration 012 OR tasks whose lifecycle has never crossed
   * a closing transition. Materialized as `{verdict: "NOT_VERIFIED"}` by
   * `task.service.ts updateTask` when a task transitions to done/closed
   * without explicit evidence. Stored as a JSON string in SQLite; this
   * field is the parsed object as seen by service / route / MCP / CLI.
   */
  verification_evidence: VerificationEvidence | null;
}

export interface Project {
  id: number;
  name: string;
  description: string | null;
  created_at: string; // ISO8601
  updated_at: string; // ISO8601
}

export interface TaskTag {
  id: number;
  task_id: number;
  tag: string;
}

export interface Dependency {
  id: number;
  task_id: number;
  blocks_task_id: number;
  created_at: string;
}

export interface Comment {
  id: number;
  task_id: number;
  author: string;
  content: string;
  created_at: string;
  updated_at: string | null;
}

// DTOs for create/update operations
//
// Phase 31 (Plan 31-01) added optional nullable FK fields alongside the
// existing TEXT identity columns. These ride next to the TEXT fields
// (assignee, created_by, author) and are populated by callers that have
// already resolved the displayName -> users.id mapping; legacy callers
// continue to work because every new field is optional and defaults to null.
export interface CreateTaskDTO {
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  project_id: number;
  parent_task_id?: number | null;
  estimated_minutes?: number | null;
  assignee?: string | null;
  created_by: string;
  due_date?: string | null;
  /** Phase 31: optional FK into users(id) — parallel to `created_by` TEXT. */
  created_by_user_id?: number | null;
  /** Phase 31: optional FK into users(id) — parallel to `assignee` TEXT. */
  assignee_user_id?: number | null;
  /** Wave 1.3 (#311): optional free-form acceptance criteria (markdown). */
  acceptance_criteria?: string | null;
}

export interface UpdateTaskDTO {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  parent_task_id?: number | null;
  estimated_minutes?: number | null;
  assignee?: string | null;
  due_date?: string | null;
  tags?: string[];
  /**
   * Phase 31: optional FK into users(id) — parallel to `assignee` TEXT.
   * When set (including explicitly `null` to clear), the repository writes
   * the FK column. When omitted, the FK column is untouched.
   */
  assignee_user_id?: number | null;
  /**
   * Wave 1.3 (#311): patch acceptance_criteria. `undefined` (key absent)
   * leaves the column untouched; explicit `null` clears it; a string sets it.
   */
  acceptance_criteria?: string | null;
  /**
   * Wave 1.4 (#312): patch verification_evidence. `undefined` leaves the
   * column untouched; explicit `null` clears it; an object sets it
   * (serialized to JSON by the repository).
   */
  verification_evidence?: VerificationEvidence | null;
}

export interface CreateProjectDTO {
  name: string;
  description?: string | null;
}

export interface CreateDependencyDTO {
  task_id: number;
  blocks_task_id: number;
}

export interface CreateCommentDTO {
  task_id: number;
  author: string;
  content: string;
  /** Phase 31: optional FK into users(id) — parallel to `author` TEXT. */
  author_user_id?: number | null;
}

// Task filtering interface
export interface TaskFilters {
  project_id?: number;
  status?: TaskStatus;
  assignee?: string;
  tags?: string[];
  due_before?: string; // ISO8601
  due_after?: string; // ISO8601
  updated_before?: string; // ISO8601
  updated_after?: string; // ISO8601
  search?: string;
  /**
   * Wave 1.4 (#312): verified-state filter.
   *   true  → rows where parsed verdict ∈ {PASS, PARTIAL}.
   *   false → rows where verification_evidence IS NULL OR
   *           parsed verdict ∈ {NOT_VERIFIED, FAIL}.
   *   undefined → no filter applied.
   * Implemented via json_extract on `$.verdict`.
   */
  verified?: boolean;
  /** Pagination: max rows to return. Repository default applies if omitted. */
  limit?: number;
  /** Pagination: zero-based row offset. Defaults to 0. */
  offset?: number;
}

/**
 * Generic envelope returned by every paginated list endpoint:
 *   { data, total, limit, offset }
 *
 * `total` is the unbounded match count for the same filter set — i.e. the
 * number of rows that would have been returned without `limit`/`offset`.
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Default pagination applied by services when caller omits limit/offset. */
export const DEFAULT_PAGE_LIMIT = 50;
export const DEFAULT_PAGE_OFFSET = 0;
export const MAX_PAGE_LIMIT = 500;
