/**
 * Unit/integration tests for src/cli/commands/statusline.ts (task #597).
 *
 * Exercises {@link renderStatusline} in-process with fully injected seams so
 * no live server, cache files, or real stdin are needed. The full subprocess
 * test (real stdin, real bin wiring) is the separate task #599.
 *
 * Coverage (the acceptance criteria, judged verbatim):
 *   - linked + FRESH cache → renders counts, makes NO API call
 *   - unlinked → blank (or only the hint), no crash
 *   - API unreachable on refresh → exit-0 stale-or-blank (no throw)
 *   - update hint present when cache says available AND enabled
 *   - update hint absent when disabled (and absent when cache says not-available)
 *   - counts and update segments degrade INDEPENDENTLY
 */
import { describe, it, expect, vi } from 'vitest';

import { renderStatusline, type StatuslineDeps } from './statusline.js';
import type { CountCache, TtlResult } from '../cache/count-cache.js';
import type { CountResult } from '../statusline/count-fetcher.js';
import type { ProjectResolution } from '../statusline/resolve-project.js';

const NOW = 1_700_000_000_000;

/** A fresh count-cache TtlResult for the given counts. */
function freshCache(value: Partial<CountCache> = {}): TtlResult<CountCache> {
  return {
    state: 'fresh',
    ageMs: 0,
    value: {
      projectId: 42,
      projectName: 'myproj',
      open: 3,
      doneClosed: 7,
      fetchedAt: NOW,
      ...value,
    },
  };
}

/** A stale count-cache TtlResult for the given counts. */
function staleCache(value: Partial<CountCache> = {}): TtlResult<CountCache> {
  return {
    state: 'stale',
    ageMs: 999_999,
    value: {
      projectId: 42,
      projectName: 'oldname',
      open: 1,
      doneClosed: 1,
      fetchedAt: NOW - 999_999,
      ...value,
    },
  };
}

/**
 * Build a deps object with sensible no-op defaults; override per test. By
 * default: linked project #42, fresh cache, update feature enabled but cache
 * says no update. NO real stdin, NO real network.
 */
function baseDeps(overrides: Partial<StatuslineDeps> = {}): StatuslineDeps {
  const resolution: ProjectResolution = { resolved: true, source: 'wft_marker', projectId: 42 };
  return {
    readStdin: async () => JSON.stringify({ cwd: '/repo' }),
    resolveProject: async () => resolution,
    fetchCounts: async () => ({ ok: true, open: 0, doneClosed: 0 }) as CountResult,
    resolveProjectName: async () => 'myproj',
    readCountCache: () => freshCache(),
    writeCountCache: (_k, payload) => ({ ...payload, fetchedAt: NOW }),
    readUpdateCache: () => ({ state: 'missing' }),
    isUpdateCheckEnabled: () => true,
    now: () => NOW,
    ...overrides,
  };
}

describe('renderStatusline', () => {
  it('renders counts from a FRESH cache without calling the REST API', async () => {
    const fetchSpy = vi.fn();
    const line = await renderStatusline(
      baseDeps({
        readCountCache: () => freshCache({ projectName: 'myproj', open: 3, doneClosed: 7 }),
        fetchCounts: fetchSpy as unknown as StatuslineDeps['fetchCounts'],
      }),
      false,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(line).toContain('myproj');
    expect(line).toContain('3 open');
    expect(line).toContain('7 done');
  });

  it('prints nothing when no project is linked (unlinked)', async () => {
    const line = await renderStatusline(
      baseDeps({
        resolveProject: async () => ({ resolved: false }),
        readUpdateCache: () => ({ state: 'missing' }),
      }),
      false,
    );

    expect(line).toBe('');
  });

  it('unlinked still shows ONLY the update hint when one is available', async () => {
    const line = await renderStatusline(
      baseDeps({
        resolveProject: async () => ({ resolved: false }),
        isUpdateCheckEnabled: () => true,
        readUpdateCache: () => ({
          state: 'fresh',
          ageMs: 0,
          value: { updateAvailable: true },
        }),
      }),
      false,
    );

    expect(line).toContain('/tasks:update');
    expect(line).not.toContain('open');
  });

  it('refreshes over REST and writes the cache when the cache is MISSING', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, open: 5, doneClosed: 9 }) as CountResult);
    const writeSpy = vi.fn((_k: string, payload: Omit<CountCache, 'fetchedAt'>) => ({
      ...payload,
      fetchedAt: NOW,
    }));

    const line = await renderStatusline(
      baseDeps({
        readCountCache: () => ({ state: 'missing' }),
        fetchCounts: fetchSpy as unknown as StatuslineDeps['fetchCounts'],
        resolveProjectName: async () => 'freshname',
        writeCountCache: writeSpy as unknown as StatuslineDeps['writeCountCache'],
      }),
      false,
    );

    expect(fetchSpy).toHaveBeenCalledWith(42);
    expect(writeSpy).toHaveBeenCalledOnce();
    expect(line).toContain('freshname');
    expect(line).toContain('5 open');
    expect(line).toContain('9 done');
  });

  it('degrades to STALE cache (no throw) when the API is unreachable', async () => {
    const line = await renderStatusline(
      baseDeps({
        readCountCache: () => staleCache({ projectName: 'staleproj', open: 1, doneClosed: 2 }),
        fetchCounts: async () => ({ ok: false, error: 'ECONNREFUSED' }) as CountResult,
      }),
      false,
    );

    expect(line).toContain('staleproj');
    expect(line).toContain('1 open');
    expect(line).toContain('2 done');
  });

  it('degrades to BLANK counts (no throw) when API unreachable and no cache', async () => {
    const line = await renderStatusline(
      baseDeps({
        readCountCache: () => ({ state: 'missing' }),
        fetchCounts: async () => {
          throw new Error('network down');
        },
        readUpdateCache: () => ({ state: 'missing' }),
      }),
      false,
    );

    expect(line).toBe('');
  });

  it('appends the update hint when the cache says available AND the feature is enabled', async () => {
    const line = await renderStatusline(
      baseDeps({
        readCountCache: () => freshCache({ projectName: 'myproj', open: 3, doneClosed: 7 }),
        isUpdateCheckEnabled: () => true,
        readUpdateCache: () => ({
          state: 'fresh',
          ageMs: 0,
          value: { updateAvailable: true },
        }),
      }),
      false,
    );

    expect(line).toContain('myproj');
    expect(line).toContain('/tasks:update');
  });

  it('omits the update hint when the feature is DISABLED (no network read either)', async () => {
    const updateReadSpy = vi.fn(() => ({
      state: 'fresh' as const,
      ageMs: 0,
      value: { updateAvailable: true },
    }));

    const line = await renderStatusline(
      baseDeps({
        readCountCache: () => freshCache({ projectName: 'myproj', open: 3, doneClosed: 7 }),
        isUpdateCheckEnabled: () => false,
        readUpdateCache: updateReadSpy as unknown as StatuslineDeps['readUpdateCache'],
      }),
      false,
    );

    expect(line).toContain('myproj');
    expect(line).not.toContain('/tasks:update');
    // Disabled short-circuits BEFORE the cache read — render path stays pure.
    expect(updateReadSpy).not.toHaveBeenCalled();
  });

  it('omits the update hint when the cache says NOT available', async () => {
    const line = await renderStatusline(
      baseDeps({
        readCountCache: () => freshCache({ projectName: 'myproj', open: 3, doneClosed: 7 }),
        isUpdateCheckEnabled: () => true,
        readUpdateCache: () => ({
          state: 'fresh',
          ageMs: 0,
          value: { updateAvailable: false },
        }),
      }),
      false,
    );

    expect(line).toContain('myproj');
    expect(line).not.toContain('/tasks:update');
  });

  it('degrades counts and update segments INDEPENDENTLY (counts fail, hint shows)', async () => {
    const line = await renderStatusline(
      baseDeps({
        // Counts fail entirely: missing cache + API down.
        readCountCache: () => ({ state: 'missing' }),
        fetchCounts: async () => ({ ok: false, error: 'down' }) as CountResult,
        // Hint succeeds independently.
        isUpdateCheckEnabled: () => true,
        readUpdateCache: () => ({
          state: 'fresh',
          ageMs: 0,
          value: { updateAvailable: true },
        }),
      }),
      false,
    );

    expect(line).toContain('/tasks:update');
    expect(line).not.toContain('open');
  });

  it('degrades counts and update segments INDEPENDENTLY (hint fails, counts show)', async () => {
    const line = await renderStatusline(
      baseDeps({
        readCountCache: () => freshCache({ projectName: 'myproj', open: 3, doneClosed: 7 }),
        // Hint read throws — must not suppress the counts segment.
        isUpdateCheckEnabled: () => true,
        readUpdateCache: () => {
          throw new Error('cache read blew up');
        },
      }),
      false,
    );

    expect(line).toContain('myproj');
    expect(line).toContain('3 open');
    expect(line).not.toContain('/tasks:update');
  });

  it('tolerates empty/garbage stdin and falls back to process.cwd()', async () => {
    const resolveSpy = vi.fn(async () => ({ resolved: false }) as ProjectResolution);
    const line = await renderStatusline(
      baseDeps({
        readStdin: async () => 'not json at all {{{',
        resolveProject: resolveSpy,
        readUpdateCache: () => ({ state: 'missing' }),
      }),
      false,
    );

    // Resolver was called with a string cwd (process.cwd()), did not throw.
    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(typeof resolveSpy.mock.calls[0]![0]).toBe('string');
    expect(line).toBe('');
  });

  it('does NOT call the API when the cache is fresh, even with a numeric id', async () => {
    const fetchSpy = vi.fn();
    const nameSpy = vi.fn();
    await renderStatusline(
      baseDeps({
        readCountCache: () => freshCache(),
        fetchCounts: fetchSpy as unknown as StatuslineDeps['fetchCounts'],
        resolveProjectName: nameSpy as unknown as StatuslineDeps['resolveProjectName'],
      }),
      false,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(nameSpy).not.toHaveBeenCalled();
  });
});
