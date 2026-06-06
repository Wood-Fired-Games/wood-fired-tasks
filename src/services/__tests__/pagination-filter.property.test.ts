import { test, fc } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { createTestApp, type App } from '../../index.js';
import { TASK_STATUSES, VALID_STATUS_TRANSITIONS } from '../../types/task.js';
import type { TaskStatus } from '../../types/task.js';

/**
 * Property-based invariants for paginated listing combined with filters.
 *
 * Roadmap Phase 7 calls out "pagination/filter combinations" as an under-covered
 * area. The existing property suite (`service-invariants.property.test.ts`)
 * verifies subset + count equality for a *single* page but never asserts the
 * invariants that span pagination (offset walks, page composition, total
 * stability, monotone narrowing under filter intersection).
 *
 * Coverage targets — all exercised via the public service surface
 * (TaskService.listTasksPaginated / listTasks / countTasks):
 *
 *   P1. Page-walk coverage. For any seeded dataset, iterating
 *       `listTasksPaginated({...filters, limit: L, offset: k*L})` for
 *       k = 0..ceil(total/L) yields exactly the same set of task ids — with
 *       no duplicates and no drops — as a single un-paginated list of the
 *       same filters.
 *
 *   P2. Envelope `total` is invariant under page size. Calling the paginated
 *       endpoint with `limit = a` vs `limit = b` (and offset 0) reports the
 *       same `total`. `total` reflects the unbounded match count, not the
 *       page size.
 *
 *   P3. Filter intersection is monotone. Adding any filter never widens the
 *       result: `count({A, B}) <= min(count({A}), count({B}))`. This is the
 *       single most important property for the SQL builder — a regression
 *       that turns AND into OR (or that fails to bind a parameter) would
 *       blow this up immediately.
 *
 *   P4. Empty / out-of-range offset is well-behaved. Offsets at or past
 *       `total` return an empty `data` array while still reporting the
 *       correct `total`. Negative or fractional values are rejected by the
 *       schema, so we only assert the in-range / past-the-end shape here.
 *
 * Design notes:
 *
 *   - We use the real production code path (`app.taskService.*`), not the
 *     repository directly, so the schema layer's coercion + the service's
 *     default-pagination logic are part of the test surface.
 *   - `numRuns` is kept tight (8–15 per property) so the file runs well under
 *     2 seconds locally even though each iteration spins up a fresh in-memory
 *     SQLite app via `createTestApp`.
 *   - Seeded fixtures are deterministic per iteration: status/assignee/project
 *     dimensions are picked from small constant sets so the filter arbitrary
 *     can address them precisely.
 */

const ASSIGNEES = ['alice', 'bob', 'carol', 'dave'] as const;
type Assignee = (typeof ASSIGNEES)[number];

/**
 * Walk a fresh `open` task into `target` via valid VALID_STATUS_TRANSITIONS
 * hops. Mirrors the helper used in `service-invariants.property.test.ts` —
 * duplicated here to keep this file independently readable and to avoid
 * cross-file import coupling.
 */
function moveTaskToStatus(app: App, taskId: number, target: TaskStatus): boolean {
  if (target === 'open') return true;
  const visited = new Set<TaskStatus>(['open']);
  let current: TaskStatus = 'open';
  const maxHops = TASK_STATUSES.length * 2;
  for (let i = 0; i < maxHops; i++) {
    const targets = VALID_STATUS_TRANSITIONS[current];
    let next: TaskStatus | null = null;
    if (targets.includes(target)) {
      next = target;
    } else {
      next = targets.find((t) => !visited.has(t)) ?? null;
    }
    if (next === null) return false;
    app.taskService.updateTask(taskId, { status: next });
    visited.add(next);
    current = next;
    if (current === target) return true;
  }
  return current === target;
}

interface FixtureSpec {
  status: TaskStatus;
  assignee: Assignee;
}

/**
 * Seed `specs.length` tasks across a single project. Returns the project id
 * plus the row count actually created (always equal to `specs.length`).
 */
function seedFixtures(app: App, specs: FixtureSpec[]): { projectId: number } {
  const project = app.projectService.createProject({ name: 'pagination-prop' });
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const t = app.taskService.createTask({
      title: `task-${i}`,
      project_id: project.id,
      created_by: 'prop-tester',
      assignee: spec.assignee,
    });
    if (spec.status !== 'open') {
      moveTaskToStatus(app, t.id, spec.status);
    }
  }
  return { projectId: project.id };
}

const statusArb = fc.constantFrom(...TASK_STATUSES);
const assigneeArb = fc.constantFrom<Assignee>(...ASSIGNEES);
const fixtureSpecArb = fc.record({ status: statusArb, assignee: assigneeArb });
// Bound dataset size so a single property iteration stays sub-100ms.
const fixturesArb = fc.array(fixtureSpecArb, { minLength: 3, maxLength: 12 });
// Page sizes that exercise both "page fits all rows" and "multiple pages".
const pageSizeArb = fc.integer({ min: 1, max: 8 });

describe('TaskService pagination/filter invariants', () => {
  test.prop({ fixtures: fixturesArb, pageSize: pageSizeArb }, { numRuns: 10 })(
    'P1: walking every page reconstructs the un-paginated result with no duplicates or drops',
    async ({ fixtures, pageSize }) => {
      const app = await createTestApp();
      try {
        const { projectId } = seedFixtures(app, fixtures);

        // Un-paginated baseline: use the schema's MAX_PAGE_LIMIT-aware ceiling.
        const baseline = app.taskService.listTasks({
          project_id: projectId,
          limit: 500,
        });
        const baselineIds = baseline.map((t) => t.id);

        // Walk pages until we exceed `total`. We trust the envelope's `total`
        // here because P2 separately verifies it is invariant.
        const firstPage = app.taskService.listTasksPaginated({
          project_id: projectId,
          limit: pageSize,
          offset: 0,
        });
        expect(firstPage.total).toBe(baseline.length);

        const collectedIds: number[] = [];
        const seen = new Set<number>();
        let offset = 0;
        // Hard cap on page walks as a safety net against an infinite loop if
        // pagination ever regressed to returning the same page repeatedly.
        const maxPages = Math.ceil(baseline.length / pageSize) + 2;
        for (let p = 0; p < maxPages; p++) {
          const page = app.taskService.listTasksPaginated({
            project_id: projectId,
            limit: pageSize,
            offset,
          });
          expect(page.limit).toBe(pageSize);
          expect(page.offset).toBe(offset);
          expect(page.total).toBe(baseline.length);
          // Each page must fit inside the requested limit.
          expect(page.data.length).toBeLessThanOrEqual(pageSize);
          for (const row of page.data) {
            // No row should appear twice across pages.
            expect(seen.has(row.id)).toBe(false);
            seen.add(row.id);
            collectedIds.push(row.id);
          }
          offset += pageSize;
          if (offset >= page.total) break;
        }

        // Same set of ids, regardless of ordering between baseline and pages.
        expect(collectedIds.length).toBe(baselineIds.length);
        expect(new Set(collectedIds)).toEqual(new Set(baselineIds));
        return true;
      } finally {
        app.dispose();
      }
    },
  );

  test.prop(
    {
      fixtures: fixturesArb,
      limitA: pageSizeArb,
      limitB: pageSizeArb,
    },
    { numRuns: 10 },
  )('P2: envelope.total is invariant under page size', async ({ fixtures, limitA, limitB }) => {
    const app = await createTestApp();
    try {
      const { projectId } = seedFixtures(app, fixtures);

      const pageA = app.taskService.listTasksPaginated({
        project_id: projectId,
        limit: limitA,
        offset: 0,
      });
      const pageB = app.taskService.listTasksPaginated({
        project_id: projectId,
        limit: limitB,
        offset: 0,
      });

      expect(pageA.total).toBe(pageB.total);

      // Cross-check against the standalone count() helper too — they all
      // measure the same unbounded match set.
      const counted = app.taskService.countTasks({ project_id: projectId });
      expect(counted).toBe(pageA.total);
      return true;
    } finally {
      app.dispose();
    }
  });

  test.prop(
    {
      fixtures: fixturesArb,
      filterStatus: statusArb,
      filterAssignee: assigneeArb,
    },
    { numRuns: 12 },
  )(
    'P3: adding a filter never widens the result (intersection is monotone)',
    async ({ fixtures, filterStatus, filterAssignee }) => {
      const app = await createTestApp();
      try {
        const { projectId } = seedFixtures(app, fixtures);

        const justProject = app.taskService.countTasks({
          project_id: projectId,
        });
        const justStatus = app.taskService.countTasks({
          project_id: projectId,
          status: filterStatus,
        });
        const justAssignee = app.taskService.countTasks({
          project_id: projectId,
          assignee: filterAssignee,
        });
        const both = app.taskService.countTasks({
          project_id: projectId,
          status: filterStatus,
          assignee: filterAssignee,
        });

        // Single-axis narrowing.
        expect(justStatus).toBeLessThanOrEqual(justProject);
        expect(justAssignee).toBeLessThanOrEqual(justProject);
        // Conjunction narrows past each individual axis.
        expect(both).toBeLessThanOrEqual(justStatus);
        expect(both).toBeLessThanOrEqual(justAssignee);
        return true;
      } finally {
        app.dispose();
      }
    },
  );

  test.prop(
    {
      fixtures: fixturesArb,
      pageSize: pageSizeArb,
      extraOffset: fc.integer({ min: 0, max: 5 }),
    },
    { numRuns: 8 },
  )(
    'P4: offsets at or past total return an empty page but preserve total',
    async ({ fixtures, pageSize, extraOffset }) => {
      const app = await createTestApp();
      try {
        const { projectId } = seedFixtures(app, fixtures);

        const first = app.taskService.listTasksPaginated({
          project_id: projectId,
          limit: pageSize,
          offset: 0,
        });
        const total = first.total;

        const beyond = app.taskService.listTasksPaginated({
          project_id: projectId,
          limit: pageSize,
          offset: total + extraOffset,
        });

        expect(beyond.data).toEqual([]);
        expect(beyond.total).toBe(total);
        expect(beyond.limit).toBe(pageSize);
        expect(beyond.offset).toBe(total + extraOffset);
        return true;
      } finally {
        app.dispose();
      }
    },
  );
});
