/**
 * Unit tests for the cold-start sweep helpers (task #1005):
 * deterministic sweep event identity, task-row → payload mapping, and the
 * task-list query (narrowing params, client-side predicate fidelity,
 * pagination, error propagation).
 */

import { describe, expect, it } from 'vitest';

import type { TriggersRule } from '../../config/triggers-schema.js';
import {
  findFirstMatchingOpenTask,
  sweepEventId,
  taskRowToEventPayload,
} from '../startup-sweep.js';

// ---------------------------------------------------------------------------
// sweepEventId
// ---------------------------------------------------------------------------

describe('sweepEventId', () => {
  it('is stable within one idempotency bucket and rolls with the bucket', () => {
    // Buckets are ABSOLUTE: floor(now / window_ms). 3600 s window →
    // bucket 1 spans [3_600_000, 7_200_000).
    const a = sweepEventId('r', 3600, 3_700_000);
    const b = sweepEventId('r', 3600, 7_199_999);
    const c = sweepEventId('r', 3600, 7_200_000);
    expect(a).toBe('sweep:r:1');
    expect(b).toBe(a);
    expect(c).toBe('sweep:r:2');
  });

  it('embeds the rule name so two rules never collide on event_id', () => {
    expect(sweepEventId('r1', 60, 120_000)).toBe('sweep:r1:2');
    expect(sweepEventId('r2', 60, 120_000)).toBe('sweep:r2:2');
  });

  it('treats a 0-second window as no dedup (unique per start)', () => {
    expect(sweepEventId('r', 0, 5)).toBe('sweep:r:5');
    expect(sweepEventId('r', 0, 6)).toBe('sweep:r:6');
  });
});

// ---------------------------------------------------------------------------
// taskRowToEventPayload
// ---------------------------------------------------------------------------

describe('taskRowToEventPayload', () => {
  it('maps the row onto the live payload shape with metadata.to = status', () => {
    const payload = taskRowToEventPayload(
      {
        id: 7,
        project_id: 3,
        status: 'open',
        tags: ['a'],
        parent_task_id: null,
        assignee: 'owner@example.com',
      },
      'task.created',
    );
    expect(payload.type).toBe('task.created');
    expect(payload.task).toEqual({
      id: 7,
      project_id: 3,
      status: 'open',
      tags: ['a'],
      parent_task_id: null,
      assignee: 'owner@example.com',
    });
    // "As if it just arrived at open": to_status predicates can match;
    // from/source are absent so history-probing predicates fail closed.
    expect(payload.metadata).toEqual({ to: 'open' });
  });

  it('omits absent fields instead of carrying undefined values', () => {
    const payload = taskRowToEventPayload({ id: 1 }, 'task.created');
    expect(payload.task).toEqual({ id: 1 });
    expect(payload.metadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findFirstMatchingOpenTask
// ---------------------------------------------------------------------------

function rule(overrides: Partial<TriggersRule> = {}): TriggersRule {
  return {
    name: 'r',
    on: 'task.created',
    where: {},
    do: 'webhook_post',
    with: { url: 'https://example.test/h' },
    ...overrides,
  } as TriggersRule;
}

/** Fake fetch returning canned pages keyed by `offset`. */
function pagedFetch(
  pages: Record<string, { data: unknown[]; total: number }>,
  calls: string[],
): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const offset = new URL(url).searchParams.get('offset') ?? '0';
    const page = pages[offset] ?? { data: [], total: 0 };
    return new Response(JSON.stringify({ ...page, limit: 500, offset: Number(offset) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const OPTS = { apiBaseUrl: 'https://api.test/', authToken: 'wft_pat_x' };

describe('findFirstMatchingOpenTask', () => {
  it('queries status=open and narrows by numeric project + assignee', async () => {
    const calls: string[] = [];
    const fetchImpl = pagedFetch(
      { '0': { data: [{ id: 1, project_id: 5, status: 'open', assignee: 'me' }], total: 1 } },
      calls,
    );
    const match = await findFirstMatchingOpenTask(
      rule({ where: { project: 5, assignee: 'me' } } as Partial<TriggersRule>),
      { ...OPTS, fetchImpl },
    );
    expect(match?.payload.task?.id).toBe(1);
    expect(calls).toHaveLength(1);
    const params = new URL(calls[0] as string).searchParams;
    expect(params.get('status')).toBe('open');
    expect(params.get('project_id')).toBe('5');
    expect(params.get('assignee')).toBe('me');
  });

  it('applies the full where-predicate client-side (tags) and counts matches', async () => {
    const calls: string[] = [];
    const fetchImpl = pagedFetch(
      {
        '0': {
          data: [
            { id: 1, status: 'open', tags: ['other'] },
            { id: 2, status: 'open', tags: ['ready'] },
            { id: 3, status: 'open', tags: ['ready'] },
          ],
          total: 3,
        },
      },
      calls,
    );
    const match = await findFirstMatchingOpenTask(
      rule({ where: { tags_contains_any: ['ready'] } } as Partial<TriggersRule>),
      { ...OPTS, fetchImpl },
    );
    expect(match?.payload.task?.id).toBe(2);
    expect(match?.matchedCount).toBe(2);
    expect(match?.openTotal).toBe(3);
  });

  it('returns null when no open task passes the predicate', async () => {
    const fetchImpl = pagedFetch(
      { '0': { data: [{ id: 1, status: 'open', tags: [] }], total: 1 } },
      [],
    );
    const match = await findFirstMatchingOpenTask(
      rule({ where: { tags_contains_any: ['ready'] } } as Partial<TriggersRule>),
      { ...OPTS, fetchImpl },
    );
    expect(match).toBeNull();
  });

  it('paginates past a full non-matching page and stops once a match is found', async () => {
    const calls: string[] = [];
    const fullPage = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      status: 'open',
      tags: [] as string[],
    }));
    const fetchImpl = pagedFetch(
      {
        '0': { data: fullPage, total: 502 },
        '500': {
          data: [
            { id: 501, status: 'open', tags: ['ready'] },
            { id: 502, status: 'open', tags: [] },
          ],
          total: 502,
        },
      },
      calls,
    );
    const match = await findFirstMatchingOpenTask(
      rule({ where: { tags_contains_any: ['ready'] } } as Partial<TriggersRule>),
      { ...OPTS, fetchImpl },
    );
    expect(match?.payload.task?.id).toBe(501);
    expect(calls).toHaveLength(2);
  });

  it('throws on a non-2xx response so the caller can isolate the rule', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(findFirstMatchingOpenTask(rule(), { ...OPTS, fetchImpl })).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it('throws on unparseable JSON', async () => {
    const fetchImpl = (async () => new Response('{not json', { status: 200 })) as typeof fetch;
    await expect(findFirstMatchingOpenTask(rule(), { ...OPTS, fetchImpl })).rejects.toThrow(
      /unparseable/,
    );
  });
});
