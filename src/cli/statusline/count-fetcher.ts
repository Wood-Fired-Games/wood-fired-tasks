/**
 * Project task-count fetcher (project 29, task #594).
 *
 * Given a resolved numeric `projectId`, produces the two numbers the
 * status-line's linked-project segment needs — how many tasks are still
 * `open`, and how many are finished (`done` + `closed`) — WITHOUT paging the
 * full task list.
 *
 * There is no server-side stats endpoint, so we lean on the pagination
 * envelope instead: every list call returns `{ data, total, limit, offset }`,
 * and `total` is the count of rows matching the filter *before* the page
 * window is applied. By passing `limit: 1` we transfer at most one task row
 * per call yet still read an accurate `total`. We issue one call per status:
 *   - `open`            → the `open` count
 *   - `done` + `closed` → summed into `doneClosed`
 *
 * The status enum (`open | in_progress | done | closed | blocked |
 * backlogged`) splits "finished" into two distinct statuses, so `doneClosed`
 * is the sum of two `total` reads. `in_progress`, `blocked`, and `backlogged`
 * are intentionally excluded from both buckets.
 *
 * NEVER throws. Any API/network rejection from {@link listTasksPaginated}
 * degrades to a typed `CountFailure` so a status-line render can always
 * proceed.
 */

import type { PaginatedResponse, TaskFilters, TaskResponse } from '../api/types.js';

/** Successful count read. */
export interface CountSuccess {
  ok: true;
  /** Tasks in `open` status for the project. */
  open: number;
  /** Tasks in `done` + `closed` status for the project (summed). */
  doneClosed: number;
}

/** Typed failure — returned (never thrown) when any list call rejects. */
export interface CountFailure {
  ok: false;
  /** Human-readable reason, derived from the underlying error. */
  error: string;
}

/** Discriminated result of {@link fetchCounts}. */
export type CountResult = CountSuccess | CountFailure;

/** The single API surface this module depends on. Injected for testability. */
export type ListTasksPaginated = (
  filters?: TaskFilters,
) => Promise<PaginatedResponse<TaskResponse>>;

/** Injectable dependencies (defaults wired to the real CLI API client). */
export interface FetchCountsOptions {
  /**
   * Paginated task lister. Injected for testability; the default lazily
   * imports the real API client so module load stays cheap and offline
   * status-line renders never trigger a network import.
   */
  listTasksPaginated?: ListTasksPaginated;
}

/** The "finished" statuses that sum into `doneClosed`. */
const DONE_CLOSED_STATUSES = ['done', 'closed'] as const;

/**
 * Fetch `{ open, doneClosed }` counts for a project using minimal
 * (`limit: 1`) paginated reads. Never throws; returns a discriminated union.
 */
export async function fetchCounts(
  projectId: number,
  opts: FetchCountsOptions = {},
): Promise<CountResult> {
  const list = opts.listTasksPaginated ?? defaultListTasksPaginated;

  try {
    // One call for `open`, plus one call per "finished" status. Run them
    // concurrently — they're independent reads against the same endpoint.
    const [openTotal, ...doneTotals] = await Promise.all([
      countFor(list, projectId, 'open'),
      ...DONE_CLOSED_STATUSES.map((status) => countFor(list, projectId, status)),
    ]);

    const doneClosed = doneTotals.reduce((sum, total) => sum + total, 0);
    return { ok: true, open: openTotal, doneClosed };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Issue a single minimal (`limit: 1`) paginated read filtered to one status
 * and return its `total`. We never read `data` — only the envelope count.
 */
async function countFor(
  list: ListTasksPaginated,
  projectId: number,
  status: string,
): Promise<number> {
  const page = await list({ project_id: projectId, status, limit: 1 });
  return page.total;
}

/** Lazy real-client lister so the API module isn't imported until needed. */
async function defaultListTasksPaginated(
  filters?: TaskFilters,
): Promise<PaginatedResponse<TaskResponse>> {
  const { listTasksPaginated } = await import('../api/client.js');
  return listTasksPaginated(filters);
}

/** Best-effort error → message, without leaking thrown types to callers. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error fetching task counts';
}
