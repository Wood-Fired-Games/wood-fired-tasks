/**
 * CLI-side TypeScript interfaces for REST API request/response shapes.
 * These are decoupled from server types to keep the CLI independent.
 */

export interface TaskResponse {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  project_id: number;
  assignee: string | null;
  created_by: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export interface ProjectResponse {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskInput {
  title: string;
  project_id: number;
  created_by: string;
  description?: string;
  priority?: string;
  assignee?: string;
  due_date?: string;
  tags?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  assignee?: string | null;
  due_date?: string | null;
  tags?: string[];
}

export interface TaskFilters {
  project_id?: number;
  status?: string;
  assignee?: string;
  search?: string;
  tags?: string;
  due_before?: string;
  due_after?: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
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
  blocks: DependencyResponse[];        // Tasks this task blocks
  blocked_by: DependencyResponse[];    // Tasks that block this task
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

// ── Health types ────────────────────────────────────────────

/**
 * Health check response (matches REST API /health response).
 */
export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  version: string;
  checks: {
    database: 'ok' | 'failed';
  };
}
