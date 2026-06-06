/**
 * Tests for the `where:` predicate evaluator (task #426).
 *
 * Coverage matches the acceptance criterion "predicate.test.ts covers
 * eq/in/exists/matches with missing-key behaviour" — operator groupings
 * below mirror those categories:
 *   - eq          : project, status, from_status, to_status, task_id,
 *                   parent_id, source, eventType
 *   - in          : status_in
 *   - exists      : tags_contains_all (every required tag must be present)
 *   - matches     : tags_contains_any (at least one tag must be present)
 *
 * Each operator is exercised with PASS, FAIL, and MISSING-FIELD-FAIL cases
 * so the safe default ("missing field on event → operator fails") is
 * pinned.
 */

import { describe, expect, it } from 'vitest';

import { evaluateWhere, type EventPayloadShape } from '../predicate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an event shell, then merge in whatever the test cares about. The
 * default event has `type: 'task.updated'` and a populated `task` block —
 * tests that probe missing fields simply OMIT them via the override.
 */
function makeEvent(overrides: Partial<EventPayloadShape> = {}): EventPayloadShape {
  return {
    type: 'task.updated',
    task: {
      id: 101,
      project_id: 7,
      project_slug: 'sample',
      status: 'open',
      tags: ['urgent', 'backend'],
      parent_task_id: 50,
      assignee: 'owner@example.com',
    },
    metadata: {
      from: 'open',
      to: 'in_progress',
      source: 'user',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// eq operators
// ---------------------------------------------------------------------------

describe('evaluateWhere — eq operators', () => {
  describe('project (string slug)', () => {
    it('passes when slug matches', () => {
      expect(evaluateWhere({ project: 'sample' }, makeEvent())).toBe(true);
    });
    it('fails when slug differs', () => {
      expect(evaluateWhere({ project: 'other' }, makeEvent())).toBe(false);
    });
    it('fails when task.project_slug is missing', () => {
      const e = makeEvent({ task: { id: 1 } });
      expect(evaluateWhere({ project: 'sample' }, e)).toBe(false);
    });
  });

  describe('project (numeric id)', () => {
    it('passes when id matches', () => {
      expect(evaluateWhere({ project: 7 }, makeEvent())).toBe(true);
    });
    it('fails when id differs', () => {
      expect(evaluateWhere({ project: 8 }, makeEvent())).toBe(false);
    });
    it('fails when task.project_id is missing', () => {
      const e = makeEvent({ task: { id: 1 } });
      expect(evaluateWhere({ project: 7 }, e)).toBe(false);
    });
  });

  describe('status', () => {
    it('passes on exact match', () => {
      expect(evaluateWhere({ status: 'open' }, makeEvent())).toBe(true);
    });
    it('fails on mismatch', () => {
      expect(evaluateWhere({ status: 'done' }, makeEvent())).toBe(false);
    });
    it('fails when task.status is missing', () => {
      const e = makeEvent({ task: { id: 1 } });
      expect(evaluateWhere({ status: 'open' }, e)).toBe(false);
    });
  });

  describe('from_status', () => {
    it('passes on exact match', () => {
      expect(evaluateWhere({ from_status: 'open' }, makeEvent())).toBe(true);
    });
    it('fails on mismatch', () => {
      expect(evaluateWhere({ from_status: 'done' }, makeEvent())).toBe(false);
    });
    it('fails when metadata.from is missing (e.g. on task.created)', () => {
      const e = makeEvent({ type: 'task.created', metadata: {} });
      expect(evaluateWhere({ from_status: 'open' }, e)).toBe(false);
    });
  });

  describe('to_status', () => {
    it('passes on exact match', () => {
      expect(evaluateWhere({ to_status: 'in_progress' }, makeEvent())).toBe(true);
    });
    it('fails on mismatch', () => {
      expect(evaluateWhere({ to_status: 'done' }, makeEvent())).toBe(false);
    });
    it('fails when metadata.to is missing', () => {
      const e = makeEvent({ metadata: {} });
      expect(evaluateWhere({ to_status: 'in_progress' }, e)).toBe(false);
    });
  });

  describe('task_id', () => {
    it('passes on exact match', () => {
      expect(evaluateWhere({ task_id: 101 }, makeEvent())).toBe(true);
    });
    it('fails on mismatch', () => {
      expect(evaluateWhere({ task_id: 999 }, makeEvent())).toBe(false);
    });
    it('fails when task.id is missing', () => {
      const e = makeEvent({ task: {} });
      expect(evaluateWhere({ task_id: 101 }, e)).toBe(false);
    });
  });

  describe('parent_id', () => {
    it('passes on exact match', () => {
      expect(evaluateWhere({ parent_id: 50 }, makeEvent())).toBe(true);
    });
    it('fails on mismatch', () => {
      expect(evaluateWhere({ parent_id: 999 }, makeEvent())).toBe(false);
    });
    it('fails when task.parent_task_id is null', () => {
      const e = makeEvent({ task: { id: 1, parent_task_id: null } });
      expect(evaluateWhere({ parent_id: 50 }, e)).toBe(false);
    });
    it('fails when task.parent_task_id is missing', () => {
      const e = makeEvent({ task: { id: 1 } });
      expect(evaluateWhere({ parent_id: 50 }, e)).toBe(false);
    });
  });

  describe('assignee', () => {
    it('passes on exact match', () => {
      expect(evaluateWhere({ assignee: 'owner@example.com' }, makeEvent())).toBe(true);
    });
    it('fails on mismatch', () => {
      expect(evaluateWhere({ assignee: 'other@example.com' }, makeEvent())).toBe(false);
    });
    it('fails when task.assignee is null', () => {
      const e = makeEvent({ task: { id: 1, assignee: null } });
      expect(evaluateWhere({ assignee: 'owner@example.com' }, e)).toBe(false);
    });
    it('fails when task.assignee is missing', () => {
      const e = makeEvent({ task: { id: 1 } });
      expect(evaluateWhere({ assignee: 'owner@example.com' }, e)).toBe(false);
    });
    it('imposes no constraint when where.assignee is absent', () => {
      const e = makeEvent({ task: { id: 1 } });
      expect(evaluateWhere({}, e)).toBe(true);
    });
  });

  describe('source', () => {
    it('passes on exact match', () => {
      expect(evaluateWhere({ source: 'user' }, makeEvent())).toBe(true);
    });
    it('fails on mismatch', () => {
      expect(evaluateWhere({ source: 'workflow' }, makeEvent())).toBe(false);
    });
    it('fails when metadata.source is missing', () => {
      const e = makeEvent({ metadata: {} });
      expect(evaluateWhere({ source: 'user' }, e)).toBe(false);
    });
  });

  describe('eventType', () => {
    it('passes on exact match', () => {
      expect(evaluateWhere({ eventType: 'task.updated' }, makeEvent())).toBe(true);
    });
    it('fails on mismatch', () => {
      expect(evaluateWhere({ eventType: 'task.created' }, makeEvent())).toBe(false);
    });
    // No "missing" case: event.type is non-optional by shape.
  });
});

// ---------------------------------------------------------------------------
// in operator
// ---------------------------------------------------------------------------

describe('evaluateWhere — in operator (status_in)', () => {
  it('passes when status appears in the array', () => {
    expect(evaluateWhere({ status_in: ['open', 'in_progress'] }, makeEvent())).toBe(true);
  });
  it('fails when status is not in the array', () => {
    expect(evaluateWhere({ status_in: ['done', 'closed'] }, makeEvent())).toBe(false);
  });
  it('fails when task.status is missing', () => {
    const e = makeEvent({ task: { id: 1 } });
    expect(evaluateWhere({ status_in: ['open'] }, e)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// exists operator (tags_contains_all)
// ---------------------------------------------------------------------------

describe('evaluateWhere — exists operator (tags_contains_all)', () => {
  it('passes when every required tag is present', () => {
    expect(evaluateWhere({ tags_contains_all: ['urgent', 'backend'] }, makeEvent())).toBe(true);
  });
  it('fails when one required tag is missing', () => {
    expect(evaluateWhere({ tags_contains_all: ['urgent', 'missing'] }, makeEvent())).toBe(false);
  });
  it('fails when the event has no tags field', () => {
    const e = makeEvent({ task: { id: 1 } });
    expect(evaluateWhere({ tags_contains_all: ['urgent'] }, e)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matches operator (tags_contains_any)
// ---------------------------------------------------------------------------

describe('evaluateWhere — matches operator (tags_contains_any)', () => {
  it('passes when at least one tag is present', () => {
    expect(evaluateWhere({ tags_contains_any: ['nope', 'urgent', 'also-nope'] }, makeEvent())).toBe(
      true,
    );
  });
  it('fails when none of the tags are present', () => {
    expect(evaluateWhere({ tags_contains_any: ['nope', 'also-nope'] }, makeEvent())).toBe(false);
  });
  it('fails when the event has no tags field', () => {
    const e = makeEvent({ task: { id: 1 } });
    expect(evaluateWhere({ tags_contains_any: ['urgent'] }, e)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Composition + empty where
// ---------------------------------------------------------------------------

describe('evaluateWhere — AND composition + empty where', () => {
  it('empty where passes any event', () => {
    expect(evaluateWhere({}, makeEvent())).toBe(true);
  });

  it('passes when ALL three operators pass', () => {
    expect(
      evaluateWhere(
        {
          project: 'sample',
          status: 'open',
          tags_contains_any: ['backend'],
        },
        makeEvent(),
      ),
    ).toBe(true);
  });

  it('fails when ANY one operator fails', () => {
    expect(
      evaluateWhere(
        {
          project: 'sample',
          status: 'done', // mismatch
          tags_contains_any: ['backend'],
        },
        makeEvent(),
      ),
    ).toBe(false);
  });

  it('fails when one operators field is missing on the event', () => {
    const e = makeEvent({ metadata: {} }); // drops from/to/source
    expect(
      evaluateWhere(
        {
          project: 'sample',
          status: 'open',
          from_status: 'open', // missing → fail
        },
        e,
      ),
    ).toBe(false);
  });
});
