import { env } from '../config/env.js';
import { withSpinner } from '../output/spinner.js';
import { resolveAuth } from '../auth/credentials.js';
import { NotAuthenticatedError } from './errors.js';
import {
  parseTaskResponse,
  parseProjectResponse,
  parseTaskListResponse,
  parseProjectListResponse,
} from '../../schemas/api-response.js';
import type {
  TaskResponse,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilters,
  ApiErrorResponse,
  ProjectResponse,
  CreateProjectInput,
  UpdateProjectInput,
  DependencyResponse,
  DependencyListResponse,
  CreateDependencyInput,
  CommentResponse,
  CreateCommentInput,
  HealthResponse,
  PaginatedResponse,
  PaginationParams,
} from './types.js';

/**
 * Accept either the new pagination envelope `{ data, total, limit, offset }`
 * or a bare array (older servers that pre-date pagination), and normalize
 * to a plain `T[]`. CLI list commands operate on arrays for terminal
 * rendering — `total` is consulted separately for the JSON envelope.
 *
 * NOTE (task #774): task / project / subtask lists no longer use this loose
 * normalizer — they go through `parseTaskListResponse` /
 * `parseProjectListResponse`, which schema-validate every row. This helper now
 * serves ONLY the deliberately-deferred comment list paths (see the comment
 * section below). Its silent "unexpected shape → []" fallback is retained for
 * those paths' backward compatibility.
 */
function unwrapPage<T>(payload: PaginatedResponse<T> | T[]): T[] {
  if (Array.isArray(payload)) return payload;
  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as PaginatedResponse<T>).data)
  ) {
    return (payload as PaginatedResponse<T>).data;
  }
  // Unexpected shape: behave as empty rather than crashing the CLI.
  return [];
}

/**
 * Normalize either an envelope OR a bare array into a synthetic envelope.
 * Older servers that return bare arrays still work — `total` falls back to
 * `data.length` and pagination knobs default to sensible values.
 */
function asPage<T>(payload: PaginatedResponse<T> | T[]): PaginatedResponse<T> {
  if (Array.isArray(payload)) {
    return { data: payload, total: payload.length, limit: payload.length, offset: 0 };
  }
  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as PaginatedResponse<T>).data)
  ) {
    return payload as PaginatedResponse<T>;
  }
  return { data: [], total: 0, limit: 0, offset: 0 };
}

/**
 * Custom error class for API client errors.
 * Includes HTTP status code, parsed API error response, and optional request ID for tracing.
 */
export class ApiClientError extends Error {
  public requestId?: string;
  constructor(
    message: string,
    public statusCode: number,
    public apiError: ApiErrorResponse,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.requestId = requestId;
  }
}

/** Stores the request ID from the most recent API call */
let _lastRequestId: string | undefined;

/** Get the request ID from the most recent API call */
export function getLastRequestId(): string | undefined {
  return _lastRequestId;
}

/**
 * Internal API request helper with authentication, timeout, and error handling.
 */
async function apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${env.API_BASE_URL}${endpoint}`;

  // Create abort controller for 10-second timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    // Plan 30-05: walk the auth precedence chain (--token flag > credentials
    // file > env.API_KEY > NotAuthenticatedError). resolveAuth owns the
    // env.API_KEY read — this module no longer pokes process.env directly.
    const auth = await resolveAuth();
    const headers: Record<string, string> = {};
    if (auth.kind === 'bearer') {
      headers['Authorization'] = `Bearer ${auth.token}`;
    } else if (auth.kind === 'legacy') {
      headers['X-API-Key'] = auth.key;
    } else {
      throw new NotAuthenticatedError();
    }
    // Only set Content-Type for requests that have a body
    if (options?.body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...headers,
        ...options?.headers,
      },
    });

    // Extract request ID from response for tracing
    const requestId = response.headers.get('x-request-id') || undefined;
    _lastRequestId = requestId;

    // Handle non-OK responses
    if (!response.ok) {
      let errorBody: ApiErrorResponse;
      try {
        errorBody = await response.json();
      } catch {
        // If response body is not JSON, create a generic error
        errorBody = {
          error: 'HTTP_ERROR',
          message: `HTTP ${response.status}: ${response.statusText}`,
        };
      }
      throw new ApiClientError(
        errorBody.message || `Request failed with status ${response.status}`,
        response.status,
        errorBody,
        requestId,
      );
    }

    // 204 No Content has no body to parse
    if (response.status === 204) {
      return undefined as T;
    }

    return await response.json();
  } catch (error) {
    // Network errors (fetch throws before response)
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error(`Cannot reach API server at ${url}. Is it running?`);
    }
    // Re-throw ApiClientError and AbortError as-is
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Create a new task.
 */
export async function createTask(data: CreateTaskInput): Promise<TaskResponse> {
  const endpoint = '/api/v1/tasks';
  const payload = await apiRequest<unknown>(endpoint, {
    method: 'POST',
    body: JSON.stringify(data),
  });
  // Trust boundary: validate the server's task body against the shared Zod
  // schema (task #774) rather than blindly casting `response.json() as T`.
  return parseTaskResponse(payload, `POST ${endpoint}`);
}

/**
 * List tasks with optional filters and pagination.
 *
 * Server returns `{ data, total, limit, offset }`. Callers that only need
 * the rows can use this function; callers that need the envelope (e.g. JSON
 * output mode) should use {@link listTasksPaginated}.
 *
 * Backward-compat: if a legacy server returns a bare array, `unwrapPage`
 * normalizes it without throwing.
 */
export async function listTasks(filters?: TaskFilters): Promise<TaskResponse[]> {
  const endpoint = buildTaskListEndpoint(filters);
  const payload = await apiRequest<unknown>(endpoint);
  // Trust boundary (task #774): validate every row + envelope shape.
  return parseTaskListResponse(payload, `GET ${endpoint}`).data;
}

/**
 * List tasks and return the full pagination envelope.
 */
export async function listTasksPaginated(
  filters?: TaskFilters,
): Promise<PaginatedResponse<TaskResponse>> {
  const endpoint = buildTaskListEndpoint(filters);
  const payload = await apiRequest<unknown>(endpoint);
  // Trust boundary (task #774): validate every row + envelope shape.
  return parseTaskListResponse(payload, `GET ${endpoint}`);
}

function buildTaskListEndpoint(filters?: TaskFilters): string {
  let endpoint = '/api/v1/tasks';
  if (filters) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined) {
        params.append(key, String(value));
      }
    });
    const queryString = params.toString();
    if (queryString) {
      endpoint += `?${queryString}`;
    }
  }
  return endpoint;
}

/**
 * Get a single task by ID.
 */
export async function getTask(id: number): Promise<TaskResponse> {
  const endpoint = `/api/v1/tasks/${id}`;
  const payload = await apiRequest<unknown>(endpoint);
  return parseTaskResponse(payload, `GET ${endpoint}`);
}

/**
 * Update a task by ID.
 */
export async function updateTask(id: number, data: UpdateTaskInput): Promise<TaskResponse> {
  const endpoint = `/api/v1/tasks/${id}`;
  const payload = await apiRequest<unknown>(endpoint, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  return parseTaskResponse(payload, `PUT ${endpoint}`);
}

/**
 * Delete a task by ID.
 */
export async function deleteTask(id: number): Promise<void> {
  await apiRequest<void>(`/api/v1/tasks/${id}`, {
    method: 'DELETE',
  });
}

// ── Project CRUD functions ──────────────────────────────────

/**
 * Create a new project.
 */
export async function createProject(data: CreateProjectInput): Promise<ProjectResponse> {
  const endpoint = '/api/v1/projects';
  const payload = await apiRequest<unknown>(endpoint, {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return parseProjectResponse(payload, `POST ${endpoint}`);
}

/**
 * List projects (paginated). Returns the rows only.
 */
export async function listProjects(pagination?: PaginationParams): Promise<ProjectResponse[]> {
  const endpoint = buildProjectListEndpoint(pagination);
  const payload = await apiRequest<unknown>(endpoint);
  // Trust boundary (task #774): validate every row + envelope shape.
  return parseProjectListResponse(payload, `GET ${endpoint}`).data;
}

/**
 * List projects and return the full pagination envelope.
 */
export async function listProjectsPaginated(
  pagination?: PaginationParams,
): Promise<PaginatedResponse<ProjectResponse>> {
  const endpoint = buildProjectListEndpoint(pagination);
  const payload = await apiRequest<unknown>(endpoint);
  // Trust boundary (task #774): validate every row + envelope shape.
  return parseProjectListResponse(payload, `GET ${endpoint}`);
}

function buildProjectListEndpoint(pagination?: PaginationParams): string {
  let endpoint = '/api/v1/projects';
  if (pagination) {
    const params = new URLSearchParams();
    if (pagination.limit !== undefined) params.append('limit', String(pagination.limit));
    if (pagination.offset !== undefined) params.append('offset', String(pagination.offset));
    const qs = params.toString();
    if (qs) endpoint += `?${qs}`;
  }
  return endpoint;
}

/**
 * Get a single project by ID.
 */
export async function getProject(id: number): Promise<ProjectResponse> {
  const endpoint = `/api/v1/projects/${id}`;
  const payload = await apiRequest<unknown>(endpoint);
  return parseProjectResponse(payload, `GET ${endpoint}`);
}

/**
 * Update a project by ID.
 */
export async function updateProject(
  id: number,
  data: UpdateProjectInput,
): Promise<ProjectResponse> {
  const endpoint = `/api/v1/projects/${id}`;
  const payload = await apiRequest<unknown>(endpoint, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  return parseProjectResponse(payload, `PUT ${endpoint}`);
}

/**
 * Delete a project by ID.
 */
export async function deleteProject(id: number): Promise<void> {
  await apiRequest<void>(`/api/v1/projects/${id}`, {
    method: 'DELETE',
  });
}

// ── Dependency management functions ─────────────────────────

/**
 * Add a dependency (task blocks another task).
 */
export async function addDependency(
  taskId: number,
  data: CreateDependencyInput,
): Promise<DependencyResponse> {
  return apiRequest<DependencyResponse>(`/api/v1/tasks/${taskId}/dependencies`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Remove a dependency relationship.
 */
export async function removeDependency(taskId: number, blocksTaskId: number): Promise<void> {
  await apiRequest<void>(`/api/v1/tasks/${taskId}/dependencies/${blocksTaskId}`, {
    method: 'DELETE',
  });
}

/**
 * Get all dependencies for a task.
 */
export async function getDependencies(taskId: number): Promise<DependencyListResponse> {
  return apiRequest<DependencyListResponse>(`/api/v1/tasks/${taskId}/dependencies`);
}

// ── Comment management functions ────────────────────────────
//
// DEFERRED (task #774): comment responses are NOT yet schema-validated at the
// client boundary — they still cast `response.json() as CommentResponse` and
// route lists through the loose `unwrapPage`/`asPage` helpers below. Comments
// are a lower-risk, lower-traffic shape (5 flat fields, no enums) than
// task/project responses, so runtime validation was scoped out per the task's
// "highest-risk adapters only" directive. When tightened, mirror the
// `parseTaskResponse` pattern with a `CommentResponseSchema`.

/**
 * Add a comment to a task.
 */
export async function addComment(
  taskId: number,
  data: CreateCommentInput,
): Promise<CommentResponse> {
  return apiRequest<CommentResponse>(`/api/v1/tasks/${taskId}/comments`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Get comments for a task (paginated). Returns the rows only.
 */
export async function getComments(
  taskId: number,
  pagination?: PaginationParams,
): Promise<CommentResponse[]> {
  const endpoint = buildCommentsEndpoint(taskId, pagination);
  const payload = await apiRequest<PaginatedResponse<CommentResponse> | CommentResponse[]>(
    endpoint,
  );
  return unwrapPage(payload);
}

/**
 * Get comments and return the full pagination envelope.
 */
export async function getCommentsPaginated(
  taskId: number,
  pagination?: PaginationParams,
): Promise<PaginatedResponse<CommentResponse>> {
  const endpoint = buildCommentsEndpoint(taskId, pagination);
  const payload = await apiRequest<PaginatedResponse<CommentResponse> | CommentResponse[]>(
    endpoint,
  );
  return asPage(payload);
}

function buildCommentsEndpoint(taskId: number, pagination?: PaginationParams): string {
  let endpoint = `/api/v1/tasks/${taskId}/comments`;
  if (pagination) {
    const params = new URLSearchParams();
    if (pagination.limit !== undefined) params.append('limit', String(pagination.limit));
    if (pagination.offset !== undefined) params.append('offset', String(pagination.offset));
    const qs = params.toString();
    if (qs) endpoint += `?${qs}`;
  }
  return endpoint;
}

/**
 * Delete a comment by ID.
 * Note: REST API route is nested under tasks (/tasks/:taskId/comments/:commentId)
 * but server only uses commentId for deletion.
 */
export async function deleteComment(taskId: number, commentId: number): Promise<void> {
  await apiRequest<void>(`/api/v1/tasks/${taskId}/comments/${commentId}`, {
    method: 'DELETE',
  });
}

// ── Subtask management functions ────────────────────────────

/**
 * Create a subtask under a parent task.
 * Subtasks are regular tasks with parent_task_id set.
 */
export async function createSubtask(
  parentTaskId: number,
  data: CreateTaskInput,
): Promise<TaskResponse> {
  const endpoint = '/api/v1/tasks';
  const payload = await apiRequest<unknown>(endpoint, {
    method: 'POST',
    body: JSON.stringify({ ...data, parent_task_id: parentTaskId }),
  });
  return parseTaskResponse(payload, `POST ${endpoint} (subtask)`);
}

/**
 * Get subtasks (children) of a parent task (paginated). Returns the rows only.
 */
export async function getSubtasks(
  parentTaskId: number,
  pagination?: PaginationParams,
): Promise<TaskResponse[]> {
  const endpoint = buildSubtasksEndpoint(parentTaskId, pagination);
  const payload = await apiRequest<unknown>(endpoint);
  // Trust boundary (task #774): validate every row + envelope shape.
  return parseTaskListResponse(payload, `GET ${endpoint}`).data;
}

/**
 * Get subtasks and return the full pagination envelope.
 */
export async function getSubtasksPaginated(
  parentTaskId: number,
  pagination?: PaginationParams,
): Promise<PaginatedResponse<TaskResponse>> {
  const endpoint = buildSubtasksEndpoint(parentTaskId, pagination);
  const payload = await apiRequest<unknown>(endpoint);
  // Trust boundary (task #774): validate every row + envelope shape.
  return parseTaskListResponse(payload, `GET ${endpoint}`);
}

function buildSubtasksEndpoint(parentTaskId: number, pagination?: PaginationParams): string {
  let endpoint = `/api/v1/tasks/${parentTaskId}/subtasks`;
  if (pagination) {
    const params = new URLSearchParams();
    if (pagination.limit !== undefined) params.append('limit', String(pagination.limit));
    if (pagination.offset !== undefined) params.append('offset', String(pagination.offset));
    const qs = params.toString();
    if (qs) endpoint += `?${qs}`;
  }
  return endpoint;
}

// ── Claim functions ─────────────────────────────────────────

/**
 * Claim a task atomically.
 * Sets assignee and transitions status to in_progress in a single operation.
 */
export async function claimTask(
  taskId: number,
  assignee: string,
  idempotencyKey?: string,
): Promise<TaskResponse> {
  const headers: Record<string, string> = {};
  if (idempotencyKey) {
    headers['X-Idempotency-Key'] = idempotencyKey;
  }
  const endpoint = `/api/v1/tasks/${taskId}/claim`;
  const payload = await apiRequest<unknown>(endpoint, {
    method: 'POST',
    body: JSON.stringify({ assignee }),
    headers,
  });
  return parseTaskResponse(payload, `POST ${endpoint}`);
}

// ── Health check functions ──────────────────────────────────

/**
 * Check service health status.
 * Note: Health endpoint is public (no auth required), but CLI still sends API key.
 */
export async function checkHealth(): Promise<HealthResponse> {
  return apiRequest<HealthResponse>('/health');
}

// ── Spinner-wrapped API calls ───────────────────────────────

/**
 * Wrap an API call with a spinner.
 * The spinner description should match the operation (e.g., "Fetching tasks...").
 */
export async function withApiSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  return withSpinner(message, fn);
}
