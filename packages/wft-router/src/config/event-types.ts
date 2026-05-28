/**
 * Allowed event-type tuple — wft-router copy.
 *
 * This tuple MUST stay deep-equal to the tuple of the same name exported from
 * `src/events/types.ts`. It is duplicated here (rather than imported) because
 * `packages/wft-router` is a standalone sub-package with its own `rootDir` and
 * cannot reach into the root `src/` tree at compile time without dragging half
 * the server into its `dist/`.
 *
 * Drift between the two tuples is caught by an integration test that lives
 * outside this package, at
 * `src/events/__tests__/wft-router-event-types-sync.test.ts`. That test fails
 * loud if either side adds, removes, or reorders an entry.
 *
 * Vendor-neutrality note: this file is part of the wft-router standalone
 * package; it must not reference any provider, AI vendor, chat platform, or CI
 * name (see docs/event-router-design.md §Vendor-neutral guardrails).
 */
export const ALLOWED_EVENT_TYPES = [
  'task.created',
  'task.updated',
  'task.deleted',
  'task.status_changed',
  'task.claimed',
  'project.created',
  'project.updated',
  'project.deleted',
] as const;

export type AllowedEventType = (typeof ALLOWED_EVENT_TYPES)[number];
