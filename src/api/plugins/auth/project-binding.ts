/**
 * Target-project resolution for the PAT project binding (Security Audit
 * finding M1 — task #1635).
 *
 * ## Why this module exists
 *
 * `enforceRequiredScope` answers "how much may this token do?". The binding
 * answers "*where* may it do it?" — and answering that requires knowing which
 * project a given request actually touches. For roughly half the authenticated
 * surface the project is right there in the path (`/api/v1/projects/:id/...`).
 * For the other half it is **implicit**: `PUT /api/v1/tasks/:id` names a task,
 * not a project. A binding that only understood the explicit form would be
 * trivially bypassable — an attacker holding a token bound to project A simply
 * mutates a task belonging to project B by its task id and never mentions a
 * project at all. So this module resolves the target project for BOTH forms.
 *
 * ## Fail-closed by construction
 *
 * The rule table below is keyed by the route's registered url (and, where the
 * verb changes the answer, by `METHOD url`). A route that is **absent** from
 * the table resolves to `null` — "cannot determine" — and
 * `bindingSatisfiesProjects` refuses a bound token on a `null` resolution. So
 * a newly-added route is denied to bound tokens until someone classifies it,
 * rather than silently escaping the check. The drift guard in
 * `src/api/__tests__/pat-project-binding.test.ts` turns that latent denial
 * into a loud test failure by asserting every route in the server's built
 * route table has a rule.
 *
 * Note the asymmetry with `enforceRequiredScope`, which fails OPEN on an
 * undeclared route (`if (required === undefined) return false`). That is
 * deliberate: an undeclared tier means "no tier opinion", whereas an
 * unclassified route under a bound token means "we do not know whether this
 * crosses the boundary", and the only safe answer to that is no.
 *
 * ## The three ways a route can be classified
 *
 *  - `global`  — the route provably has no project dimension (`GET /api/v1/me`,
 *    `GET /api/v1/models`, `/health/detailed`). Resolves to `[]`, which every
 *    binding satisfies. Reserved for surfaces that expose no project-scoped
 *    row whatsoever.
 *  - `deny`    — the route is cross-project *by construction* and cannot be
 *    narrowed: listing every project, creating a NEW project (which is by
 *    definition outside any existing binding), or writing the database-wide
 *    model policy. Resolves to `null`, i.e. refused for bound tokens and
 *    untouched for unbound ones.
 *  - `resolve` — one or more {@link ProjectSource}s to evaluate. Every source
 *    that yields a project id contributes to the target set, and
 *    `bindingSatisfiesProjects` requires ALL of them to match. A REQUIRED
 *    source that yields nothing collapses the whole resolution to `null`.
 *
 * ## Repository discipline
 *
 * Task → project resolution goes through `TaskService.findProjectIdForTask`,
 * which delegates to `ITaskRepository.findById`. No SQL is issued from this
 * module or from the auth chain.
 */
import type { FastifyRequest } from 'fastify';

/** Looks a task id up to the project that owns it. `null` ⇒ no such task. */
export interface ProjectBindingDeps {
  taskService: { findProjectIdForTask(taskId: number): number | null } | undefined;
}

/**
 * One place a request can carry a project reference.
 *
 * `project*` sources name a project id directly; `task*` sources name a TASK
 * id that must be dereferenced to the project that owns it — the indirect
 * case the binding exists to cover.
 *
 * `optional: true` means "contribute if present, ignore if absent" and is used
 * only for fields that are genuinely optional in the route's own schema
 * (`parent_task_id`, `blocked_by`). Every other source is REQUIRED: absence
 * collapses the resolution to `null` (refused), never to "no targets".
 */
export type ProjectSource =
  | { from: 'projectParam'; key: string }
  | { from: 'projectQuery'; key: string }
  | { from: 'projectBody'; key: string }
  | { from: 'taskParam'; key: string }
  | { from: 'taskBody'; key: string; optional?: true }
  | { from: 'taskBodyArray'; key: string; optional?: true };

/** How one route's target project is determined. See the module docblock. */
export type BindingRule =
  | { kind: 'global' }
  | { kind: 'deny' }
  | { kind: 'resolve'; sources: ProjectSource[] };

/**
 * ROUTE RESOLUTION TABLE — the security-critical enumeration.
 *
 * Keyed by the route's registered url with any trailing slash stripped (see
 * {@link normalizeRouteUrl}); Fastify registers both `/api/v1/tasks` and
 * `/api/v1/tasks/` for a prefix-mounted `'/'` route, and both must land on the
 * same rule. Verb-sensitive routes are overridden in
 * {@link METHOD_BINDING_RULES} below, which is consulted first.
 *
 * | url                                          | rule                                   |
 * |----------------------------------------------|----------------------------------------|
 * | /health/detailed                             | global — server health, no project     |
 * | /api/v1/me                                   | global — caller's own identity         |
 * | /api/v1/me/tokens, /:id, /active             | global — the caller's own credentials  |
 * | /api/v1/models                               | global — static model catalogue        |
 * | /api/v1/settings/model-policy (GET)          | global — read of a DB-wide setting     |
 * | /api/v1/settings/model-policy (PUT)          | deny   — writes a DB-wide setting      |
 * | /api/v1/projects (GET)                       | deny   — enumerates every project      |
 * | /api/v1/projects (POST)                      | deny   — creates a project outside any |
 * |                                              |          existing binding              |
 * | /api/v1/projects/:id (+ all subroutes)       | resolve ← params.id (direct)           |
 * | /api/v1/events                               | resolve ← query.project_id             |
 * | /api/v1/tasks (GET)                          | resolve ← query.project_id             |
 * | /api/v1/tasks (POST)                         | resolve ← body.project_id (+ optional  |
 * |                                              |   body.parent_task_id, indirect)       |
 * | /api/v1/tasks/completion-report              | resolve ← query.project_id             |
 * | /api/v1/tasks/:id (+ most subroutes)         | resolve ← params.id (INDIRECT: task →  |
 * |                                              |   project)                             |
 * | /api/v1/tasks/:id (PUT)                      | resolve ← params.id + optional         |
 * |                                              |   body.blocked_by[] (all indirect)     |
 * | /api/v1/tasks/:id/dependencies (POST)        | resolve ← params.id + body             |
 * |                                              |   .blocks_task_id (both indirect)      |
 * | /api/v1/tasks/:id/dependencies/:blocksTaskId | resolve ← params.id + params           |
 * |                                              |   .blocksTaskId (both indirect)        |
 *
 * The dependency routes deliberately resolve BOTH endpoints of the edge. An
 * edge is a two-sided relationship; letting a token bound to project A wire a
 * task in A to a task in B would leak structure across the boundary in exactly
 * the direction this gate exists to close.
 */
const BINDING_RULES: Record<string, BindingRule> = {
  // ── no project dimension ────────────────────────────────────────────────
  '/health/detailed': { kind: 'global' },
  '/api/v1/me': { kind: 'global' },
  '/api/v1/me/tokens': { kind: 'global' },
  '/api/v1/me/tokens/active': { kind: 'global' },
  '/api/v1/me/tokens/:id': { kind: 'global' },
  '/api/v1/models': { kind: 'global' },
  '/api/v1/settings/model-policy': { kind: 'global' },

  // ── project id in the path ──────────────────────────────────────────────
  '/api/v1/projects/:id': { kind: 'resolve', sources: [{ from: 'projectParam', key: 'id' }] },
  '/api/v1/projects/:id/charter-history': {
    kind: 'resolve',
    sources: [{ from: 'projectParam', key: 'id' }],
  },
  '/api/v1/projects/:id/dependency-graph': {
    kind: 'resolve',
    sources: [{ from: 'projectParam', key: 'id' }],
  },
  '/api/v1/projects/:id/rescore': {
    kind: 'resolve',
    sources: [{ from: 'projectParam', key: 'id' }],
  },
  '/api/v1/projects/:id/rescore-runs': {
    kind: 'resolve',
    sources: [{ from: 'projectParam', key: 'id' }],
  },
  '/api/v1/projects/:id/resolve-model': {
    kind: 'resolve',
    sources: [{ from: 'projectParam', key: 'id' }],
  },
  '/api/v1/projects/:id/topology': {
    kind: 'resolve',
    sources: [{ from: 'projectParam', key: 'id' }],
  },
  '/api/v1/projects/:id/wsjf-health': {
    kind: 'resolve',
    sources: [{ from: 'projectParam', key: 'id' }],
  },
  '/api/v1/projects/:id/wsjf-ranking': {
    kind: 'resolve',
    sources: [{ from: 'projectParam', key: 'id' }],
  },

  // ── project id in the query string ──────────────────────────────────────
  // A bound token must name the project it is filtering on; an unfiltered
  // cross-project read is exactly the enumeration the binding prevents.
  '/api/v1/events': { kind: 'resolve', sources: [{ from: 'projectQuery', key: 'project_id' }] },
  '/api/v1/tasks/completion-report': {
    kind: 'resolve',
    sources: [{ from: 'projectQuery', key: 'project_id' }],
  },

  // ── task id in the path → project resolved INDIRECTLY ───────────────────
  '/api/v1/tasks/:id': { kind: 'resolve', sources: [{ from: 'taskParam', key: 'id' }] },
  '/api/v1/tasks/:id/claim': { kind: 'resolve', sources: [{ from: 'taskParam', key: 'id' }] },
  '/api/v1/tasks/:id/comments': { kind: 'resolve', sources: [{ from: 'taskParam', key: 'id' }] },
  '/api/v1/tasks/:id/comments/:commentId': {
    kind: 'resolve',
    sources: [{ from: 'taskParam', key: 'id' }],
  },
  '/api/v1/tasks/:id/dependencies': {
    kind: 'resolve',
    sources: [{ from: 'taskParam', key: 'id' }],
  },
  '/api/v1/tasks/:id/dependencies/:blocksTaskId': {
    kind: 'resolve',
    sources: [
      { from: 'taskParam', key: 'id' },
      { from: 'taskParam', key: 'blocksTaskId' },
    ],
  },
  '/api/v1/tasks/:id/score-history': {
    kind: 'resolve',
    sources: [{ from: 'taskParam', key: 'id' }],
  },
  '/api/v1/tasks/:id/subtasks': { kind: 'resolve', sources: [{ from: 'taskParam', key: 'id' }] },
  '/api/v1/tasks/:id/wsjf': { kind: 'resolve', sources: [{ from: 'taskParam', key: 'id' }] },
};

/**
 * Verb-sensitive overrides, consulted BEFORE {@link BINDING_RULES}. Keyed
 * `"<METHOD> <normalized url>"`.
 *
 * `/api/v1/projects` and `/api/v1/settings/model-policy` are the two urls
 * where the verb changes the answer, and `/api/v1/tasks` is a third: the list
 * read filters by `?project_id`, while the create names its project in the
 * body. `PUT /api/v1/tasks/:id` and `POST /api/v1/tasks/:id/dependencies`
 * additionally pull task ids out of the body, so they override the base rule
 * for their url too.
 */
const METHOD_BINDING_RULES: Record<string, BindingRule> = {
  // Cross-project by construction — no narrowing is possible.
  'GET /api/v1/projects': { kind: 'deny' },
  'HEAD /api/v1/projects': { kind: 'deny' },
  'POST /api/v1/projects': { kind: 'deny' },
  'PUT /api/v1/settings/model-policy': { kind: 'deny' },

  // Task collection: filter on read, declaration on create.
  'GET /api/v1/tasks': { kind: 'resolve', sources: [{ from: 'projectQuery', key: 'project_id' }] },
  'HEAD /api/v1/tasks': { kind: 'resolve', sources: [{ from: 'projectQuery', key: 'project_id' }] },
  'POST /api/v1/tasks': {
    kind: 'resolve',
    sources: [
      { from: 'projectBody', key: 'project_id' },
      // A subtask may not be smuggled under a parent in another project.
      { from: 'taskBody', key: 'parent_task_id', optional: true },
    ],
  },

  // `blocked_by` is the atomic block-with-dependency affordance on update
  // (task #1004): it creates edges from arbitrary other task ids, so those
  // tasks are part of the request's target set.
  'PUT /api/v1/tasks/:id': {
    kind: 'resolve',
    sources: [
      { from: 'taskParam', key: 'id' },
      { from: 'taskBodyArray', key: 'blocked_by', optional: true },
      { from: 'taskBody', key: 'parent_task_id', optional: true },
    ],
  },
  'POST /api/v1/tasks/:id/dependencies': {
    kind: 'resolve',
    sources: [
      { from: 'taskParam', key: 'id' },
      { from: 'taskBody', key: 'blocks_task_id' },
    ],
  },
};

/**
 * Prefix rules, consulted only when neither exact table matched. The single
 * entry covers the Swagger UI surface (`/docs`, `/docs/json`,
 * `/docs/static/*`, …), which is mounted inside an authenticated scope under
 * `ENABLE_SWAGGER_IN_PRODUCTION` and whose route urls are generated by a
 * third-party plugin, so they cannot be enumerated exactly here. API
 * documentation is static and carries no project rows, so `global` is
 * accurate rather than merely convenient.
 */
const PREFIX_BINDING_RULES: ReadonlyArray<{ prefix: string; rule: BindingRule }> = [
  { prefix: '/docs', rule: { kind: 'global' } },
];

/**
 * Strip a single trailing slash so the `/api/v1/tasks` and `/api/v1/tasks/`
 * forms Fastify registers for one prefix-mounted route share a rule. `'/'`
 * itself is left alone.
 */
export function normalizeRouteUrl(url: string): string {
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Look up the rule for a method + url pair, or `undefined` when the route is
 * unclassified (which the caller must treat as "cannot determine").
 *
 * Exported so the drift guard can assert coverage of the built route table
 * without duplicating the lookup order.
 */
export function findBindingRule(method: string, url: string): BindingRule | undefined {
  const normalized = normalizeRouteUrl(url);
  const byMethod = METHOD_BINDING_RULES[`${method.toUpperCase()} ${normalized}`];
  if (byMethod !== undefined) {
    return byMethod;
  }
  const byUrl = BINDING_RULES[normalized];
  if (byUrl !== undefined) {
    return byUrl;
  }
  return PREFIX_BINDING_RULES.find(
    (entry) => normalized === entry.prefix || normalized.startsWith(`${entry.prefix}/`),
  )?.rule;
}

/**
 * Coerce a raw params/query/body value to a positive integer id, or `null`
 * when it is absent or not one.
 *
 * Query and param values arrive as strings for routes whose Zod schema uses
 * `z.coerce.number()` only AFTER validation rewrites them — and the auth
 * preHandler runs after validation, so they are normally already numbers.
 * Accepting the string form as well keeps the resolver correct for any route
 * that does not coerce, instead of silently failing open… which it would not
 * do anyway (an unparseable value yields `null` ⇒ refused), but a needless
 * denial is still a bug.
 */
function toPositiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return parsed > 0 ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Resolve the set of project ids the request would touch.
 *
 * Returns `null` for "cannot determine" — an unclassified route, a `deny`
 * route, a missing required id, or a task id that names no existing row.
 * Returns `[]` ONLY for a `global` route (no project dimension at all), and a
 * non-empty array otherwise. That distinction is load-bearing: `[]` is
 * satisfied by every binding whereas `null` is satisfied by none, so a
 * resolver that "found nothing" must never return `[]`.
 */
export function resolveTargetProjects(
  request: FastifyRequest,
  deps: ProjectBindingDeps,
): number[] | null {
  const rule = findBindingRule(request.method, request.routeOptions.url ?? '');
  if (rule === undefined || rule.kind === 'deny') {
    return null;
  }
  if (rule.kind === 'global') {
    return [];
  }

  const params = asRecord(request.params);
  const query = asRecord(request.query);
  const body = asRecord(request.body);
  const targets: number[] = [];

  for (const source of rule.sources) {
    switch (source.from) {
      case 'projectParam':
      case 'projectQuery':
      case 'projectBody': {
        const bag =
          source.from === 'projectParam' ? params : source.from === 'projectQuery' ? query : body;
        const projectId = toPositiveInt(bag[source.key]);
        if (projectId === null) {
          return null;
        }
        targets.push(projectId);
        break;
      }
      case 'taskParam':
      case 'taskBody': {
        const raw = source.from === 'taskParam' ? params[source.key] : body[source.key];
        if (raw === undefined || raw === null) {
          // `parent_task_id: null` on update means "detach", which names no
          // task at all — that is why the optional sources tolerate absence.
          if (source.from === 'taskBody' && source.optional === true) break;
          return null;
        }
        const taskId = toPositiveInt(raw);
        if (taskId === null) {
          return null;
        }
        const projectId = resolveTaskProject(taskId, deps);
        if (projectId === null) {
          return null;
        }
        targets.push(projectId);
        break;
      }
      case 'taskBodyArray': {
        const raw = body[source.key];
        if (raw === undefined || raw === null) {
          if (source.optional === true) break;
          return null;
        }
        if (!Array.isArray(raw)) {
          return null;
        }
        for (const entry of raw) {
          const taskId = toPositiveInt(entry);
          if (taskId === null) {
            return null;
          }
          const projectId = resolveTaskProject(taskId, deps);
          if (projectId === null) {
            return null;
          }
          targets.push(projectId);
        }
        break;
      }
    }
  }

  // A `resolve` rule with sources that all matched always contributes at
  // least one target, EXCEPT when every source was optional and absent. That
  // combination would produce `[]`, which every binding satisfies — so it is
  // converted to `null` (refused) to preserve the "empty means global only"
  // invariant the predicate depends on.
  return targets.length === 0 ? null : targets;
}

/**
 * Dereference a task id to its owning project through the service layer.
 * Returns `null` when the task does not exist OR when the service is not
 * wired into this Fastify instance (a minimal test harness, say) — both are
 * "cannot determine", and both must therefore refuse rather than allow.
 */
function resolveTaskProject(taskId: number, deps: ProjectBindingDeps): number | null {
  if (deps.taskService === undefined) {
    return null;
  }
  return deps.taskService.findProjectIdForTask(taskId);
}
