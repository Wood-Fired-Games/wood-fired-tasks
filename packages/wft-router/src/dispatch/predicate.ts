/**
 * Predicate evaluator for the wft-router `where:` block (task #426).
 *
 * The schema task (#422) already validated which operators may appear in a
 * `where:` block; this module evaluates them at dispatch time against a
 * live event payload. Both sides must agree on the operator surface — we
 * import the schema-derived `Where` type so a new operator added to
 * `triggers-schema.ts` triggers a TypeScript exhaustiveness failure here
 * the next time the package is built.
 *
 * Composition: a `where:` block evaluates as a DEEP AND across every
 * operator that is PRESENT. An operator that is absent imposes no
 * constraint (so an empty `{}` always passes). An operator that IS present
 * but whose corresponding event field is missing FAILS the predicate —
 * this is the safe default (see docs/event-router-design.md §"Predicate
 * language" lines 187-211 and the task brief's missing-key paragraph).
 *
 * Hard constraints honoured here:
 *   - Pure function of (where, event) — no I/O, no globals.
 *   - No dynamic code evaluation; the operator switch is a literal
 *     case-by-case branch.
 *
 * Vendor-neutrality: this file is part of the wft-router standalone package;
 * it must not reference any provider, AI vendor, chat platform, or CI name
 * (see docs/event-router-design.md §Vendor-neutral guardrails).
 */

import type { z } from 'zod';

import type { WhereSchema } from '../config/triggers-schema.js';

/** Closed-world `Where` type, derived from the schema (#422). */
type Where = z.infer<typeof WhereSchema>;

/**
 * Subset of the SSE event payload that the predicate may probe. The router
 * keeps this loose on purpose — fields are all optional because not every
 * event carries every field (e.g. `metadata.from` only appears on
 * `task.status_changed`). The "field missing → operator fails" rule is
 * implemented uniformly below.
 */
export interface EventPayloadShape {
  /** The SSE event-type string, e.g. `task.created`. */
  type: string;
  task?: {
    id?: number;
    project_id?: number;
    project_slug?: string;
    status?: string;
    tags?: readonly string[];
    parent_task_id?: number | null;
    assignee?: string | null;
  };
  metadata?: {
    from?: string;
    to?: string;
    source?: 'user' | 'workflow';
  };
}

/**
 * Evaluate a `where:` block against an event.
 *
 * Returns `true` iff EVERY operator present in `where` passes against the
 * event. An operator whose probed field is missing on the event causes the
 * predicate to FAIL (a rule that requires `from_status: blocked` must NOT
 * fire on a `task.created` event that carries no `metadata.from`).
 *
 * An empty `where: {}` always passes — by definition, the deep AND across
 * zero constraints is vacuously true.
 */
export function evaluateWhere(where: Where, event: EventPayloadShape): boolean {
  if (where.project !== undefined && !matchProject(where.project, event)) {
    return false;
  }
  if (where.status !== undefined && event.task?.status !== where.status) {
    return false;
  }
  if (where.status_in !== undefined) {
    const status = event.task?.status;
    if (status === undefined || !where.status_in.includes(status as never)) {
      return false;
    }
  }
  if (where.from_status !== undefined && event.metadata?.from !== where.from_status) {
    return false;
  }
  if (where.to_status !== undefined && event.metadata?.to !== where.to_status) {
    return false;
  }
  if (where.tags_contains_all !== undefined) {
    const tags = event.task?.tags;
    if (tags === undefined) {
      return false;
    }
    for (const required of where.tags_contains_all) {
      if (!tags.includes(required)) {
        return false;
      }
    }
  }
  if (where.tags_contains_any !== undefined) {
    const tags = event.task?.tags;
    if (tags === undefined) {
      return false;
    }
    let anyHit = false;
    for (const candidate of where.tags_contains_any) {
      if (tags.includes(candidate)) {
        anyHit = true;
        break;
      }
    }
    if (!anyHit) {
      return false;
    }
  }
  if (where.task_id !== undefined && event.task?.id !== where.task_id) {
    return false;
  }
  if (where.parent_id !== undefined && event.task?.parent_task_id !== where.parent_id) {
    return false;
  }
  if (where.assignee !== undefined && event.task?.assignee !== where.assignee) {
    return false;
  }
  if (where.source !== undefined && event.metadata?.source !== where.source) {
    return false;
  }
  if (where.eventType !== undefined && event.type !== where.eventType) {
    return false;
  }
  return true;
}

/**
 * `project:` accepts a string slug OR a numeric id. The two compare against
 * different event fields (`project_slug` vs `project_id`). Missing field
 * on the event fails the operator.
 */
function matchProject(projectFilter: string | number, event: EventPayloadShape): boolean {
  if (typeof projectFilter === 'string') {
    return event.task?.project_slug === projectFilter;
  }
  return event.task?.project_id === projectFilter;
}
