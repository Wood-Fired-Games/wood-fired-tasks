import type {
  WsjfEvidence,
  WsjfLocks,
  WsjfSource,
  WsjfClassification,
  WsjfFeatures,
} from './wsjf.js';
// Type-only import (erased at compile time — no runtime module cycle): the
// `WsjfHistoryTrigger` union is owned by the append-only history repository,
// which is the single source of truth for the closed trigger set.
import type { WsjfHistoryTrigger } from '../repositories/wsjf-history.repository.js';
// Configurable Task Models: the `ModelPolicy` shape is owned by the Zod
// contract in `src/schemas/model-policy.schema.ts`. Import it for the field
// types below and re-export so consumers of `task.ts` see one parsed shape.
import type { ModelPolicy } from '../schemas/model-policy.schema.js';
export type { ModelPolicy, ModelRef } from '../schemas/model-policy.schema.js';

// Task status and priority enums
export const TASK_STATUSES = [
  'open',
  'in_progress',
  'done',
  'closed',
  'blocked',
  'backlogged',
] as const;
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

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

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
  /**
   * WSJF (task #627): the four server-computed component scores. Each is a
   * Fibonacci tier ({@link Fib}) or NULL. All four are NULL together for
   * unscored tasks (rows that pre-date migration 013 OR were never scored) —
   * the all-four-or-none rule is enforced at the schema boundary on write.
   * Stored as the INTEGER columns
   * `wsjf_value / wsjf_time_criticality / wsjf_risk_opportunity / wsjf_job_size`.
   */
  wsjf_value: Fib | null;
  wsjf_time_criticality: Fib | null;
  wsjf_risk_opportunity: Fib | null;
  wsjf_job_size: Fib | null;
  /**
   * WSJF (task #627): structured JSON metadata describing how the score was
   * derived. Stored as TEXT JSON columns; the repository serializes on write
   * and parses on read (the `inflateVerificationEvidence` pattern), so these
   * fields are the parsed objects as seen by service / route / MCP / CLI.
   * NULL for unscored rows.
   *
   *  - `wsjf_evidence`        — verbatim source spans, one per component.
   *  - `wsjf_locked`          — per-component lock flags (survive a rescore).
   *  - `wsjf_source`          — per-component provenance (`auto` | `manual`).
   *  - `wsjf_classifications` — the raw LLM classification(s) backing the score.
   *  - `wsjf_features`        — the deterministic features the server gathered.
   */
  wsjf_evidence: WsjfEvidence | null;
  wsjf_locked: WsjfLocks | null;
  wsjf_source: WsjfSource | null;
  wsjf_classifications: WsjfClassification | null;
  wsjf_features: WsjfFeatures | null;
}

/**
 * WSJF (task #627): read-only derived view of a task's WSJF standing. These
 * fields are NEVER stored — they are computed at read time by the ranking
 * service ({@link rankFrontier}). `wsjf_score` is the base WSJF
 * `(value + timeCriticality + riskOpportunity) / max(jobSize, 1)`;
 * `effective_wsjf` folds in dependency-propagation (γ-decayed, capped).
 * Both are absent (undefined) for unscored tasks and on any read that does
 * not pass through the ranking pipeline.
 */
export interface TaskWithWsjfScore extends Task {
  readonly wsjf_score?: number;
  readonly effective_wsjf?: number;
}

/**
 * WSJF (Phase 3.1): the modified Fibonacci scale used for every WSJF
 * component and for value-theme weights. The authoritative Zod validator
 * lives in `src/schemas/project.schema.ts#FibSchema`.
 */
export const FIB = [1, 2, 3, 5, 8, 13] as const;
export type Fib = (typeof FIB)[number];

/**
 * WSJF (Phase 3.1): one ranked value theme within a project's charter. The
 * theme `weight` must be a Fibonacci tier (see {@link Fib}); the validator
 * `ValueCharterSchema` rejects non-Fibonacci weights at the boundary.
 */
export interface ValueTheme {
  name: string;
  weight: Fib;
  description: string;
}

/**
 * WSJF (Phase 3.1): per-project "value charter" — the autonomous reference
 * frame used to score User-Business Value. Stored as a JSON string in
 * `projects.value_charter` (migration 014); the repository serializes on
 * write and parses on read, so service / route / MCP / CLI callers see this
 * parsed shape. NULL for projects that pre-date migration 014 or have not
 * run the project interview. The authoritative validator is
 * `src/schemas/project.schema.ts#ValueCharterSchema`.
 */
export interface ValueCharter {
  mission: string;
  value_themes: ValueTheme[];
  time_context: string;
  risk_posture: string;
  out_of_scope: string[];
  interview_version: number;
  /** ISO8601 timestamp the charter was last written by the interview flow. */
  updated_at: string;
}

export interface Project {
  id: number;
  name: string;
  description: string | null;
  created_at: string; // ISO8601
  updated_at: string; // ISO8601
  /**
   * WSJF (Phase 3.1): the project's value charter. NULL for rows that
   * pre-date migration 014 OR projects that never ran the value interview.
   * Stored as a JSON string in SQLite; this field is the parsed object as
   * seen by service / route / MCP / CLI consumers.
   */
  value_charter: ValueCharter | null;
  /**
   * Configurable Task Models: the project's model routing policy. NULL when
   * no per-project policy is configured (the global
   * `app_settings.model_policy_default` applies instead). Stored as a JSON
   * string in SQLite (alongside `value_charter`); this field is the parsed
   * object as seen by service / route / MCP / CLI consumers. The
   * authoritative validator is `src/schemas/model-policy.schema.ts`.
   */
  model_policy: ModelPolicy | null;
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
/**
 * WSJF (task #627): the full WSJF write payload carried on create/update DTOs.
 * The four component scores plus the structured JSON metadata. Either all four
 * components are present (a fully-scored task) or the whole `wsjf` object is
 * omitted — the all-four-or-none rule is enforced at the schema boundary.
 * The repository serializes the JSON members on write.
 */
export interface WsjfWriteDTO {
  value: Fib;
  timeCriticality: Fib;
  riskOpportunity: Fib;
  jobSize: Fib;
  evidence?: WsjfEvidence | null;
  locked?: WsjfLocks | null;
  source?: WsjfSource | null;
  classifications?: WsjfClassification | null;
  features?: WsjfFeatures | null;
  /**
   * WSJF (#643): when `true`, this is a MANUAL override — a human set the four
   * components directly. The service runs the manual gate
   * ({@link validateManualScore}: enum + contradiction, NO classification /
   * evidence requirement) and audits the write with history `trigger='manual'`.
   * When `false`/absent the write is treated as the auto/classified path
   * (history `trigger='create'|'update'`). This flag is NOT persisted on its
   * own — provenance lives in the per-component `source` map and the history
   * row's `trigger`.
   */
  manual?: boolean;
  /**
   * WSJF (#634): optional GENERIC history-trigger hint for the auto/classified
   * write path. When set on a create that carries a score (and is NOT a manual
   * override) it overrides the default `'create'` trigger stamped on the
   * `wsjf_score_history` row — e.g. the `create_task` MCP tool passes
   * `'single_create'`, and `decompose` (#633) passes `'decompose'`. Ignored on
   * the manual path (`manual === true` always stamps `'manual'`). When unset the
   * create path keeps `'create'` and the update path keeps `'update'`. Kept as
   * the full {@link WsjfHistoryTrigger} union so new callers need no further
   * service-layer change.
   */
  trigger?: WsjfHistoryTrigger;
}

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
  /**
   * WSJF (#627): optional WSJF score to persist on create. `undefined`/absent
   * leaves every wsjf_* column NULL (unscored task). When present, all four
   * components are written and the JSON metadata is serialized.
   */
  wsjf?: WsjfWriteDTO | null;
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
  /**
   * WSJF (#627): patch the WSJF score. `undefined` (key absent) leaves every
   * wsjf_* column untouched; explicit `null` clears all of them (back to
   * unscored); a {@link WsjfWriteDTO} object sets all four components and
   * serializes the JSON metadata. All-four-or-none is enforced at the schema
   * boundary.
   */
  wsjf?: WsjfWriteDTO | null;
}

export interface CreateProjectDTO {
  name: string;
  description?: string | null;
  /**
   * WSJF (Phase 3.1): optional value charter. `undefined`/absent persists
   * NULL; an object is serialized to JSON by the repository. On update,
   * explicit `null` clears it; `undefined` leaves the column untouched.
   */
  value_charter?: ValueCharter | null;
  /**
   * Configurable Task Models: optional per-project model policy.
   * `undefined`/absent persists NULL; an object is serialized to JSON by the
   * repository. On update, explicit `null` clears it; `undefined` leaves the
   * column untouched. Mirrors `value_charter` wiring.
   */
  model_policy?: ModelPolicy | null;
}

export interface UpdateProjectDTO {
  name?: string;
  description?: string | null;
  /**
   * WSJF (Phase 3.1): patch the value charter. `undefined` (key absent)
   * leaves the column untouched; explicit `null` clears it; an object sets it
   * (serialized to JSON by the repository).
   */
  value_charter?: ValueCharter | null;
  /**
   * Configurable Task Models: patch the per-project model policy. `undefined`
   * (key absent) leaves the column untouched; explicit `null` clears it; an
   * object sets it (serialized to JSON by the repository). Mirrors
   * `value_charter` wiring.
   */
  model_policy?: ModelPolicy | null;
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
  /**
   * Skip the `task_tags` LEFT JOIN + GROUP BY when the caller does not need
   * tags. Default `true` for backward compat with existing list endpoints.
   * Callers that only walk the graph structure (e.g. DependencyGraphService)
   * can pass `false` to drop the join and the per-row tag splitting; the
   * returned rows still carry a `tags: []` placeholder so the shape stays
   * `Task & { tags: string[] }` for type-erasure callers.
   */
  include_tags?: boolean;
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
