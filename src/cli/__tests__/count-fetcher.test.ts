/**
 * Unit tests for src/cli/statusline/count-fetcher.ts (task #594).
 *
 * Mocks `listTasksPaginated` (the injected lister) and asserts:
 *   - the exact status filters passed (one `open`, one `done`, one `closed`),
 *     each with `limit: 1` and the resolved `project_id`;
 *   - `doneClosed` is the SUM of the `done` + `closed` envelope `total`s;
 *   - a rejecting lister yields a typed `CountFailure` (not a throw).
 */
import { describe, it, expect, vi } from 'vitest';
import type { PaginatedResponse, TaskFilters, TaskResponse } from '../api/types.js';
import { fetchCounts } from '../statusline/count-fetcher.js';

/** Build a pagination envelope whose `total` is the count under test. */
function page(total: number): PaginatedResponse<TaskResponse> {
  return { data: [], total, limit: 1, offset: 0 };
}

describe('fetchCounts', () => {
  it('returns {open, doneClosed} from the `total` of per-status limit:1 reads', async () => {
    // total by status: open=7, done=4, closed=2  →  doneClosed = 6
    const totals: Record<string, number> = { open: 7, done: 4, closed: 2 };
    const listTasksPaginated = vi.fn(async (filters?: TaskFilters) =>
      page(totals[filters?.status ?? ''] ?? 0),
    );

    const result = await fetchCounts(42, { listTasksPaginated });

    expect(result).toEqual({ ok: true, open: 7, doneClosed: 6 });
  });

  it('passes the resolved project_id, the right status filters, and limit:1 (no full paging)', async () => {
    const listTasksPaginated = vi.fn(async () => page(0));

    await fetchCounts(99, { listTasksPaginated });

    // Exactly three minimal reads: open, done, closed.
    expect(listTasksPaginated).toHaveBeenCalledTimes(3);

    const statuses = listTasksPaginated.mock.calls.map(([f]) => f?.status);
    expect(statuses).toEqual(expect.arrayContaining(['open', 'done', 'closed']));

    // Every call is scoped to the project and uses the minimal page size.
    for (const [filters] of listTasksPaginated.mock.calls) {
      expect(filters).toMatchObject({ project_id: 99, limit: 1 });
    }
  });

  it('sums done + closed into doneClosed even when only one is non-zero', async () => {
    const totals: Record<string, number> = { open: 0, done: 0, closed: 5 };
    const listTasksPaginated = vi.fn(async (filters?: TaskFilters) =>
      page(totals[filters?.status ?? ''] ?? 0),
    );

    const result = await fetchCounts(1, { listTasksPaginated });

    expect(result).toEqual({ ok: true, open: 0, doneClosed: 5 });
  });

  it('returns a typed failure (does not throw) when the lister rejects', async () => {
    const listTasksPaginated = vi.fn(async () => {
      throw new Error('network down');
    });

    const result = await fetchCounts(7, { listTasksPaginated });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBe('network down');
    }
  });

  it('describes a non-Error rejection without throwing', async () => {
    const listTasksPaginated = vi.fn(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'boom';
    });

    const result = await fetchCounts(7, { listTasksPaginated });

    expect(result).toEqual({ ok: false, error: 'boom' });
  });
});
