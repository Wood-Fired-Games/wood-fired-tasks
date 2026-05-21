import type {
  TaskResponse,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilters,
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
  CompletionReportInput,
  CompletionReportResponse,
} from '../../cli/api/types.js';

function asPage<T>(payload: PaginatedResponse<T> | T[]): PaginatedResponse<T> {
  if (Array.isArray(payload)) {
    return { data: payload, total: payload.length, limit: payload.length, offset: 0 };
  }
  if (payload && typeof payload === 'object' && Array.isArray((payload as PaginatedResponse<T>).data)) {
    return payload as PaginatedResponse<T>;
  }
  return { data: [], total: 0, limit: 0, offset: 0 };
}

/**
 * REST API client for the remote MCP server.
 *
 * Wraps HTTP calls to the Wood Fired Bugs REST API.
 * Uses native fetch (Node 18+) with X-API-Key authentication and a 10-second timeout.
 */
export class RestClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    // Strip trailing slash for consistent URL construction
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  /**
   * Internal HTTP request helper with authentication, timeout, and error handling.
   */
  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const headers: Record<string, string> = {
        'X-API-Key': this.apiKey,
      };
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

      if (!response.ok) {
        let errorMessage: string;
        try {
          const body = await response.json() as { message?: string; error?: string };
          errorMessage = body.message || body.error || `HTTP ${response.status}: ${response.statusText}`;
        } catch {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(`API request failed: ${errorMessage}`);
      }

      // 204 No Content has no body to parse
      if (response.status === 204) {
        return undefined as T;
      }

      return await response.json() as T;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new Error(`Cannot reach API server at ${this.baseUrl}. Is it running?`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Task operations ──────────────────────────────────────────────────────

  async createTask(data: CreateTaskInput): Promise<TaskResponse> {
    return this.request<TaskResponse>('/api/v1/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getTask(id: number): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/v1/tasks/${id}`);
  }

  async updateTask(id: number, data: UpdateTaskInput): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/v1/tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async listTasks(filters?: TaskFilters): Promise<TaskResponse[]> {
    const page = await this.listTasksPaginated(filters);
    return page.data;
  }

  async listTasksPaginated(filters?: TaskFilters): Promise<PaginatedResponse<TaskResponse>> {
    let endpoint = '/api/v1/tasks';
    if (filters) {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined) {
          if (Array.isArray(value)) {
            value.forEach((v: unknown) => params.append(key, String(v)));
          } else {
            params.append(key, String(value));
          }
        }
      });
      const queryString = params.toString();
      if (queryString) {
        endpoint += `?${queryString}`;
      }
    }
    const payload = await this.request<PaginatedResponse<TaskResponse> | TaskResponse[]>(endpoint);
    return asPage(payload);
  }

  async deleteTask(id: number): Promise<void> {
    await this.request<void>(`/api/v1/tasks/${id}`, { method: 'DELETE' });
  }

  async claimTask(taskId: number, assignee: string): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      body: JSON.stringify({ assignee }),
    });
  }

  async getSubtasks(
    parentTaskId: number,
    pagination?: PaginationParams
  ): Promise<TaskResponse[]> {
    const page = await this.getSubtasksPaginated(parentTaskId, pagination);
    return page.data;
  }

  async getSubtasksPaginated(
    parentTaskId: number,
    pagination?: PaginationParams
  ): Promise<PaginatedResponse<TaskResponse>> {
    let endpoint = `/api/v1/tasks/${parentTaskId}/subtasks`;
    if (pagination) {
      const params = new URLSearchParams();
      if (pagination.limit !== undefined) params.append('limit', String(pagination.limit));
      if (pagination.offset !== undefined) params.append('offset', String(pagination.offset));
      const qs = params.toString();
      if (qs) endpoint += `?${qs}`;
    }
    const payload = await this.request<PaginatedResponse<TaskResponse> | TaskResponse[]>(endpoint);
    return asPage(payload);
  }

  // ── Project operations ───────────────────────────────────────────────────

  async createProject(data: CreateProjectInput): Promise<ProjectResponse> {
    return this.request<ProjectResponse>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getProject(id: number): Promise<ProjectResponse> {
    return this.request<ProjectResponse>(`/api/v1/projects/${id}`);
  }

  async updateProject(id: number, data: UpdateProjectInput): Promise<ProjectResponse> {
    return this.request<ProjectResponse>(`/api/v1/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async listProjects(pagination?: PaginationParams): Promise<ProjectResponse[]> {
    const page = await this.listProjectsPaginated(pagination);
    return page.data;
  }

  async listProjectsPaginated(
    pagination?: PaginationParams
  ): Promise<PaginatedResponse<ProjectResponse>> {
    let endpoint = '/api/v1/projects';
    if (pagination) {
      const params = new URLSearchParams();
      if (pagination.limit !== undefined) params.append('limit', String(pagination.limit));
      if (pagination.offset !== undefined) params.append('offset', String(pagination.offset));
      const qs = params.toString();
      if (qs) endpoint += `?${qs}`;
    }
    const payload = await this.request<PaginatedResponse<ProjectResponse> | ProjectResponse[]>(endpoint);
    return asPage(payload);
  }

  async deleteProject(id: number): Promise<void> {
    await this.request<void>(`/api/v1/projects/${id}`, { method: 'DELETE' });
  }

  // ── Dependency operations ────────────────────────────────────────────────

  async addDependency(taskId: number, data: CreateDependencyInput): Promise<DependencyResponse> {
    return this.request<DependencyResponse>(`/api/v1/tasks/${taskId}/dependencies`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async removeDependency(taskId: number, blocksTaskId: number): Promise<void> {
    await this.request<void>(`/api/v1/tasks/${taskId}/dependencies/${blocksTaskId}`, {
      method: 'DELETE',
    });
  }

  async getDependencies(taskId: number): Promise<DependencyListResponse> {
    return this.request<DependencyListResponse>(`/api/v1/tasks/${taskId}/dependencies`);
  }

  // ── Comment operations ───────────────────────────────────────────────────

  async addComment(taskId: number, data: CreateCommentInput): Promise<CommentResponse> {
    return this.request<CommentResponse>(`/api/v1/tasks/${taskId}/comments`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getComments(
    taskId: number,
    pagination?: PaginationParams
  ): Promise<CommentResponse[]> {
    const page = await this.getCommentsPaginated(taskId, pagination);
    return page.data;
  }

  async getCommentsPaginated(
    taskId: number,
    pagination?: PaginationParams
  ): Promise<PaginatedResponse<CommentResponse>> {
    let endpoint = `/api/v1/tasks/${taskId}/comments`;
    if (pagination) {
      const params = new URLSearchParams();
      if (pagination.limit !== undefined) params.append('limit', String(pagination.limit));
      if (pagination.offset !== undefined) params.append('offset', String(pagination.offset));
      const qs = params.toString();
      if (qs) endpoint += `?${qs}`;
    }
    const payload = await this.request<PaginatedResponse<CommentResponse> | CommentResponse[]>(endpoint);
    return asPage(payload);
  }

  async deleteComment(taskId: number, commentId: number): Promise<void> {
    await this.request<void>(`/api/v1/tasks/${taskId}/comments/${commentId}`, {
      method: 'DELETE',
    });
  }

  // ── Completion report operations ─────────────────────────────────────────

  /**
   * Fetch a completion report from `GET /api/v1/tasks/completion-report`.
   *
   * Caller supplies EITHER `days` (trailing window, 1-365) OR an explicit
   * `start`+`end` ISO8601 pair. Optional `project_id` and `assignee` filters
   * narrow the result set. The server-side schema enforces these invariants
   * and returns a 400 with a sanitized validation error on misuse.
   */
  async getCompletionReport(
    input: CompletionReportInput
  ): Promise<CompletionReportResponse> {
    const params = new URLSearchParams();
    if (input.days !== undefined) params.append('days', String(input.days));
    if (input.start !== undefined) params.append('start', input.start);
    if (input.end !== undefined) params.append('end', input.end);
    if (input.project_id !== undefined) {
      params.append('project_id', String(input.project_id));
    }
    if (input.assignee !== undefined) params.append('assignee', input.assignee);
    const qs = params.toString();
    const endpoint = qs
      ? `/api/v1/tasks/completion-report?${qs}`
      : '/api/v1/tasks/completion-report';
    return this.request<CompletionReportResponse>(endpoint);
  }

  // ── Health operations ────────────────────────────────────────────────────

  async checkHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health');
  }
}
