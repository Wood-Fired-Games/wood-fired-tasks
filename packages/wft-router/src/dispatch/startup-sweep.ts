/**
 * Cold-start sweep for the wft-router (task #1005).
 *
 * Wake-on-work rules fire on live events (`task.created`, blocked→open
 * transitions). A backlog that PREDATES the router wiring — or events missed
 * while the router was down (nothing is replayed past the in-memory resume
 * position) — therefore never kicks anyone. This module supplies the router-side fix: an
 * OPT-IN, one-shot startup sweep that queries the server's task-list REST API
 * for OPEN tasks matching a rule's `where:` predicate and, when any match,
 * lets the daemon synthesize AT MOST ONE dispatch per rule through the SAME
 * machinery as a live event (debounce → rate-limit → handler → idempotency
 * claim). There is no parallel dispatch path here — this module only finds
 * the first matching open task and mints the deterministic sweep identity.
 *
 * Sweep event identity (documented contract):
 *
 *     event_id = `sweep:<rule_name>:<bucket>`
 *     bucket   = floor(now_ms / (idempotency_window_s * 1000))
 *
 * The idempotency store's primary key is `(rule_name, event_id)` and rows are
 * durable, so a SECOND router start inside the same window mints the SAME
 * event_id, the handler's `store.claim(...)` returns ALREADY_DONE (or
 * ALREADY_PENDING), and the dispatch is SUPPRESSED — zero kicks. Once the
 * window bucket rolls, a genuinely later sweep mints a fresh event_id and may
 * kick again. An `idempotency_window_s` of 0 disables sweep dedup (bucket =
 * now_ms, unique per start).
 *
 * Predicate fidelity: each candidate task row is mapped onto the live
 * {@link EventPayloadShape} and evaluated with the SAME `evaluateWhere` the
 * live pipeline uses. The synthesized payload carries `metadata.to` = the
 * task's (open) status — an open backlog item is treated "as if it just
 * arrived at open" — so `to_status: open` rules match. Operators probing
 * history the sweep cannot know (`from_status`, `source`) fail closed:
 * such rules never sweep-dispatch.
 *
 * Standalone-package isolation: imports ONLY from within
 * `packages/wft-router/src/`. Vendor-neutrality: no provider, AI, chat, or
 * CI name appears in this file.
 */

import type { TriggersRule } from '../config/triggers-schema.js';
import { httpRequest } from '../handlers/http-client.js';
import { evaluateWhere, type EventPayloadShape } from './predicate.js';

/** Token prefix that selects the Bearer auth path (repo PAT convention). */
const PAT_PREFIX = 'wft_pat_';

/** Page size for the task-list query (the API caps `limit` at 500). */
const SWEEP_PAGE_LIMIT = 500;

/** Safety cap on pages fetched per rule (500 × 10 = 5000 open tasks scanned). */
const SWEEP_MAX_PAGES = 10;

/** Build the deterministic sweep event id for a rule + idempotency window. */
export function sweepEventId(ruleName: string, idempotencyWindowS: number, nowMs: number): string {
  const windowMs = idempotencyWindowS * 1000;
  const bucket = windowMs > 0 ? Math.floor(nowMs / windowMs) : nowMs;
  return `sweep:${ruleName}:${String(bucket)}`;
}

/** Loose wire shape of one task row from `GET /api/v1/tasks`. */
interface WireTaskRow {
  id?: number;
  project_id?: number;
  status?: string;
  tags?: readonly string[];
  parent_task_id?: number | null;
  assignee?: string | null;
}

/** Loose wire shape of the paginated list envelope. */
interface WireTaskListResponse {
  data?: readonly WireTaskRow[];
  total?: number;
}

/**
 * Map a task-list row onto the predicate-facing payload shape, AS IF the
 * task had just arrived at its current (open) status. `metadata.to` carries
 * the status so `to_status: open` rules match; `metadata.from`/`source` are
 * deliberately ABSENT (the sweep cannot know history — fail closed).
 *
 * NOTE: the list API does not return a project slug, so string-valued
 * `project:` predicates fail closed here — exactly as they do on the live
 * wire, which also carries no `project_slug`.
 */
export function taskRowToEventPayload(row: WireTaskRow, eventType: string): EventPayloadShape {
  const task: NonNullable<EventPayloadShape['task']> = {};
  if (typeof row.id === 'number') task.id = row.id;
  if (typeof row.project_id === 'number') task.project_id = row.project_id;
  if (typeof row.status === 'string') task.status = row.status;
  if (Array.isArray(row.tags)) task.tags = row.tags;
  if (row.parent_task_id !== undefined) task.parent_task_id = row.parent_task_id;
  if (row.assignee !== undefined) task.assignee = row.assignee;

  const payload: EventPayloadShape = { type: eventType, task };
  if (typeof row.status === 'string') {
    payload.metadata = { to: row.status };
  }
  return payload;
}

/** Options for {@link findFirstMatchingOpenTask}. */
export interface SweepQueryOptions {
  /** API base URL (the daemon `--endpoint`). */
  apiBaseUrl: string;
  /** Auth token; `wft_pat_...` → Bearer, otherwise → X-API-Key. */
  authToken: string;
  /** Test seam — defaults to `globalThis.fetch` inside `httpRequest`. */
  fetchImpl?: typeof fetch;
  /** External abort (the daemon's shutdown signal). */
  signal?: AbortSignal;
  /**
   * Project lookups shared by every rule of ONE sweep (WFT #2544), so a
   * project is fetched at most once per sweep. Create one with
   * {@link createProjectLookupCache} per sweep; omitted → no sharing.
   */
  projectLookups?: ProjectLookupCache;
  /**
   * Called once per failed project lookup (per cache entry). The rule then
   * runs as if the project were live — see {@link ProjectLookup}.
   */
  onProjectLookupFailed?: (failure: { projectId: number; error: string }) => void;
}

/**
 * The outcome of a project lookup (WFT #2544). The stated rule: ONLY a
 * definite `archived` answer (a 2xx body with `archived: true`) skips the
 * rule. A `failed` lookup — the project is gone (404), the token may not read
 * it (403, e.g. a token bound to another project), a non-2xx, a transport
 * error or an unparseable body — is reported and the rule runs exactly as it
 * did before the archive check existed (fail open: an unreadable project must
 * not silence a rule on every sweep). An external abort is not a failed
 * lookup; it is rethrown.
 */
export type ProjectLookup =
  | { state: 'archived' }
  | { state: 'live' }
  | { state: 'failed'; error: string };

/** Per-sweep cache of project lookups, keyed by project id. */
export type ProjectLookupCache = Map<number, Promise<ProjectLookup>>;

/** A fresh, empty lookup cache — create one per sweep. */
export function createProjectLookupCache(): ProjectLookupCache {
  return new Map();
}

/** Result of a sweep query: the first matching open task's payload, or null. */
export interface SweepMatch {
  payload: EventPayloadShape;
  /** How many open tasks matched the predicate on the scanned pages. */
  matchedCount: number;
  /** Total open tasks reported by the API for the narrowed query. */
  openTotal: number;
}

/** Loose wire shape of `GET /api/v1/projects/:id` (only what the sweep reads). */
interface WireProject {
  archived?: boolean;
}

/**
 * Fetch one project and classify it. Archived project state (design §3.8):
 * `GET /tasks?project_id=N` still returns an archived project's tasks, so a
 * numeric `project:` rule must check the project itself. Never throws except
 * on an external abort; every other failure is a `failed` lookup
 * (WFT #2544).
 */
async function fetchProjectLookup(
  projectId: number,
  base: string,
  auth: { name: string; value: string },
  opts: SweepQueryOptions,
): Promise<ProjectLookup> {
  let res: Awaited<ReturnType<typeof httpRequest>>;
  try {
    res = await httpRequest({
      method: 'GET',
      url: `${base}/api/v1/projects/${String(projectId)}`,
      headers: { [auth.name]: auth.value, Accept: 'application/json' },
      ...(opts.fetchImpl !== undefined && { fetchImpl: opts.fetchImpl }),
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
  } catch (err) {
    if (opts.signal?.aborted === true) {
      throw err;
    }
    return { state: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  if (res.status < 200 || res.status >= 300) {
    return { state: 'failed', error: `project lookup returned HTTP ${String(res.status)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.bodyText);
  } catch {
    return { state: 'failed', error: 'project lookup returned unparseable JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'failed', error: 'project lookup returned a non-object body' };
  }
  // A body without `archived` comes from a server older than the archived
  // state: such a project cannot be archived, so it is live.
  return (parsed as WireProject).archived === true ? { state: 'archived' } : { state: 'live' };
}

/**
 * Look a project up through the sweep's cache (one fetch per project per
 * sweep) and report a failure once, when the fetch settles.
 */
function lookupProject(
  projectId: number,
  base: string,
  auth: { name: string; value: string },
  opts: SweepQueryOptions,
): Promise<ProjectLookup> {
  const cached = opts.projectLookups?.get(projectId);
  if (cached !== undefined) {
    return cached;
  }
  const lookup = fetchProjectLookup(projectId, base, auth, opts).then((result) => {
    if (result.state === 'failed') {
      opts.onProjectLookupFailed?.({ projectId, error: result.error });
    }
    return result;
  });
  opts.projectLookups?.set(projectId, lookup);
  return lookup;
}

/** Strip the trailing slash from the base URL so path joins are predictable. */
function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/** Build the auth header pair for a token, per the repo precedence rule. */
function authHeaderFor(token: string): { name: string; value: string } {
  if (token.startsWith(PAT_PREFIX)) {
    return { name: 'Authorization', value: `Bearer ${token}` };
  }
  return { name: 'X-API-Key', value: token };
}

/**
 * Query the task-list REST API for OPEN tasks and return the FIRST one whose
 * synthesized payload passes the rule's `where:` predicate (plus a match
 * count for logging). Server-side narrowing is applied where the API and the
 * predicate agree 1:1 (`project_id` for numeric `project:`, `assignee:`);
 * everything else — tags, parent_id, task_id — is evaluated client-side with
 * `evaluateWhere` for full fidelity. Paginates up to {@link SWEEP_MAX_PAGES}
 * pages of {@link SWEEP_PAGE_LIMIT}.
 *
 * Throws when the TASK-LIST query fails (transport or non-2xx) — the caller
 * (daemon) logs and skips the rule; a failed sweep must never block the live
 * SSE pipeline. A failed PROJECT lookup does not throw (WFT #2544).
 */
export async function findFirstMatchingOpenTask(
  rule: TriggersRule,
  opts: SweepQueryOptions,
): Promise<SweepMatch | null> {
  const auth = authHeaderFor(opts.authToken);
  const base = trimBase(opts.apiBaseUrl);

  // An archived project is frozen: skip the rule (zero dispatches) — but only
  // on a definite "archived"; a failed lookup runs the rule (WFT #2544, see
  // ProjectLookup). A rule without a numeric `project:` needs no lookup — a
  // cross-project task listing already drops archived projects' tasks.
  if (typeof rule.where.project === 'number') {
    const lookup = await lookupProject(rule.where.project, base, auth, opts);
    if (lookup.state === 'archived') {
      return null;
    }
  }

  const params = new URLSearchParams();
  params.set('status', 'open');
  params.set('limit', String(SWEEP_PAGE_LIMIT));
  if (typeof rule.where.project === 'number') {
    params.set('project_id', String(rule.where.project));
  }
  if (rule.where.assignee !== undefined) {
    params.set('assignee', rule.where.assignee);
  }

  let first: EventPayloadShape | null = null;
  let matchedCount = 0;
  let openTotal = 0;

  for (let page = 0; page < SWEEP_MAX_PAGES; page += 1) {
    params.set('offset', String(page * SWEEP_PAGE_LIMIT));
    const res = await httpRequest({
      method: 'GET',
      url: `${base}/api/v1/tasks?${params.toString()}`,
      headers: { [auth.name]: auth.value, Accept: 'application/json' },
      ...(opts.fetchImpl !== undefined && { fetchImpl: opts.fetchImpl }),
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`task-list query returned HTTP ${String(res.status)}`);
    }

    let parsed: WireTaskListResponse;
    try {
      parsed = JSON.parse(res.bodyText) as WireTaskListResponse;
    } catch {
      throw new Error('task-list query returned unparseable JSON');
    }
    const rows = Array.isArray(parsed.data) ? parsed.data : [];
    openTotal = typeof parsed.total === 'number' ? parsed.total : rows.length;

    for (const row of rows) {
      const payload = taskRowToEventPayload(row, rule.on);
      if (evaluateWhere(rule.where, payload)) {
        matchedCount += 1;
        first ??= payload;
      }
    }

    const seen = (page + 1) * SWEEP_PAGE_LIMIT;
    if (rows.length < SWEEP_PAGE_LIMIT || seen >= openTotal) {
      break; // last page
    }
    if (first !== null) {
      break; // a match exists; one dispatch max — no need to keep paging
    }
  }

  if (first === null) {
    return null;
  }
  return { payload: first, matchedCount, openTotal };
}
