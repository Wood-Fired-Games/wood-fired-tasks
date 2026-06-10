import { ITaskRepository, IProjectRepository } from '../repositories/interfaces.js';
import type {
  IWsjfHistoryRepository,
  WsjfHistoryTrigger,
} from '../repositories/wsjf-history.repository.js';
import {
  Task,
  VALID_STATUS_TRANSITIONS,
  TaskPriority,
  TaskStatus,
  PaginatedResponse,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_PAGE_OFFSET,
  Fib,
  WsjfWriteDTO,
  CreateTaskDTO,
  UpdateTaskDTO,
  TaskFilters,
  VerificationEvidence,
} from '../types/task.js';
import { omitUndefined } from '../utils/omit-undefined.js';
import type { WsjfComponents, WsjfSource } from '../types/wsjf.js';
import {
  computeWsjf,
  validateManualScore,
  derivePropagatedValuePrior,
  minutesToTier,
  type PropagatedValuePrior,
} from './wsjf.service.js';
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  TaskFiltersSchema,
  CompletionReportSchema,
  type WsjfWriteInput,
  type VerificationEvidence as VerificationEvidenceInput,
} from '../schemas/task.schema.js';
import { ValidationError, BusinessError, NotFoundError } from './errors.js';
import type { DependencyService } from './dependency.service.js';
import { FtsSyntaxError } from '../repositories/errors.js';
import { eventBus } from '../events/event-bus.js';
import { DEFAULT_CLAIM_TTL_MINUTES } from './claim-release.service.js';
import { validateVerificationEvidence } from './evidence-validation.js';
import type Database from '../db/driver.js';

/**
 * Sanitized message surfaced to clients when the FTS5 search expression
 * fails to parse. The raw SQLite error text is intentionally NOT included —
 * see `FtsSyntaxError.originalMessage` for the value preserved for logging.
 */
const FTS_SYNTAX_ERROR_MESSAGE =
  'Invalid search syntax. The search query must be a valid SQLite FTS5 expression.';

function ftsValidationError(): ValidationError {
  return new ValidationError({ search: [FTS_SYNTAX_ERROR_MESSAGE] });
}

/**
 * Task #1003: parse a task timestamp into epoch millis. The repository
 * normalizes `updated_at` to ISO 8601 (`...T...Z`), but `claimed_at` may
 * still carry SQLite's raw `YYYY-MM-DD HH:MM:SS` (UTC) shape — naive
 * `new Date(...)` would parse that as LOCAL time, skewing the remaining-TTL
 * math by the host's UTC offset. Returns null on unparseable input.
 */
function parseUtcTimestamp(value: string): number | null {
  const sqliteShape = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  const iso = sqliteShape ? `${sqliteShape[1]}T${sqliteShape[2]}.000Z` : value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Task #1003: claim-TTL visibility on the single-task read path. For a task
 * holding an active claim, attach `claim_ttl_minutes` (the
 * ClaimReleaseService sweep timeout) and `claim_remaining_seconds` — the
 * floor-clamped seconds until the claim becomes ELIGIBLE for auto-release.
 * Measured from the LATER of `claimed_at` / `updated_at`, mirroring the
 * sweep's staleness predicate (both must exceed the TTL, so any activity or
 * a same-assignee re-claim restarts the window). Unclaimed tasks pass
 * through untouched — the fields stay absent (additive, optional).
 */
function withClaimTtl<T extends Task>(task: T): T {
  if (task.status !== 'in_progress' || task.assignee === null || task.claimed_at === null) {
    return task;
  }
  const claimedMs = parseUtcTimestamp(task.claimed_at);
  const updatedMs = parseUtcTimestamp(task.updated_at);
  if (claimedMs === null || updatedMs === null) {
    return task;
  }
  const windowStartMs = Math.max(claimedMs, updatedMs);
  const expiresAtMs = windowStartMs + DEFAULT_CLAIM_TTL_MINUTES * 60 * 1000;
  const remainingSeconds = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
  return {
    ...task,
    claim_ttl_minutes: DEFAULT_CLAIM_TTL_MINUTES,
    claim_remaining_seconds: remainingSeconds,
  };
}

/**
 * Normalize a parsed `wsjf` field for spreading into a Create/Update task DTO,
 * preserving the absent / null / value three-state convention under
 * exactOptionalPropertyTypes.
 *
 * Zod `.optional().nullable()` yields `WsjfWriteInput | null | undefined`, and
 * the object's own nested props (`evidence`, `locked`, …) are `T | undefined`.
 * The {@link WsjfWriteDTO} target slots are exact-optional, so an explicit
 * `undefined` nested key is rejected.
 *
 *   - parsed `undefined` (key absent)  → `{}`            → leave wsjf_* untouched
 *   - parsed `null` (clear)            → `{ wsjf: null }` → clear all wsjf_*
 *   - parsed object (set)              → `{ wsjf: <undefined-stripped> }`
 *
 * The four required components stay required; only undefined-valued optional
 * keys are dropped, so behaviour is unchanged.
 */
function normalizeWsjfWrite(wsjf: WsjfWriteInput | null | undefined): {
  wsjf?: WsjfWriteDTO | null;
} {
  if (wsjf === undefined) return {};
  if (wsjf === null) return { wsjf: null };
  return {
    wsjf: {
      ...omitUndefined(wsjf),
      value: wsjf.value,
      timeCriticality: wsjf.timeCriticality,
      riskOpportunity: wsjf.riskOpportunity,
      jobSize: wsjf.jobSize,
    },
  };
}

/**
 * Normalize a parsed `verification_evidence` field for spreading into an
 * UpdateTaskDTO. Like {@link normalizeWsjfWrite}, the Zod-parsed envelope's own
 * optional props (`checks`, `verifier_session_id`, …) are `T | undefined`,
 * which the exact-optional {@link VerificationEvidence} slots reject. The
 * absent / null / value three-state is preserved: absent → `{}` (column
 * untouched), `null` → clear, object → undefined-stripped (verdict required).
 */
function normalizeVerificationEvidence(evidence: VerificationEvidenceInput | null | undefined): {
  verification_evidence?: VerificationEvidence | null;
} {
  if (evidence === undefined) return {};
  if (evidence === null) return { verification_evidence: null };
  return {
    verification_evidence: {
      ...omitUndefined(evidence),
      verdict: evidence.verdict,
    },
  };
}

/**
 * Inputs for {@link TaskService.getCompletionReport}.
 *
 * One of `days` or both `start`/`end` must be provided. `start`/`end` are
 * inclusive ISO8601 timestamps; `days` is a count of trailing days ending now.
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
  priority: TaskPriority;
  created_at: string;
  completed_at: string;
  time_to_complete_seconds: number;
}

export interface CompletionReport {
  range: { start: string; end: string };
  total: number;
  rows: CompletionReportRow[];
  by_project: Array<{ project_id: number; count: number }>;
  by_assignee: Array<{ assignee: string; count: number }>;
  by_priority: Array<{ priority: TaskPriority; count: number }>;
  daily_throughput: Array<{ date: string; count: number }>;
}

/**
 * TaskService - handles task business logic, validation, and status lifecycle
 */
export class TaskService {
  /**
   * @param taskRepo   task data access.
   * @param projectRepo project data access.
   * @param db         WSJF (#628): optional better-sqlite3 handle. Supplied
   *   together with `wsjfHistoryRepo` so any WSJF component write and its
   *   append-only `wsjf_score_history` row commit in ONE transaction. Omitting
   *   it (pure service-unit tests, CLI report path) leaves the score-write
   *   behaviour unchanged but means no audit row is appended — see
   *   {@link wsjfAuditEnabled}.
   * @param wsjfHistoryRepo WSJF (#628): append-only history writer, paired with
   *   `db`. Must wrap the SAME connection as `taskRepo`.
   * @param dependencyService Task #1004: edge writer + validator for the atomic
   *   block-with-dependency path (`updateTask` with `blocked_by`). Optional for
   *   back-compat with the many shorter constructions; the `blocked_by` path
   *   requires BOTH this and `db` (one transaction spans the edge adds and the
   *   status write) and throws a clear BusinessError when either is missing.
   *   Must wrap the SAME connection as `taskRepo` (production wiring does).
   */
  constructor(
    private readonly taskRepo: ITaskRepository,
    private readonly projectRepo: IProjectRepository,
    private readonly db?: Database.Database,
    private readonly wsjfHistoryRepo?: IWsjfHistoryRepository,
    private readonly dependencyService?: DependencyService,
  ) {}

  /**
   * WSJF (#628): is the in-transaction audit hook wired? True only when BOTH a
   * db handle and a history repository were injected. When false the score
   * still persists (back-compat for 2-arg constructions) but no history row is
   * appended — the production wiring in `index.ts` always supplies both.
   */
  private wsjfAuditEnabled(): boolean {
    return this.db !== undefined && this.wsjfHistoryRepo !== undefined;
  }

  /**
   * WSJF (#628): the single in-transaction audit hook. Every component write
   * path funnels through here so NONE can bypass history. Computes the new
   * WSJF from the supplied components, appends one immutable
   * `wsjf_score_history` row, and returns nothing. Pure side-effect.
   *
   * Well-factored for sibling task #643 (manual override): callers pass the
   * `trigger` (`'create' | 'update' | 'manual' | ...`) and optional actor /
   * rescore-run linkage, so the manual path can reuse this verbatim with
   * `trigger='manual'` instead of duplicating the write.
   *
   * MUST be called inside the same `db.transaction(...)` as the component write
   * so the two commit atomically.
   */
  private appendWsjfHistory(args: {
    taskId: number;
    projectId: number;
    trigger: WsjfHistoryTrigger;
    wsjf: WsjfWriteDTO;
    prevWsjfScore: number | null;
    actorType?: string | null;
    actorId?: string | null;
    charterVersion?: number | null;
    rescoreRunId?: number | null;
  }): void {
    if (!this.wsjfHistoryRepo) return;
    const components: WsjfComponents = {
      value: args.wsjf.value,
      timeCriticality: args.wsjf.timeCriticality,
      riskOpportunity: args.wsjf.riskOpportunity,
      jobSize: args.wsjf.jobSize,
    };
    this.wsjfHistoryRepo.append({
      taskId: args.taskId,
      projectId: args.projectId,
      trigger: args.trigger,
      value: components.value,
      timeCriticality: components.timeCriticality,
      riskOpportunity: components.riskOpportunity,
      jobSize: components.jobSize,
      wsjfScore: computeWsjf(components),
      prevWsjfScore: args.prevWsjfScore,
      classifications: args.wsjf.classifications ?? null,
      features: args.wsjf.features ?? null,
      evidence: args.wsjf.evidence ?? null,
      source: args.wsjf.source ?? null,
      locked: args.wsjf.locked ?? null,
      actorType: args.actorType ?? null,
      actorId: args.actorId ?? null,
      charterVersion: args.charterVersion ?? args.wsjf.features?.charterVersion ?? null,
      rescoreRunId: args.rescoreRunId ?? null,
    });
  }

  /**
   * WSJF (#628): compute a task's current WSJF (the `prev_wsjf_score` for the
   * NEXT write) from its persisted components, or null when unscored. Reads the
   * four INTEGER columns off a freshly-read Task row.
   */
  private currentWsjfScore(
    task: Pick<
      Task,
      'wsjf_value' | 'wsjf_time_criticality' | 'wsjf_risk_opportunity' | 'wsjf_job_size'
    >,
  ): number | null {
    if (
      task.wsjf_value === null ||
      task.wsjf_time_criticality === null ||
      task.wsjf_risk_opportunity === null ||
      task.wsjf_job_size === null
    ) {
      return null;
    }
    return computeWsjf({
      value: task.wsjf_value as Fib,
      timeCriticality: task.wsjf_time_criticality as Fib,
      riskOpportunity: task.wsjf_risk_opportunity as Fib,
      jobSize: task.wsjf_job_size as Fib,
    });
  }

  /**
   * Guaranteed-task-sizing (#987, design spec §2/§3) — the SERVER-INTERNAL,
   * SIZE-ONLY WSJF write path. Sets `wsjf_job_size` + `wsjf_source.jobSize='auto'`
   * (all five other `source` slots also `'auto'`) while leaving the three
   * Cost-of-Delay component columns NULL, so the task becomes routable for
   * `resolve_model` yet stays honestly UNSCORED for WSJF ranking (no fabricated
   * value / time-criticality / risk).
   *
   * The column write and its append-only `auto_size` history row commit in ONE
   * `db.transaction(...)` — the #628 no-bypass invariant. The history row records
   * `jobSize` with the three CoD components NULL and `wsjfScore=null` (there is
   * no full WSJF without the numerator), `trigger='auto_size'` (or the caller's
   * override, e.g. `'boot_sweep'` for the §5 backfill).
   *
   * This method is NOT reachable from `CreateTaskClientSchema` / `WsjfWriteSchema`
   * input — those reject a size-only payload (all four components required). It
   * is intentionally a server-only entry point: the downstream auto-size-on-create
   * (#989), update recompute (#991), boot sweep (#992), and health finding (#993)
   * tasks all call THIS helper rather than smuggling a half-scored payload through
   * the client gates.
   *
   * When the audit hook is NOT wired (a 2-arg `TaskService` construction with no
   * `db` / history repo) the size still persists via the repository, but no
   * history row is appended — back-compat parity with the create/update paths.
   *
   * @param args.taskId    the task to size.
   * @param args.jobSize   the Fibonacci tier (the caller maps `estimated_minutes`
   *                        via {@link minutesToTier} from `wsjf.service`).
   * @param args.trigger   history trigger; defaults to `'auto_size'`. Boot-sweep
   *                        callers (#992) pass `'boot_sweep'`.
   * @param args.actorType / args.actorId  optional provenance for the audit row.
   * @returns the updated task row (with tags).
   */
  autoSizeTask(args: {
    taskId: number;
    jobSize: Fib;
    trigger?: WsjfHistoryTrigger;
    actorType?: string | null;
    actorId?: string | null;
  }): Task & { tags: string[] } {
    const existing = this.taskRepo.findById(args.taskId);
    if (!existing) {
      throw new NotFoundError('Task', args.taskId);
    }
    // Provenance: a size-only auto write stamps EVERY `source` slot 'auto'. The
    // three CoD components are NULL, so their provenance is moot, but the map's
    // shape (Record<WsjfComponentKey, ...>) requires all four keys; 'auto' is
    // the honest value (server-derived, no human input).
    const source: WsjfSource = {
      value: 'auto',
      timeCriticality: 'auto',
      riskOpportunity: 'auto',
      jobSize: 'auto',
    };
    const trigger: WsjfHistoryTrigger = args.trigger ?? 'auto_size';

    if (this.wsjfAuditEnabled()) {
      // prev_wsjf_score is the task's WSJF BEFORE this write — null whenever the
      // task is not fully scored (the normal case for an auto-size target), and
      // the real ratio if a classified score somehow precedes the auto write.
      const prevWsjfScore = this.currentWsjfScore(existing);
      return this.db!.transaction(() => {
        const updated = this.taskRepo.writeAutoJobSize(args.taskId, args.jobSize, source);
        // Size-only history row: CoD components NULL, jobSize set, no full score.
        this.wsjfHistoryRepo!.append({
          taskId: updated.id,
          projectId: updated.project_id,
          trigger,
          value: null,
          timeCriticality: null,
          riskOpportunity: null,
          jobSize: args.jobSize,
          wsjfScore: null,
          prevWsjfScore,
          source,
          actorType: args.actorType ?? null,
          actorId: args.actorId ?? null,
        });
        return updated;
      })();
    }
    return this.taskRepo.writeAutoJobSize(args.taskId, args.jobSize, source);
  }

  /**
   * Guaranteed-task-sizing (design §4): minutes-vs-jobSize conflict gate for
   * RAW wsjf writes. When a create/update carries BOTH an `estimated_minutes`
   * and a raw `wsjf` payload bearing a jobSize, reject iff
   * `minutesToTier(estimated_minutes)` lands on a DIFFERENT tier than
   * `wsjf.jobSize` — naming both values. "Conflict" means a different tier
   * after mapping (45 vs 60 min both map to tier 3 and must NOT error), never
   * different raw numbers.
   *
   * The gate deliberately does NOT apply to `wsjf_submission` classifications.
   * Those arrive at this service already converted to a WriteDTO by
   * `submissionToWsjfWrite` (src/mcp/tools/task-tools.ts), which stamps an
   * all-`'auto'` `source` map (`source.jobSize === 'auto'`) — the only
   * service-visible signal distinguishing a submission/auto-sized write from a
   * raw/manual/pre-computed one. A classification is evidence-backed judgment
   * (already validated by the `jobSizeBand` clamp) and legitimately pairs a
   * short `estimated_minutes` with a band-chosen high tier, so it outranks the
   * minutes prior. A raw write (no `source`, or `source.jobSize !== 'auto'`)
   * is the manual/pre-computed path the gate guards.
   *
   * No-op when `estimated_minutes` is absent (nothing to compare) or when no
   * raw `wsjf` jobSize is present.
   *
   * @param estimatedMinutes the create/update `estimated_minutes` (or absent).
   * @param wsjf             the normalized WSJF WriteDTO for this write (or null).
   */
  private assertMinutesTierConsistency(
    estimatedMinutes: number | null | undefined,
    wsjf: WsjfWriteDTO | null | undefined,
  ): void {
    // Nothing to compare without both a minutes estimate and a raw jobSize.
    if (estimatedMinutes === undefined || estimatedMinutes === null) return;
    if (wsjf === undefined || wsjf === null) return;
    // Exempt submission-derived / auto-sized writes: their jobSize is an
    // evidence-backed (or server-computed) judgment, marked `source.jobSize='auto'`.
    if (wsjf.source?.jobSize === 'auto') return;
    const minutesTier = minutesToTier(estimatedMinutes);
    if (minutesTier !== wsjf.jobSize) {
      throw new ValidationError({
        wsjf: [
          `estimated_minutes ${estimatedMinutes} maps to job-size tier ${minutesTier}, ` +
            `but the supplied wsjf.jobSize is ${wsjf.jobSize}. These disagree: ` +
            `either correct estimated_minutes so minutesToTier matches the tier, ` +
            `or set wsjf.jobSize to ${minutesTier}.`,
        ],
      });
    }
  }

  /**
   * Create a new task with validation
   * Tasks always start with status 'open' regardless of input
   */
  createTask(input: unknown): Task & { tags: string[] } {
    // Validate input
    const result = CreateTaskSchema.safeParse(input);
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      result.error.issues.forEach((err) => {
        const field = err.path.join('.');
        if (!fieldErrors[field]) {
          fieldErrors[field] = [];
        }
        fieldErrors[field].push(err.message);
      });
      throw new ValidationError(fieldErrors);
    }

    // Guaranteed-task-sizing (design §1, Prong A): server-side decompose
    // contract gate. A `decomp-*` tag is the marker the decompose skill stamps
    // on every materialized leaf; carrying it without a `wsjf_submission` means
    // the skill skipped Step 8 sizing and would mint a sizeless task — the exact
    // failure class that produced the 114 sizeless Tiny Worlds tasks and silently
    // degraded model routing. Reject it as a contract violation (422-class) on
    // EVERY surface (stdio MCP, remote MCP, REST) because they all funnel through
    // here. The MCP/REST layers convert `wsjf_submission` → the `wsjf` WriteDTO
    // before reaching the service, so a non-null `wsjf` payload IS the evidence
    // that a submission was made; its absence is the violation. The error names
    // the offending tag and instructs the caller to re-run decompose Step 8 with
    // a `wsjf_submission` (mirrors the WFT_STRICT_EVIDENCE teaching-rejection).
    const decompTag = result.data.tags.find((tag) => tag.startsWith('decomp-'));
    if (decompTag !== undefined && (result.data.wsjf === undefined || result.data.wsjf === null)) {
      throw new ValidationError({
        wsjf_submission: [
          `Task carries the decompose tag '${decompTag}' but no 'wsjf_submission'. ` +
            `Decompose-materialized tasks MUST be sized: re-run decompose Step 8 to ` +
            `produce a 'wsjf_submission' for this task before creating it.`,
        ],
      });
    }

    // Verify project exists
    const project = this.projectRepo.findById(result.data.project_id);
    if (!project) {
      throw new BusinessError(`Project with id ${result.data.project_id} does not exist`);
    }

    // Validate parent_task_id if provided
    if (result.data.parent_task_id) {
      const parentTask = this.taskRepo.findById(result.data.parent_task_id);
      if (!parentTask) {
        throw new BusinessError(`Parent task with id ${result.data.parent_task_id} does not exist`);
      }

      // Ensure parent task is in the same project
      if (parentTask.project_id !== result.data.project_id) {
        throw new BusinessError('Parent task must be in the same project');
      }
    }

    // Create task with status forced to 'open'.
    //
    // WSJF (#628): when the create carries a WSJF score AND the audit hook is
    // wired, the component write and the append-only history row MUST commit
    // together. Wrap both in ONE `db.transaction(...)` so no component write
    // can land without its `wsjf_score_history` row (the no-bypass invariant).
    // A brand-new task has no prior score, so `prev_wsjf_score` is null and the
    // trigger is `create`. The unscored / audit-disabled paths take the plain
    // single write — behaviour identical to before #628.
    // Assemble the CreateTaskDTO. `omitUndefined` drops optional props whose
    // parsed value is `undefined` (key absent) so their columns stay untouched,
    // while explicit `null` (clear) and real values survive — the
    // absent / null / value three-state convention CreateTaskDTO encodes. The
    // required fields are re-stated explicitly so they keep their non-optional
    // type after the all-optional `omitUndefined` spread. `wsjf` is pulled out
    // before the spread and re-added via `normalizeWsjfWrite` because its OWN
    // nested optional props are `T | undefined` (Zod) and the shallow
    // `omitUndefined` would not strip them.
    const { wsjf: parsedWsjf, ...createRest } = result.data;
    const createDto: CreateTaskDTO = {
      ...omitUndefined(createRest),
      title: result.data.title,
      status: 'open' as const,
      priority: result.data.priority,
      project_id: result.data.project_id,
      created_by: result.data.created_by,
      ...normalizeWsjfWrite(parsedWsjf),
    };
    const wsjf = (createDto.wsjf ?? null) as WsjfWriteDTO | null;
    // Guaranteed-task-sizing (design §4): reject a raw wsjf write whose jobSize
    // disagrees (after minutesToTier mapping) with estimated_minutes. Exempts
    // submission-derived writes (source.jobSize === 'auto').
    this.assertMinutesTierConsistency(result.data.estimated_minutes, wsjf);
    // WSJF (#643): a manual override on create runs the same manual gate as
    // update_task (enum + shared contradiction rule, no classification needed)
    // and audits with `trigger='manual'`; an auto create keeps `trigger='create'`.
    if (wsjf && wsjf.manual === true) {
      const manualCheck = validateManualScore({
        value: wsjf.value,
        timeCriticality: wsjf.timeCriticality,
        riskOpportunity: wsjf.riskOpportunity,
        jobSize: wsjf.jobSize,
      });
      if (!manualCheck.ok) {
        throw new ValidationError({ wsjf: manualCheck.errors });
      }
    }
    // WSJF (#634): trigger precedence — a manual override ALWAYS stamps
    // 'manual'; otherwise an explicit generic `wsjf.trigger` hint
    // (e.g. 'single_create' from create_task, 'decompose' from #633) wins;
    // absent that, the auto create path defaults to 'create'.
    const createTrigger: WsjfHistoryTrigger =
      wsjf?.manual === true ? 'manual' : (wsjf?.trigger ?? 'create');
    let task: Task & { tags: string[] };
    if (wsjf && this.wsjfAuditEnabled()) {
      task = this.db!.transaction(() => {
        const created = this.taskRepo.create(createDto, result.data.tags);
        this.appendWsjfHistory({
          taskId: created.id,
          projectId: created.project_id,
          trigger: createTrigger,
          wsjf,
          prevWsjfScore: null,
        });
        return created;
      })();
    } else {
      task = this.taskRepo.create(createDto, result.data.tags);
    }

    // Guaranteed-task-sizing (design §2/§3, #989): the core guarantee — every
    // new task is immediately routable by `ModelPolicy.byCategory`. A create
    // carrying NEITHER a raw `wsjf` payload NOR a `wsjf_submission` (both arrive
    // at the service as a non-null `wsjf` WriteDTO — the MCP/REST layers convert
    // `wsjf_submission` → `wsjf` before reaching here, and the Prong-A gate above
    // already rejected the decompose-tag-without-submission case) is auto-sized
    // through the SIZE-ONLY {@link autoSizeTask} path (#987): tier =
    // `minutesToTier(estimated_minutes)`, which deterministically returns the
    // §3 tier-3 residual default when `estimated_minutes` is absent. This writes
    // `wsjf_job_size` + `wsjf_source.jobSize='auto'` (CoD components stay NULL)
    // plus an `auto_size` history row in ONE transaction — an immediate
    // size-only follow-up to the insert, NOT a half-scored payload smuggled
    // through the client gates. We re-read through the helper so the
    // `task.created` event below carries the sized row, not the sizeless insert.
    if (wsjf === null) {
      task = this.autoSizeTask({
        taskId: task.id,
        jobSize: minutesToTier(result.data.estimated_minutes),
      });
    }

    // Emit task.created event after successful database operation
    eventBus.emit('task.created', {
      eventType: 'task.created',
      timestamp: new Date().toISOString(),
      data: task,
      metadata: { source: 'user' },
    });

    return task;
  }

  /**
   * WSJF (#644): derive the VALUE prior a derived task (subtask or decompose
   * child) inherits from its parent. The subtask creation path and the
   * `decompose` batch-scoring flow call this BEFORE scoring a child: the child
   * inherits the parent's value-theme mapping (`themeName`) + Business-Value
   * (UBV) tier, while its OBJECTIVE components (time-criticality, risk/
   * opportunity, job-size) are scored FRESH from the child's own deadline, DAG
   * fan-out, and scope — never copied from the parent. When the parent's value
   * was human-set (`wsjf_source.value === 'manual'`) the prior is flagged
   * `humanAnchored` so it is visible as a pinned human anchor (design spec
   * §8.5).
   *
   * Returns `null` when the parent does not exist or is unscored (no value to
   * propagate) — the child is then scored entirely fresh. The work is delegated
   * to the pure {@link derivePropagatedValuePrior} so the rule lives once in the
   * WSJF substrate and both creation paths reuse it.
   */
  derivePropagatedValuePrior(parentTaskId: number): PropagatedValuePrior | null {
    const parent = this.taskRepo.findById(parentTaskId);
    if (!parent) return null;
    return derivePropagatedValuePrior(parent);
  }

  /**
   * Get task by ID
   *
   * Task #1003: for tasks holding an active claim (`in_progress` + assignee
   * + claimed_at), the response additionally carries `claim_ttl_minutes` and
   * `claim_remaining_seconds` (computed at read time, never stored) so
   * `get_task` consumers can see when the ClaimReleaseService sweep will
   * auto-release the claim — and renew (same-assignee `claim_task`) before
   * it does.
   */
  getTask(id: number): Task & { tags: string[] } {
    const task = this.taskRepo.findById(id);
    if (!task) {
      throw new NotFoundError('Task', id);
    }
    return withClaimTtl(task);
  }

  /**
   * List tasks with optional filtering.
   *
   * Returns a plain array of the current page — callers who need the
   * paginated envelope (with `total` for client-side pagination UIs) should
   * use {@link listTasksPaginated} instead. This shape is preserved for the
   * many internal callers (workflow engine, MCP tools) that don't need the
   * envelope and only care about the rows.
   */
  listTasks(filters?: unknown): Array<Task & { tags: string[] }> {
    const parsed = this.parseFilters(filters);
    try {
      return this.taskRepo.findByFilters(omitUndefined(parsed));
    } catch (err) {
      if (err instanceof FtsSyntaxError) {
        throw ftsValidationError();
      }
      throw err;
    }
  }

  /**
   * Paginated list-tasks: returns `{ data, total, limit, offset }`.
   *
   * `total` is the unbounded match count for the same filter set so clients
   * can render "page X of Y" navigation without re-issuing the query without
   * filters. Used by the REST list endpoint and the MCP list_tasks tool.
   */
  listTasksPaginated(filters?: unknown): PaginatedResponse<Task & { tags: string[] }> {
    const parsed = this.parseFilters(filters);
    const limit = parsed.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = parsed.offset ?? DEFAULT_PAGE_OFFSET;
    try {
      const data = this.taskRepo.findByFilters({ ...omitUndefined(parsed), limit, offset });
      // `count` deliberately runs WITHOUT limit/offset so `total` reflects
      // the full match set.
      const { limit: _l, offset: _o, ...filtersForCount } = parsed;
      const total = this.taskRepo.count(omitUndefined(filtersForCount));
      return { data, total, limit, offset };
    } catch (err) {
      if (err instanceof FtsSyntaxError) {
        throw ftsValidationError();
      }
      throw err;
    }
  }

  private parseFilters(filters?: unknown) {
    if (filters === undefined) return {};
    const result = TaskFiltersSchema.safeParse(filters);
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      result.error.issues.forEach((err) => {
        const field = err.path.join('.');
        if (!fieldErrors[field]) {
          fieldErrors[field] = [];
        }
        fieldErrors[field].push(err.message);
      });
      throw new ValidationError(fieldErrors);
    }
    return result.data;
  }

  /**
   * Update task with status lifecycle validation
   */
  updateTask(
    id: number,
    input: unknown,
    source: 'user' | 'workflow' = 'user',
    callerId?: string | number | null,
  ): Task & { tags: string[] } {
    // Validate input
    const result = UpdateTaskSchema.safeParse(input);
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      result.error.issues.forEach((err) => {
        const field = err.path.join('.');
        if (!fieldErrors[field]) {
          fieldErrors[field] = [];
        }
        fieldErrors[field].push(err.message);
      });
      throw new ValidationError(fieldErrors);
    }

    // Task #1004: narrow semantics — `blocked_by` is ONLY meaningful as part of
    // an atomic block-with-dependency. Supplying it without `status: 'blocked'`
    // is a validation error rather than a silent edge-add, so the affordance
    // cannot be half-used (the failure class it exists to kill is a blocked
    // status without an edge; the inverse — edges added under a non-blocked
    // status — would be a different, unintended operation).
    if (result.data.blocked_by !== undefined && result.data.status !== 'blocked') {
      throw new ValidationError({
        blocked_by: [
          "blocked_by is only valid together with status: 'blocked'. " +
            'To add dependency edges without blocking, use the dependency surface ' +
            '(add_dependency / dep-add) instead.',
        ],
      });
    }

    // Fetch existing task
    const existing = this.taskRepo.findById(id);
    if (!existing) {
      throw new NotFoundError('Task', id);
    }

    // task #608 (PIECE A): server-side anti-fabrication validation of
    // verification_evidence, gated behind WFT_STRICT_EVIDENCE (default OFF).
    // Runs only when the flag is on AND the update supplies a non-null
    // verification_evidence. The trailing `callerId` mirrors the
    // additive-positional precedent set by claimTask's assigneeUserId — all
    // existing callers (which omit it) are unaffected. On any violation we
    // throw the SAME ValidationError the service uses for Zod failures.
    //
    // The gate reads `process.env.WFT_STRICT_EVIDENCE` directly (matching the
    // env schema's `v === 'true'` transform) rather than the `config` Proxy:
    // touching the Proxy eagerly runs `loadConfig()`, which validates the
    // whole environment (including the required `API_KEYS`). Pure service-
    // layer tests never set `API_KEYS`, so a Proxy access in this hot path
    // would break the existing suite. A direct env read keeps the default-OFF
    // path zero-cost and side-effect-free.
    if (
      process.env['WFT_STRICT_EVIDENCE'] === 'true' &&
      result.data.verification_evidence !== undefined &&
      result.data.verification_evidence !== null
    ) {
      // `assignee_user_id` is selected by `findById` (SELECT t.*) but is not
      // declared on the base Task type, so read it through a narrow cast.
      const existingAssigneeUserId = (existing as { assignee_user_id?: number | null })
        .assignee_user_id;
      const evidence: VerificationEvidence = {
        ...omitUndefined(result.data.verification_evidence),
        verdict: result.data.verification_evidence.verdict,
      };
      const violations = validateVerificationEvidence(evidence, {
        taskAssignee: existing.assignee,
        taskAssigneeUserId: existingAssigneeUserId ?? null,
        callerId: callerId ?? null,
      });
      if (violations.length > 0) {
        throw new ValidationError({ verification_evidence: violations });
      }
    }

    // Validate status transition if status is being changed.
    //
    // `nextStatus` captures the narrowed new status (a defined `TaskStatus`)
    // so the `task.status_changed` emit below can populate the exact-optional
    // `EventMetadata.to` field without TS widening it back to
    // `TaskStatus | undefined` (which exactOptionalPropertyTypes rejects).
    const nextStatus: TaskStatus | undefined =
      result.data.status && result.data.status !== existing.status ? result.data.status : undefined;
    const statusChanged = nextStatus !== undefined;
    if (statusChanged) {
      const validTargets = VALID_STATUS_TRANSITIONS[existing.status];
      if (!validTargets.includes(result.data.status!)) {
        throw new BusinessError(
          `Invalid status transition from '${existing.status}' to '${result.data.status}'. Valid transitions: ${validTargets.join(', ')}`,
        );
      }
    }

    // Wave 1.4 (#312): when a task transitions to a closing status (done or
    // closed) AND the caller did not supply explicit verification_evidence
    // AND the row currently has no evidence, materialize the explicit
    // "no one verified this" marker so the column carries intent rather
    // than NULL ambiguity.
    //
    // Why only on the close transitions:
    //  - Other transitions (in_progress, blocked, backlogged, open) do not
    //    represent a verification opportunity. Stamping NOT_VERIFIED there
    //    would falsely imply a verifier looked at the task.
    //  - `existing.verification_evidence === null` guards against clobbering
    //    a real previous verdict if the task is reopened and re-closed; the
    //    historical PASS/FAIL stays put.
    //
    // We deliberately set ONLY the verdict — no verified_at timestamp, no
    // verifier_session_id — so the row reflects truthfully that nothing
    // was checked.
    // Build the repo patch. `omitUndefined` drops top-level keys whose parsed
    // value is `undefined` (key absent → column untouched), preserving the
    // absent / null / value three-state convention. The nested `wsjf` field is
    // normalized separately because its OWN optional props are `T | undefined`
    // (Zod) and the exact-optional `WsjfWriteDTO` slots reject explicit
    // `undefined`.
    const {
      wsjf: parsedWsjfUpdate,
      verification_evidence: parsedEvidenceUpdate,
      // Task #1004: blocked_by is NOT a task column — it drives the atomic
      // edge-add below and must not leak into the repository patch.
      blocked_by: parsedBlockedBy,
      ...updateRest
    } = result.data;
    const updatesForRepo: UpdateTaskDTO = {
      ...omitUndefined(updateRest),
      ...normalizeWsjfWrite(parsedWsjfUpdate),
      ...normalizeVerificationEvidence(parsedEvidenceUpdate),
    };
    const isClosingTransition =
      statusChanged && (result.data.status === 'done' || result.data.status === 'closed');
    if (
      isClosingTransition &&
      result.data.verification_evidence === undefined &&
      existing.verification_evidence === null
    ) {
      updatesForRepo.verification_evidence = { verdict: 'NOT_VERIFIED' };
    }

    // Update task.
    //
    // WSJF (#628): when the update writes a WSJF score (a non-null `wsjf`
    // object) AND the audit hook is wired, the component write and its
    // append-only history row commit in ONE `db.transaction(...)` — the same
    // no-bypass invariant as create. `prev_wsjf_score` is the task's WSJF
    // BEFORE this write (null if it was previously unscored), read off the
    // `existing` row we already loaded above. Clearing the score (`wsjf: null`)
    // is not a component-value write, so it appends no history row.
    const wsjfUpdate = result.data.wsjf as WsjfWriteDTO | null | undefined;
    // Guaranteed-task-sizing (design §4): same minutes-vs-jobSize conflict gate
    // on the update raw-wsjf path. Compares the update's own `estimated_minutes`
    // against a raw `wsjf.jobSize`; exempts submission-derived writes
    // (source.jobSize === 'auto').
    this.assertMinutesTierConsistency(result.data.estimated_minutes, wsjfUpdate);
    // WSJF (#643): a manual override (`wsjf.manual === true`) skips the
    // classification/evidence requirement but MUST still pass the manual gate —
    // enum membership + the SHARED contradiction rule (jobSize=1 ∧ value=13 →
    // reject). `validateManualScore` reuses #626's contradiction logic verbatim.
    // The history row is stamped `trigger='manual'`; an auto write keeps
    // `trigger='update'`.
    if (wsjfUpdate !== undefined && wsjfUpdate !== null && wsjfUpdate.manual === true) {
      const manualCheck = validateManualScore({
        value: wsjfUpdate.value,
        timeCriticality: wsjfUpdate.timeCriticality,
        riskOpportunity: wsjfUpdate.riskOpportunity,
        jobSize: wsjfUpdate.jobSize,
      });
      if (!manualCheck.ok) {
        throw new ValidationError({ wsjf: manualCheck.errors });
      }
    }
    const wsjfTrigger: WsjfHistoryTrigger = wsjfUpdate?.manual === true ? 'manual' : 'update';
    const performWrite = (): Task & { tags: string[] } => {
      if (wsjfUpdate !== undefined && wsjfUpdate !== null && this.wsjfAuditEnabled()) {
        const prevWsjfScore = this.currentWsjfScore(existing);
        return this.db!.transaction(() => {
          const updated = this.taskRepo.update(id, updatesForRepo);
          this.appendWsjfHistory({
            taskId: updated.id,
            projectId: updated.project_id,
            trigger: wsjfTrigger,
            wsjf: wsjfUpdate,
            prevWsjfScore,
          });
          return updated;
        })();
      }
      return this.taskRepo.update(id, updatesForRepo);
    };
    let updatedTask: Task & { tags: string[] };
    if (parsedBlockedBy !== undefined) {
      // Task #1004: atomic block-with-dependency. The dependency edges and the
      // status write commit in ONE transaction — all-or-nothing. Any invalid
      // edge (nonexistent blocker → NotFoundError, self-reference →
      // ValidationError, cycle → BusinessError) throws inside the transaction
      // and rolls back EVERYTHING, so a blocked status can never land without
      // its edge and no partial edge set can land without the status.
      //
      // Validation is the DependencyService's — `addDependency` runs the
      // existence / self / cycle checks per edge (no duplicated cycle logic
      // here). Edges that already exist are skipped (idempotent re-block, e.g.
      // appending a second blocker to an already-blocked task).
      if (!this.dependencyService || !this.db) {
        throw new BusinessError(
          'blocked_by requires the transactional wiring (db + DependencyService) ' +
            'that production boot supplies. This TaskService was constructed without it.',
        );
      }
      const blockerIds = [...new Set(parsedBlockedBy)];
      updatedTask = this.db.transaction(() => {
        const alreadyBlocking = new Set(
          this.dependencyService!.getBlockers(id).map((d) => d.task_id),
        );
        for (const blockerId of blockerIds) {
          if (alreadyBlocking.has(blockerId)) continue;
          this.dependencyService!.addDependency({ task_id: blockerId, blocks_task_id: id });
        }
        return performWrite();
      })();
    } else {
      updatedTask = performWrite();
    }

    // Emit task.updated event after successful database operation
    eventBus.emit('task.updated', {
      eventType: 'task.updated',
      timestamp: new Date().toISOString(),
      data: updatedTask,
      metadata: { source },
    });

    // If status changed, also emit task.status_changed event. Gating on
    // `nextStatus !== undefined` (rather than the boolean `statusChanged`)
    // narrows `nextStatus` to a defined `TaskStatus` so the exact-optional
    // `EventMetadata.to` is satisfied without a cast.
    if (nextStatus !== undefined) {
      eventBus.emit('task.status_changed', {
        eventType: 'task.status_changed',
        timestamp: new Date().toISOString(),
        data: updatedTask,
        metadata: {
          source,
          from: existing.status,
          to: nextStatus,
        },
      });
    }

    return updatedTask;
  }

  /**
   * Delete task
   */
  deleteTask(id: number): void {
    // Verify task exists
    const existing = this.taskRepo.findById(id);
    if (!existing) {
      throw new NotFoundError('Task', id);
    }

    // Emit task.deleted event BEFORE deletion so consumers can still query related entities
    eventBus.emit('task.deleted', {
      eventType: 'task.deleted',
      timestamp: new Date().toISOString(),
      data: existing,
      metadata: { source: 'user' },
    });

    this.taskRepo.delete(id);
  }

  /**
   * Count tasks with optional filtering
   */
  countTasks(filters?: unknown): number {
    // If filters provided, validate them
    if (filters !== undefined) {
      const result = TaskFiltersSchema.safeParse(filters);
      if (!result.success) {
        const fieldErrors: Record<string, string[]> = {};
        result.error.issues.forEach((err) => {
          const field = err.path.join('.');
          if (!fieldErrors[field]) {
            fieldErrors[field] = [];
          }
          fieldErrors[field].push(err.message);
        });
        throw new ValidationError(fieldErrors);
      }
      try {
        return this.taskRepo.count(omitUndefined(result.data));
      } catch (err) {
        if (err instanceof FtsSyntaxError) {
          throw ftsValidationError();
        }
        throw err;
      }
    }

    return this.taskRepo.count();
  }

  /**
   * Search tasks by text (convenience method)
   */
  searchTasks(query: string): Array<Task & { tags: string[] }> {
    return this.listTasks({ search: query });
  }

  /**
   * Claim a task atomically for an agent
   * Uses CAS (Compare-And-Swap) pattern with BEGIN IMMEDIATE for SQLite concurrency safety
   */
  claimTask(
    taskId: number,
    assignee: string,
    source: 'user' | 'workflow' = 'user',
    assigneeUserId?: number | null,
  ): Task & { tags: string[] } {
    // Phase 31 (Plan 31-01): the trailing `assigneeUserId` mirrors the
    // additive-positional precedent set by `source`. All existing 3-arg
    // callers continue to work; the repository binds NULL when undefined.
    // Validate task exists
    const existing = this.taskRepo.findById(taskId);
    if (!existing) {
      throw new NotFoundError('Task', taskId);
    }

    // Task #1003: claim RENEWAL (heartbeat). A claim_task call by the SAME
    // assignee on a task they already hold in_progress refreshes claimed_at
    // — extending the ClaimReleaseService TTL window — and returns success
    // instead of the already-claimed conflict. A DIFFERENT assignee still
    // falls through to the existing 409-equivalent errors below. This keeps
    // the renewal affordance on the existing tool surface (stdio MCP,
    // remote MCP, REST, CLI all flow through this method) without adding a
    // new MCP tool.
    if (existing.status === 'in_progress' && existing.assignee === assignee) {
      const renewed = this.taskRepo.renewClaim(taskId, assignee);
      if (!renewed) {
        // Raced: the claim lapsed (sweep released it) or changed hands
        // between our read and the renewal UPDATE.
        throw new BusinessError(
          `Task ${taskId} claim could not be renewed (claim changed concurrently)`,
        );
      }
      eventBus.emit('task.claimed', {
        eventType: 'task.claimed',
        timestamp: new Date().toISOString(),
        data: renewed,
        metadata: { source },
      });
      return renewed;
    }

    // Validate task is in claimable state
    if (existing.status !== 'open') {
      throw new BusinessError(
        `Task ${taskId} cannot be claimed: status is '${existing.status}', must be 'open'`,
      );
    }

    if (existing.assignee) {
      throw new BusinessError(`Task ${taskId} is already claimed by '${existing.assignee}'`);
    }

    // Attempt atomic claim via repository
    const claimed = this.taskRepo.claimTask(taskId, assignee, assigneeUserId ?? null);
    if (!claimed) {
      // CAS failed - another agent claimed it between our check and the update
      throw new BusinessError(`Task ${taskId} is already claimed (concurrent claim detected)`);
    }

    // Emit task.claimed event after successful claim
    eventBus.emit('task.claimed', {
      eventType: 'task.claimed',
      timestamp: new Date().toISOString(),
      data: claimed,
      metadata: { source },
    });

    return claimed;
  }

  /**
   * Get a completion report for tasks transitioned to 'done' inside a range.
   *
   * Accepts either `days` (trailing N days from now) or explicit `start`/`end`
   * ISO8601 bounds. Both bounds are inclusive.
   */
  getCompletionReport(input: unknown): CompletionReport {
    const parsed = CompletionReportSchema.safeParse(input);
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      parsed.error.issues.forEach((err) => {
        const field = err.path.join('.') || '_';
        if (!fieldErrors[field]) fieldErrors[field] = [];
        fieldErrors[field].push(err.message);
      });
      throw new ValidationError(fieldErrors);
    }

    const { start, end } = resolveRange(omitUndefined(parsed.data));
    // start/end stay required; project_id/assignee are omitted when absent so
    // the range filter only narrows on the dimensions the caller supplied.
    const tasks = this.taskRepo.findCompletedInRange({
      start,
      end,
      ...omitUndefined({
        project_id: parsed.data.project_id,
        assignee: parsed.data.assignee,
      }),
    });

    const rows: CompletionReportRow[] = tasks.map((t) => {
      const completedAt = t.completed_at ?? t.updated_at;
      const startMs = Date.parse(t.created_at);
      const endMs = Date.parse(completedAt);
      const seconds =
        Number.isFinite(startMs) && Number.isFinite(endMs)
          ? Math.max(0, Math.round((endMs - startMs) / 1000))
          : 0;
      return {
        id: t.id,
        title: t.title,
        project_id: t.project_id,
        project_name: t.project_name,
        assignee: t.assignee,
        priority: t.priority,
        created_at: t.created_at,
        completed_at: completedAt,
        time_to_complete_seconds: seconds,
      };
    });

    return {
      range: { start, end },
      total: rows.length,
      rows,
      by_project: aggregate(rows, (r) => r.project_id).map(([k, v]) => ({
        project_id: k as number,
        count: v,
      })),
      by_assignee: aggregate(rows, (r) => r.assignee ?? '(unassigned)').map(([k, v]) => ({
        assignee: k as string,
        count: v,
      })),
      by_priority: aggregate(rows, (r) => r.priority).map(([k, v]) => ({
        priority: k as TaskPriority,
        count: v,
      })),
      daily_throughput: aggregate(rows, (r) => r.completed_at.slice(0, 10)).map(([k, v]) => ({
        date: k as string,
        count: v,
      })),
    };
  }

  /**
   * Get subtasks (children) of a parent task — current page only.
   *
   * Internal callers that need the array directly use this. The REST/MCP
   * surfaces should use {@link getSubtasksPaginated} so clients get the
   * envelope with `total` and can iterate pages.
   */
  getSubtasks(
    taskId: number,
    pagination?: { limit?: number; offset?: number },
  ): Array<Task & { tags: string[] }> {
    // Verify parent task exists
    const parentTask = this.taskRepo.findById(taskId);
    if (!parentTask) {
      throw new NotFoundError('Task', taskId);
    }

    return this.taskRepo.findChildren(taskId, pagination);
  }

  /**
   * Paginated subtasks: `{ data, total, limit, offset }`. Same envelope as
   * the rest of the list endpoints.
   */
  getSubtasksPaginated(
    taskId: number,
    pagination?: { limit?: number; offset?: number },
  ): PaginatedResponse<Task & { tags: string[] }> {
    const parentTask = this.taskRepo.findById(taskId);
    if (!parentTask) {
      throw new NotFoundError('Task', taskId);
    }
    const limit = pagination?.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = pagination?.offset ?? DEFAULT_PAGE_OFFSET;
    const data = this.taskRepo.findChildren(taskId, { limit, offset });
    const total = this.taskRepo.countChildren(taskId);
    return { data, total, limit, offset };
  }
}

/**
 * Resolve a CompletionReport request into concrete inclusive ISO8601 bounds.
 *
 * `days` -> [now - days, now]. Otherwise uses the provided start/end.
 * The schema layer guarantees one form is present and bounds are well-formed.
 */
function resolveRange(input: CompletionReportInput): { start: string; end: string } {
  if (input.days !== undefined) {
    const end = new Date();
    const start = new Date(end.getTime() - input.days * 24 * 60 * 60 * 1000);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  return { start: input.start!, end: input.end! };
}

function aggregate<T, K extends string | number>(
  rows: T[],
  key: (row: T) => K,
): Array<[K, number]> {
  const counts = new Map<K, number>();
  for (const row of rows) {
    const k = key(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : String(a[0]).localeCompare(String(b[0])),
  );
}
