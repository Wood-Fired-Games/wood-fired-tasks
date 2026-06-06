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
import type { TopologyReport } from '../../schemas/topology.schema.js';
import {
  parseTaskResponse,
  parseProjectResponse,
  parseTaskListResponse,
  parseProjectListResponse,
} from '../../api/api-response.js';
import { createRemoteSSEParser } from './sse-parser.js';

// ── WSJF remote-parity payload types (WSJF 1.10) ──────────────────────────────
// Structural projections of the REST WSJF responses. Kept as plain interfaces
// (not server-side Zod inferences) so the remote rest-client stays importable
// from a minimal stdio subprocess without dragging in server schema modules —
// the same isolation principle as PAT_PREFIX above.

/** A propagation-adjusted ranked task (mirrors RankedTask). */
export interface RankedTaskPayload {
  taskId: number;
  scored: boolean;
  baseWsjf: number | null;
  effectiveWsjf: number;
  components: Record<string, number> | null;
  propagation: { dependentId: number; contribution: number }[];
  evidence: Record<string, string> | null;
}

export interface WsjfRankingResponse {
  project_id: number;
  scope: 'frontier' | 'all';
  total: number;
  ranking: RankedTaskPayload[];
}

export interface WsjfScoreHistoryRow {
  id: number;
  task_id: number;
  project_id: number;
  changed_at: string;
  trigger: string;
  wsjf_score: number | null;
  prev_wsjf_score: number | null;
  [key: string]: unknown;
}

export interface WsjfScoreHistoryResponse {
  task_id: number;
  total: number;
  history: WsjfScoreHistoryRow[];
}

export interface WsjfHealthFinding {
  check: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  suggestion: string;
  taskIds: number[];
}

export interface WsjfHealthResponse {
  project_id: number;
  healthy: boolean;
  scored_task_count: number;
  findings: WsjfHealthFinding[];
}

/** One written-back classification submission for a rescore (loose, gated server-side). */
export interface RescoreSubmissionInput {
  task_id: number;
  classification: Record<string, unknown>;
  features: Record<string, unknown>;
}

export interface RescoreTaskResultPayload {
  taskId: number;
  changed: boolean;
  skippedLocked: string[];
  components: Record<string, number>;
  prevWsjfScore: number | null;
  newWsjfScore: number;
}

export interface RescoreResponse {
  run_id: number;
  project_id: number;
  tasks_evaluated: number;
  tasks_changed: number;
  tasks_skipped_locked: number;
  results: RescoreTaskResultPayload[];
  errors: { taskId: number; errors: string[] }[];
}

/**
 * Loose envelope-or-bare-array normalizer.
 *
 * NOTE (task #774): the high-risk task / project / subtask list methods now
 * route through `parseTaskListResponse` / `parseProjectListResponse`, which
 * schema-validate every row. This helper is retained ONLY for the deliberately
 * deferred comment list paths (`getCommentsPaginated`). Its silent "unexpected
 * shape → empty page" fallback is kept for those paths' backward compatibility.
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
 * Literal PAT prefix shared with `src/services/pat-hash.ts`. Duplicated
 * here as a constant so the remote MCP package doesn't drag in the
 * server-side PAT helpers (the rest-client must stay importable from a
 * minimal stdio subprocess).
 */
const PAT_PREFIX = 'wft_pat_';

/**
 * REST API client for the remote MCP server.
 *
 * Wraps HTTP calls to the Wood Fired Tasks REST API.
 * Uses native fetch (Node 18+) with a 10-second timeout. The auth header
 * is chosen based on the apiKey prefix (Phase 31 Plan 03 Task 3, MCP-01):
 *
 *   - apiKey starts with `wft_pat_` → `Authorization: Bearer <apiKey>`
 *     (PAT path; the server's PAT strategy hashes the full string)
 *   - any other apiKey → `X-API-Key: <apiKey>` (legacy path)
 *
 * Headers are mutually exclusive so the server's auth chain never has to
 * pick between two strategies for the same request.
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
   * Build the mutually-exclusive auth header for this client's key.
   *
   * Phase 31 Plan 03 Task 3 (MCP-01): switch header name based on prefix.
   * Mirrors the same precedence Phase 30 Plan 05 wired into the CLI client
   * (`src/cli/api/client.ts`). The full apiKey value flows through verbatim
   * — the server needs the entire `wft_pat_<body>` string for the SHA-256
   * lookup. Factored out (task #481) so the streaming `waitForUnblock` SSE
   * path applies the identical rule as `request()` without going through it.
   */
  private authHeader(): Record<string, string> {
    if (this.apiKey.startsWith(PAT_PREFIX)) {
      return { Authorization: `Bearer ${this.apiKey}` };
    }
    return { 'X-API-Key': this.apiKey };
  }

  /**
   * Internal HTTP request helper with authentication, timeout, and error handling.
   */
  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const headers: Record<string, string> = { ...this.authHeader() };
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
          const body = (await response.json()) as { message?: string; error?: string };
          errorMessage =
            body.message || body.error || `HTTP ${response.status}: ${response.statusText}`;
        } catch {
          errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(`API request failed: ${errorMessage}`);
      }

      // 204 No Content has no body to parse
      if (response.status === 204) {
        return undefined as T;
      }

      // Trust boundary (task #774): `request` returns the raw parsed JSON cast
      // to `T`. This cast is UNVALIDATED — high-risk task/project/list callers
      // below re-parse the result through the shared Zod response schemas
      // (`parseTaskResponse` / `parseProjectResponse` / `parse*ListResponse`)
      // so a malformed or version-skewed body fails loudly instead of leaking
      // an untyped shape downstream. Low-risk callers (comments, dependencies,
      // health, WSJF, topology) keep the bare cast and are documented as
      // deferred at their call sites.
      return (await response.json()) as T;
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
    const endpoint = '/api/v1/tasks';
    const payload = await this.request<unknown>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return parseTaskResponse(payload, `POST ${endpoint}`);
  }

  async getTask(id: number): Promise<TaskResponse> {
    const endpoint = `/api/v1/tasks/${id}`;
    const payload = await this.request<unknown>(endpoint);
    return parseTaskResponse(payload, `GET ${endpoint}`);
  }

  async updateTask(id: number, data: UpdateTaskInput): Promise<TaskResponse> {
    const endpoint = `/api/v1/tasks/${id}`;
    const payload = await this.request<unknown>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return parseTaskResponse(payload, `PUT ${endpoint}`);
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
    const payload = await this.request<unknown>(endpoint);
    // Trust boundary (task #774): schema-validate every row + envelope shape.
    return parseTaskListResponse(payload, `GET ${endpoint}`);
  }

  async deleteTask(id: number): Promise<void> {
    await this.request<void>(`/api/v1/tasks/${id}`, { method: 'DELETE' });
  }

  async claimTask(taskId: number, assignee: string): Promise<TaskResponse> {
    const endpoint = `/api/v1/tasks/${taskId}/claim`;
    const payload = await this.request<unknown>(endpoint, {
      method: 'POST',
      body: JSON.stringify({ assignee }),
    });
    return parseTaskResponse(payload, `POST ${endpoint}`);
  }

  async getSubtasks(parentTaskId: number, pagination?: PaginationParams): Promise<TaskResponse[]> {
    const page = await this.getSubtasksPaginated(parentTaskId, pagination);
    return page.data;
  }

  async getSubtasksPaginated(
    parentTaskId: number,
    pagination?: PaginationParams,
  ): Promise<PaginatedResponse<TaskResponse>> {
    let endpoint = `/api/v1/tasks/${parentTaskId}/subtasks`;
    if (pagination) {
      const params = new URLSearchParams();
      if (pagination.limit !== undefined) params.append('limit', String(pagination.limit));
      if (pagination.offset !== undefined) params.append('offset', String(pagination.offset));
      const qs = params.toString();
      if (qs) endpoint += `?${qs}`;
    }
    const payload = await this.request<unknown>(endpoint);
    // Trust boundary (task #774): schema-validate every row + envelope shape.
    return parseTaskListResponse(payload, `GET ${endpoint}`);
  }

  // ── Project operations ───────────────────────────────────────────────────

  async createProject(data: CreateProjectInput): Promise<ProjectResponse> {
    const endpoint = '/api/v1/projects';
    const payload = await this.request<unknown>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return parseProjectResponse(payload, `POST ${endpoint}`);
  }

  async getProject(id: number): Promise<ProjectResponse> {
    const endpoint = `/api/v1/projects/${id}`;
    const payload = await this.request<unknown>(endpoint);
    return parseProjectResponse(payload, `GET ${endpoint}`);
  }

  async updateProject(id: number, data: UpdateProjectInput): Promise<ProjectResponse> {
    const endpoint = `/api/v1/projects/${id}`;
    const payload = await this.request<unknown>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return parseProjectResponse(payload, `PUT ${endpoint}`);
  }

  async listProjects(pagination?: PaginationParams): Promise<ProjectResponse[]> {
    const page = await this.listProjectsPaginated(pagination);
    return page.data;
  }

  async listProjectsPaginated(
    pagination?: PaginationParams,
  ): Promise<PaginatedResponse<ProjectResponse>> {
    let endpoint = '/api/v1/projects';
    if (pagination) {
      const params = new URLSearchParams();
      if (pagination.limit !== undefined) params.append('limit', String(pagination.limit));
      if (pagination.offset !== undefined) params.append('offset', String(pagination.offset));
      const qs = params.toString();
      if (qs) endpoint += `?${qs}`;
    }
    const payload = await this.request<unknown>(endpoint);
    // Trust boundary (task #774): schema-validate every row + envelope shape.
    return parseProjectListResponse(payload, `GET ${endpoint}`);
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
  //
  // DEFERRED (task #774): comment / dependency responses are NOT yet
  // schema-validated — they keep the bare `request<T>` cast. These are
  // lower-risk shapes (flat numeric/string fields, no enums) than the
  // task/project responses that were tightened. When tightened, add a
  // `CommentResponseSchema` and mirror the `parseTaskResponse` pattern.

  async addComment(taskId: number, data: CreateCommentInput): Promise<CommentResponse> {
    return this.request<CommentResponse>(`/api/v1/tasks/${taskId}/comments`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getComments(taskId: number, pagination?: PaginationParams): Promise<CommentResponse[]> {
    const page = await this.getCommentsPaginated(taskId, pagination);
    return page.data;
  }

  async getCommentsPaginated(
    taskId: number,
    pagination?: PaginationParams,
  ): Promise<PaginatedResponse<CommentResponse>> {
    let endpoint = `/api/v1/tasks/${taskId}/comments`;
    if (pagination) {
      const params = new URLSearchParams();
      if (pagination.limit !== undefined) params.append('limit', String(pagination.limit));
      if (pagination.offset !== undefined) params.append('offset', String(pagination.offset));
      const qs = params.toString();
      if (qs) endpoint += `?${qs}`;
    }
    const payload = await this.request<PaginatedResponse<CommentResponse> | CommentResponse[]>(
      endpoint,
    );
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
  async getCompletionReport(input: CompletionReportInput): Promise<CompletionReportResponse> {
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

  // ── Topology operations ──────────────────────────────────────────────────

  /**
   * Classify a project's dependency topology via
   * `GET /api/v1/projects/:id/topology`.
   *
   * Returns the same `TopologyReport` shape the stdio MCP `topology_check`
   * tool emits (topology, edges, roots, leaves, advisory) so the remote
   * proxy tool is transport-indistinguishable from the local one.
   */
  async getTopology(projectId: number): Promise<TopologyReport> {
    return this.request<TopologyReport>(`/api/v1/projects/${projectId}/topology`);
  }

  // ── WSJF operations ──────────────────────────────────────────────────────
  // Remote parity (WSJF 1.10) for the stdio wsjf_ranking / wsjf_history /
  // rescore_project / wsjf_health tools. Each proxies the project- (or task-)
  // scoped REST endpoint that exposes the same service the stdio server wires
  // in-process, so the remote proxy tools are transport-indistinguishable.

  /**
   * Rank a project's tasks by propagation-adjusted WSJF via
   * `GET /api/v1/projects/:id/wsjf-ranking?scope=...`.
   */
  async getWsjfRanking(projectId: number, scope: 'frontier' | 'all'): Promise<WsjfRankingResponse> {
    return this.request<WsjfRankingResponse>(
      `/api/v1/projects/${projectId}/wsjf-ranking?scope=${scope}`,
    );
  }

  /**
   * Read a task's append-only WSJF score history via
   * `GET /api/v1/tasks/:id/score-history`. The stdio `wsjf_history` tool reads
   * the same `wsjf_score_history` rows in-process; this is the REST analogue.
   */
  async getWsjfHistory(taskId: number): Promise<WsjfScoreHistoryResponse> {
    return this.request<WsjfScoreHistoryResponse>(`/api/v1/tasks/${taskId}/score-history`);
  }

  /**
   * Lint a project's WSJF state for degeneracies via
   * `GET /api/v1/projects/:id/wsjf-health`.
   */
  async getWsjfHealth(projectId: number): Promise<WsjfHealthResponse> {
    return this.request<WsjfHealthResponse>(`/api/v1/projects/${projectId}/wsjf-health`);
  }

  /**
   * Deterministically rescore a project via `POST /api/v1/projects/:id/rescore`.
   * The server delegates to `WsjfRescoreService.rescore`, which owns the
   * rescore-run + history + component write lifecycle (one transaction).
   */
  async rescoreProject(
    projectId: number,
    submissions: RescoreSubmissionInput[],
    opts?: { actor_type?: string; actor_id?: string },
  ): Promise<RescoreResponse> {
    return this.request<RescoreResponse>(`/api/v1/projects/${projectId}/rescore`, {
      method: 'POST',
      body: JSON.stringify({
        submissions,
        ...(opts?.actor_type !== undefined && { actor_type: opts.actor_type }),
        ...(opts?.actor_id !== undefined && { actor_id: opts.actor_id }),
      }),
    });
  }

  // ── SSE wait operations ──────────────────────────────────────────────────

  /**
   * Block on the API's SSE stream until task `taskId` transitions
   * `blocked -> open`, the `timeoutMs` deadline elapses, or `signal` aborts
   * (task #481 — remote parity for the stdio `wait_for_unblock` tool).
   *
   * This is the cross-process analogue of the stdio tool's in-process
   * EventBus subscription: it opens a streaming authenticated
   * `GET /api/v1/events?event_types=task.status_changed`, parses SSE frames
   * incrementally off `fetch().body`, and resolves on the first
   * `task.status_changed` frame whose payload satisfies
   * `data.id === taskId && metadata.from === 'blocked' && metadata.to === 'open'`.
   *
   * Resolution:
   *   - `true`  — the matching transition was observed.
   *   - `false` — the `timeoutMs` deadline elapsed first (NO throw — the
   *               caller maps this to the `timeout` envelope).
   *
   * Teardown is unconditional: on resolve, timeout, AND abort the underlying
   * `fetch` is aborted (which tears down the socket) and the stream reader is
   * cancelled, and every timer is cleared — no socket / reader leak. The
   * method's own AbortController is `abort()`-ed in a `finally`, and it also
   * chains the caller's `signal` so an external abort propagates to the
   * fetch immediately.
   *
   * Network / auth failures throw (TypeError "fetch failed" → friendly hint;
   * non-2xx → `Error` with the status), so an unauthorized stream surfaces an
   * error rather than silently timing out.
   *
   * NOTE — this method does NOT do the already_unblocked fast-path read; the
   * caller (`register-tools.ts`) opens this stream FIRST and then re-reads
   * the task status, aborting this stream via `signal` if the re-read shows
   * the task is no longer blocked. That ordering closes the subscribe-vs-read
   * race the stdio tool documents (a transition landing between the read and
   * the subscribe would otherwise be missed).
   */
  async waitForUnblockViaSse(
    taskId: number,
    timeoutMs: number,
    signal: AbortSignal,
    fetchImpl: typeof fetch = fetch,
  ): Promise<boolean> {
    const url = `${this.baseUrl}/api/v1/events?event_types=task.status_changed`;

    // Our own controller so we can tear the fetch down on resolve/timeout.
    // It also fires if the caller's `signal` aborts (chained below).
    const controller = new AbortController();

    // A settle-on-abort promise so the race ends the instant EITHER the
    // deadline fires OR the caller's external `signal` aborts — without
    // depending on the underlying `reader.read()` rejecting (a mocked stream
    // may never propagate the abort). Both resolve `false` (timeout / cancel
    // semantics — no throw).
    let settleEarly!: (v: boolean) => void;
    const earlyExit = new Promise<boolean>((resolve) => {
      settleEarly = resolve;
    });

    const onExternalAbort = (): void => {
      controller.abort();
      settleEarly(false);
    };
    if (signal.aborted) {
      controller.abort();
      settleEarly(false);
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeoutTimer = setTimeout(() => {
        // Deadline hit: abort the fetch (tears down the socket) and resolve
        // false. No throw — the caller maps false to the timeout envelope.
        controller.abort();
        resolve(false);
      }, timeoutMs);
    });

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const streamPromise = (async (): Promise<boolean> => {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { ...this.authHeader(), Accept: 'text/event-stream' },
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          // Aborted by timeout or external signal — not a real failure.
          return false;
        }
        if (error instanceof TypeError && error.message.includes('fetch')) {
          throw new Error(`Cannot reach API server at ${this.baseUrl}. Is it running?`);
        }
        throw error;
      }

      if (!response.ok || response.body === null) {
        // Parse the error body BEFORE draining it (reading json() consumes the
        // stream; cancelling first would make json() throw and lose the
        // server's message).
        let message: string;
        try {
          const body = (await response.json()) as { message?: string; error?: string };
          message = body.message || body.error || `HTTP ${response.status}: ${response.statusText}`;
        } catch {
          message = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(`API request failed: ${message}`);
      }

      const parser = createRemoteSSEParser();
      const decoder = new TextDecoder('utf-8');
      reader = response.body.getReader();

      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            // Reader cancelled (abort/timeout) or read error → stop waiting.
            return false;
          }
          if (chunk.done) {
            // Server closed the stream without the transition we wanted.
            return false;
          }
          const text = decoder.decode(chunk.value, { stream: true });
          for (const frame of parser.feed(text)) {
            if (frame.data === '') continue;
            let payload: {
              data?: { id?: number };
              metadata?: { from?: string; to?: string };
            };
            try {
              payload = JSON.parse(frame.data);
            } catch {
              // Non-JSON frame (e.g. the initial `connected` event carries a
              // JSON string too, but be defensive) — skip.
              continue;
            }
            if (
              payload.data?.id === taskId &&
              payload.metadata?.from === 'blocked' &&
              payload.metadata?.to === 'open'
            ) {
              return true;
            }
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* already torn down */
        }
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    })();

    try {
      // Whichever settles first wins. The loser is torn down in `finally`.
      return await Promise.race([streamPromise, timeoutPromise, earlyExit]);
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onExternalAbort);
      // Unconditional teardown. Abort the fetch (closes the socket on a real
      // connection); idempotent so safe to call repeatedly. On a real fetch
      // the abort rejects the pending `reader.read()`; for robustness (and
      // because a mocked stream may not propagate the abort) ALSO cancel the
      // reader directly so the stream loop's pending read settles and its
      // `finally` runs. Cancelling resolves the read with `done:true`.
      controller.abort();
      if (reader !== undefined) {
        try {
          await reader.cancel();
        } catch {
          /* already torn down */
        }
      }
      // Let the stream promise settle so its `finally` (reader.cancel /
      // releaseLock) runs before we return; swallow any late rejection.
      await streamPromise.catch(() => undefined);
    }
  }

  // ── Health operations ────────────────────────────────────────────────────

  async checkHealth(): Promise<HealthResponse> {
    // Hit the AUTHENTICATED detailed endpoint so the response carries the DB
    // path + fingerprint. The public /health is intentionally minimal (task
    // #185); the remote client always sends X-API-Key, so the auth-gated
    // /health/detailed is reachable here.
    return this.request<HealthResponse>('/health/detailed');
  }
}
