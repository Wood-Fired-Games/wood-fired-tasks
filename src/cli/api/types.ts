/**
 * CLI-side TypeScript interfaces for REST API request/response shapes.
 *
 * `TaskResponse` is derived from the server's Zod `TaskResponseSchema` (the
 * single source of truth) via `z.infer<>`. This guarantees the CLI type stays
 * aligned with the wire format whenever the server schema changes — no manual
 * sync required. Add new task response fields to the Zod schema in
 * `src/api/routes/tasks/schemas.ts` and the CLI picks them up automatically.
 *
 * Other request/response shapes (inputs, filters, pagination envelopes) remain
 * hand-written here because they are CLI-only concerns or shared client
 * scaffolding rather than server response payloads.
 */

import type { z } from 'zod';
import type { TaskResponseSchema } from '../../api/routes/tasks/schemas.js';
import type { ProjectResponseSchema } from '../../api/routes/projects/schemas.js';
import type { ValueCharter } from '../../types/task.js';
import type { ModelPolicy } from '../../schemas/model-policy.schema.js';

/**
 * Task response shape, inferred from the server Zod schema.
 *
 * Fields: id, title, description, status, priority, project_id,
 * parent_task_id, estimated_minutes, assignee, created_by, due_date,
 * created_at, updated_at, version, claimed_at, tags.
 */
export type TaskResponse = z.infer<typeof TaskResponseSchema>;

/**
 * Project response shape, inferred from the server Zod schema (the single
 * source of truth) so the CLI/remote-proxy type tracks the wire format — incl.
 * the WSJF `value_charter` — without manual sync. Mirrors how `TaskResponse`
 * is derived above.
 */
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export interface CreateTaskInput {
  title: string;
  project_id: number;
  created_by: string;
  description?: string;
  priority?: string;
  assignee?: string;
  due_date?: string;
  tags?: string[];
  /** Wave 1.3 (#311): optional plain-text acceptance criteria (markdown). */
  acceptance_criteria?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  assignee?: string | null;
  due_date?: string | null;
  tags?: string[];
  /** Wave 1.3 (#311): patch acceptance criteria; null clears, string sets. */
  acceptance_criteria?: string | null;
}

export interface TaskFilters {
  project_id?: number;
  status?: string;
  assignee?: string;
  search?: string;
  tags?: string;
  due_before?: string;
  due_after?: string;
  updated_before?: string;
  updated_after?: string;
  /** Page size; max 500. Server defaults to 50 if omitted. */
  limit?: number;
  /** Zero-based offset; server defaults to 0 if omitted. */
  offset?: number;
}

/**
 * Paginated envelope returned by every list endpoint.
 * Shape: `{ data, total, limit, offset }`.
 *
 * The CLI gracefully accepts BOTH the envelope and a bare array (legacy
 * server). See `unwrapPage` in client.ts.
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  /** WSJF (Phase 3.1): optional value charter; `null` clears, absent leaves untouched. */
  value_charter?: ValueCharter | null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  /** WSJF (Phase 3.1): patch the value charter; `null` clears, absent leaves untouched. */
  value_charter?: ValueCharter | null;
  /**
   * Configurable Task Models (Task 12): patch the per-project model policy;
   * `null` clears, absent leaves untouched. The server merges this into the
   * stored `model_policy` column via `PUT /projects/:id`.
   */
  model_policy?: ModelPolicy | null;
}

export interface ApiErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}

// ── Claim types ─────────────────────────────────────────────
// ClaimTask response is TaskResponse (claimed task with updated assignee/status)

// ── Dependency types ────────────────────────────────────────

/**
 * Dependency relationship response (matches REST API response).
 */
export interface DependencyResponse {
  id: number;
  task_id: number;
  blocks_task_id: number;
  created_at: string;
}

/**
 * Dependency list response with both directions.
 */
export interface DependencyListResponse {
  blocks: DependencyResponse[]; // Tasks this task blocks
  blocked_by: DependencyResponse[]; // Tasks that block this task
}

/**
 * Input for creating a dependency relationship.
 */
export interface CreateDependencyInput {
  blocks_task_id: number;
}

// ── Comment types ───────────────────────────────────────────

/**
 * Comment response (matches REST API response).
 */
export interface CommentResponse {
  id: number;
  task_id: number;
  author: string;
  content: string;
  created_at: string;
}

/**
 * Input for creating a comment on a task.
 */
export interface CreateCommentInput {
  author: string;
  content: string;
}

// ── Completion report types ─────────────────────────────────

/**
 * Input filters for `GET /api/v1/tasks/completion-report`. Caller must supply
 * EITHER `days` OR both `start` and `end`. Mirrors the in-process
 * CompletionReportInput in services/task.service.ts.
 */
export interface CompletionReportInput {
  days?: number;
  start?: string;
  end?: string;
  project_id?: number;
  assignee?: string;
}

export interface CompletionReportRow {
  id: number;
  title: string;
  project_id: number;
  project_name: string;
  assignee: string | null;
  priority: string;
  created_at: string;
  completed_at: string;
  time_to_complete_seconds: number;
}

export interface CompletionReportResponse {
  range: { start: string; end: string };
  total: number;
  rows: CompletionReportRow[];
  by_project: Array<{ project_id: number; count: number }>;
  by_assignee: Array<{ assignee: string; count: number }>;
  by_priority: Array<{ priority: string; count: number }>;
  daily_throughput: Array<{ date: string; count: number }>;
}

// ── Health types ────────────────────────────────────────────

/**
 * Health check response (matches REST API /health response).
 */
export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  version: string;
  /**
   * Present on the authenticated /health/detailed response. The basic /health
   * (what `checkHealth()` calls) returns only status/timestamp/version, so this
   * is optional — readers MUST guard `checks?.database` (#790).
   */
  checks?: {
    database: 'ok' | 'failed';
  };
  /**
   * Present on the authenticated /health/detailed response: which DB file the
   * service opened plus a cheap fingerprint, so a wrong/stale DB is obvious.
   */
  database?: {
    path: string;
    projects: number;
    maxTaskId: number | null;
    latestActivity: string | null;
  };
}
