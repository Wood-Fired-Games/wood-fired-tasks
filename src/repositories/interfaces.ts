import type {
  Project,
  CreateProjectDTO,
  Task,
  CreateTaskDTO,
  UpdateTaskDTO,
  TaskFilters,
  Dependency,
  CreateDependencyDTO,
  Comment,
  CreateCommentDTO,
} from '../types/task.js';
import type { User, ApiToken, UserUpsertInput } from '../types/identity.js';

/**
 * Bounded pagination options accepted by every list-style repository call.
 * Both fields are optional at the type level; repositories apply sensible
 * defaults when callers omit them (typically: limit=50, offset=0).
 */
export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export interface IProjectRepository {
  create(dto: CreateProjectDTO): Project;
  findById(id: number): Project | null;
  findAll(pagination?: PaginationOptions): Project[];
  findByName(name: string): Project | null;
  update(id: number, updates: Partial<CreateProjectDTO>): Project;
  delete(id: number): void;
  /** Total project count, ignoring pagination. Used to build list envelopes. */
  count(): number;
}

export interface CompletionRangeFilters {
  start: string; // ISO8601 inclusive
  end: string; // ISO8601 inclusive
  project_id?: number;
  assignee?: string;
}

export interface ITaskRepository {
  create(dto: CreateTaskDTO, tags?: string[]): Task & { tags: string[] };
  findById(id: number): (Task & { tags: string[] }) | null;
  findAll(pagination?: PaginationOptions): Array<Task & { tags: string[] }>;
  update(id: number, updates: UpdateTaskDTO): Task & { tags: string[] };
  delete(id: number): void;
  /**
   * Filter + paginate tasks. `filters.limit`/`filters.offset` ride along on
   * the TaskFilters object so callers (CLI, MCP, REST) all share one shape.
   */
  findByFilters(filters: TaskFilters): Array<Task & { tags: string[] }>;
  findChildren(
    parentId: number,
    pagination?: PaginationOptions
  ): Array<Task & { tags: string[] }>;
  /**
   * Total match count for the same filter set, ignoring pagination.
   * Powers the `total` field in the {data,total,limit,offset} envelope.
   */
  count(filters?: TaskFilters): number;
  /** Total children count for a parent task, ignoring pagination. */
  countChildren(parentId: number): number;
  /**
   * Atomic claim. The trailing `assigneeUserId` is the Phase-31 FK companion
   * to the existing TEXT `assignee`. When provided (including `null`), the
   * repository writes `assignee_user_id` alongside `assignee` in the same
   * CAS UPDATE; when omitted, the FK column stays NULL (matches legacy
   * 2-arg callers).
   */
  claimTask(
    id: number,
    assignee: string,
    assigneeUserId?: number | null,
  ): (Task & { tags: string[] }) | null;
  findCompletedInRange(
    filters: CompletionRangeFilters
  ): Array<Task & { tags: string[] }>;
}

export interface IDependencyRepository {
  create(dto: CreateDependencyDTO): Dependency;
  findAll(): Dependency[];
  findByTaskId(taskId: number): Dependency[];
  findBlockingTask(taskId: number): Dependency[];
  delete(taskId: number, blocksTaskId: number): boolean;
  deleteByTaskId(taskId: number): void;
}

export interface ICommentRepository {
  create(dto: CreateCommentDTO): Comment;
  findByTaskId(taskId: number, pagination?: PaginationOptions): Comment[];
  findById(id: number): Comment | null;
  delete(id: number): boolean;
  countByTaskId(taskId: number): number;
}

/**
 * Repository for the `users` table.
 *
 * Phase 27 shipped the read methods. Phase 28 (Plan 28-02) added the
 * `findByEmail` read method needed by the `tasks db mint-token` CLI
 * (`--user <id|email|displayName>` resolution). Write paths are still
 * deferred: identity-row writes land in Phase 29 (JIT OIDC provisioning)
 * and Phase 30 (CLI device-code flow).
 */
export interface IUserRepository {
  /** Lookup a single user by primary key. */
  findById(id: number): User | null;
  /** Lookup by the composite (oidc_provider, oidc_sub) identity. */
  findByOidcSub(provider: string, sub: string): User | null;
  /** Lookup by the Slack user identifier (e.g. `U0123ABC`). */
  findBySlackUserId(slackUserId: string): User | null;
  /** Lookup an `is_legacy=1` user by display_name — idempotency key for seeder. */
  findLegacyByDisplayName(displayName: string): User | null;
  /**
   * Lookup an `is_service_account=1` user by display_name. Used by the MCP
   * boot (`mcp-bot`) and Slack fallback (`slack-bot`) handlers to resolve
   * their service-account `users.id` once at startup. Returns null when no
   * row matches (and silently for null/undefined/empty input — these are
   * treated as "no such name"). Backed by the partial UNIQUE index
   * `idx_users_slack_bot` (covers any service-account display_name).
   */
  findServiceAccountByName(name: string): User | null;
  /**
   * Case-insensitive email lookup (`WHERE LOWER(email) = LOWER(?)`).
   * Returns the lowest-id row when duplicates exist (`ORDER BY id ASC LIMIT 1`);
   * v1.6 has no UNIQUE on `email`.
   *
   * @throws TypeError when `email` is null, undefined, or empty.
   */
  findByEmail(email: string): User | null;
  /** Admin: list every user, ordered by id ASC. */
  listAll(): User[];
  /**
   * Insert a new user provisioned by OIDC just-in-time. The row's
   * `oidc_provider` and `oidc_sub` columns are both set; `is_legacy` and
   * `is_service_account` default to 0. Returns the freshly-inserted row
   * with the database-assigned `id` and `created_at` populated.
   *
   * @throws TypeError when any required field is null/undefined/empty.
   * @throws better-sqlite3 SqliteError on UNIQUE violation
   *         (`oidc_provider`, `oidc_sub`) — caller handles the race with
   *         findByOidcSub.
   */
  insert(input: UserUpsertInput): User;
  /**
   * Apply email + displayName drift to an existing row. Either field may
   * be omitted from the patch (no-op for that column). Returns the fresh
   * row after update; returns `null` when `id` does not exist (no row
   * affected). Never mutates oidc_provider/oidc_sub/created_at/is_legacy/
   * is_service_account/disabled_at.
   *
   * @throws TypeError when `id` is non-positive.
   */
  updateProfile(
    id: number,
    patch: { email?: string | null; displayName?: string },
  ): User | null;
}

/**
 * Repository for the `api_tokens` table.
 *
 * Phase 27 introduced the read-only methods; Phase 28 (Plan 28-02) added
 * the write methods (`insert`, `revoke`, `touchLastUsed`) that mint, revoke,
 * and observe PATs.
 */
export interface IApiTokenRepository {
  /** Lookup a single token row by primary key. */
  findById(id: number): ApiToken | null;
  /**
   * Lookup by SHA-256 hash. Does NOT pre-filter `revoked_at IS NULL` —
   * Phase 28's auth chain layers that check on top.
   */
  findByHash(hash: string): ApiToken | null;
  /** List all tokens owned by a user, newest first (`created_at DESC`). */
  listByUser(userId: number): ApiToken[];
  /**
   * Insert a fresh token row. Returns the inserted row, including the
   * autogenerated `id` and DB-defaulted `created_at`. `scopes` defaults to
   * `'[]'`; `expiresAt` defaults to NULL.
   *
   * Throws on FK violation (`userId` references a non-existent user).
   */
  insert(input: {
    userId: number;
    name: string;
    prefix: string;
    suffix: string;
    hash: string;
    scopes?: string;
    expiresAt?: string | null;
  }): ApiToken;
  /**
   * Mark a token as revoked. Scoped by `user_id` so users cannot affect
   * each other's tokens. Returns `true` iff exactly one row was updated
   * (matches `(id, user_id)` AND is not already revoked); otherwise
   * `false`. By design, "wrong user" and "no such token" both return
   * `false` so callers cannot distinguish existence by response.
   */
  revoke(id: number, userId: number): boolean;
  /**
   * Best-effort observational write of `last_used_at = datetime('now')`.
   * No-op when `id` does not exist (no throw). The auth chain calls this
   * asynchronously after a successful PAT match; failures are logged but
   * never block the request. Plan 28-06 layers a debounce on top
   * (PAT-03).
   */
  touchLastUsed(id: number): void;
}
