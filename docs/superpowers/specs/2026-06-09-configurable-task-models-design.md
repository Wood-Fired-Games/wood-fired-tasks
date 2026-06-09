# Configurable models for orchestration / execution / validation

- **Status:** Draft (design approved in brainstorming, 2026-06-09)
- **Author:** Stuart (via Claude Code brainstorming)
- **Related:** `skills/tasks/loop.md`, `skills/tasks/loop-dag.md`, `skills/tasks/decompose.md`, `skills/tasks/audit.md`, `skills/tasks/wsjf-rubric.md`, `src/schemas/project.schema.ts`

## 1. Problem

The `/tasks:loop`, `/tasks:loop-dag`, `/tasks:decompose`, and `/tasks:audit` skills all dispatch
subagents through the Claude Code `Agent` tool. Today none of them pass a `model:` parameter, so every
dispatched agent inherits the orchestrator's session model. There is no way to run cheap/fast models for
small or low-stakes work and reserve the strongest models for hard implementation or grading.

We want the model used for **execution** (the loop worker) and **validation** (the verifier / grader) to be
configurable, with the **orchestrator always remaining the current session model**, and we want the same
mechanism to cover the other agent-dispatch sites (decompose, audit, integration-auditor). The choice of
model should adapt to task size, be expressible in plain "how much power does this warrant" terms, support
deferring the decision to the agent, discover available models at runtime (new model classes ship
periodically), and resolve through a project-over-database-default hierarchy.

## 2. Goals

- Orchestrator is **always** the current session model — never overridden.
- Per-role model selection for three pipeline roles: **execution**, **validation**, **planning**.
- Execution and validation route by **task size**, expressed as six **power categories** (not raw WSJF
  Fibonacci values).
- A `auto` option that defers the model choice to the orchestrator at dispatch time.
- **Runtime model discovery** so new model classes are usable without a code change.
- An **adaptive interview** that links a model to each category, with suggestions that update after each
  pick.
- Two-tier resolution: **per-project** policy layered over a **database-wide default** policy, with per-slot
  merge. A project with no policy is fully governed by the DB defaults; if both layers leave a slot unset,
  the dispatch inherits the session model.
- Fully backward compatible: with no configuration anywhere, behavior is identical to today.

## 3. Non-goals

- Changing how WSJF scores are computed or how `jobSize` is classified (see `wsjf-rubric.md`). We only
  *read* the existing `jobSize` tier.
- Overriding the orchestrator's own model.
- Cross-provider model routing. The catalog and dispatch target Anthropic models only.
- A general-purpose application settings framework. We add exactly one global-defaults slot.

## 4. Concepts

### 4.1 Pipeline roles

| Role | Where it dispatches | Size-routed? |
|------|---------------------|--------------|
| `execution` | `loop.md` Step 4 worker; `loop-dag.md` §3b worker | yes |
| `validation` | `loop.md` Step 7 verifier; `loop-dag.md` §3d verifier | yes |
| `planning` | `decompose.md` recon (Explore) / planner / critic; `audit.md` agent; `loop-dag.md` integration-auditor | no (constant by default; may opt into category routing) |

The orchestrator session is not a role — it is the context already running and is never assigned a model.

### 4.2 Power categories

Six categories that imply *how much model power a task warrants*. They are a fixed 1:1 relabel of the six
WSJF `jobSize` Fibonacci tiers, so the user thinks in power while the resolver maps internally. The WSJF
Fibonacci internals stay hidden from the model-policy surface.

| Category | internal `jobSize` tier |
|----------|------------------------|
| `minimal`  | 1  |
| `light`    | 2  |
| `moderate` | 3  |
| `strong`   | 5  |
| `heavy`    | 8  |
| `maximum`  | 13 |

Default display names: **Minimal · Light · Moderate · Strong · Heavy · Maximum**. The category *keys* above
are stable identifiers used in storage and APIs; display labels are presentation-only and may be themed
(e.g. the wood-fired set *Ember · Kindling · Flame · Blaze · Forge · Inferno*) without changing the keys.

The `jobSize` → category bijection is a constant owned by `model-policy.service.ts`. It is the single place
that knows the six-tier Fibonacci set maps onto the six category keys.

### 4.3 Model reference values

Every model slot holds one of:

- A **concrete model id** as returned by the runtime catalog (e.g. `claude-opus-4-8`, or a future class such
  as `claude-fable-5-…`).
- The sentinel **`auto`** — defer the choice to the orchestrator at dispatch time, which selects a live
  catalog model matching the slot's implied power level.

Slots may be unset (absent), which makes resolution fall through to the next layer.

## 5. Data model

Same `ModelPolicy` shape at both layers. Each role is either category-routed (`byCategory`) or a single
`constant` model, plus an optional role-level `default` used when a category lookup misses.

```jsonc
{
  "execution": {
    "byCategory": {
      "minimal":  "<model-id | auto>",
      "light":    "<model-id | auto>",
      "moderate": "<model-id | auto>",
      "strong":   "<model-id | auto>",
      "heavy":    "<model-id | auto>",
      "maximum":  "<model-id | auto>"
    },
    "default": "<model-id | auto>"
  },
  "validation": { "byCategory": { /* same keys */ }, "default": "<model-id | auto>" },
  "planning":   { "constant": "<model-id | auto>" }
}
```

- Every field is optional. An empty object `{}` is a valid policy (everything falls through).
- `byCategory` and `constant` are mutually exclusive within a role; if both are present, `byCategory` wins
  and `constant` is ignored (validation warns).
- A role may set only a subset of categories; missing categories fall to `default`, then to the next layer.

### 5.1 Zod schema

New `src/schemas/model-policy.schema.ts`:

- `ModelRefSchema = z.union([z.string().min(1).max(200), z.literal('auto')])` — a concrete id or `auto`.
  (Concrete ids are not validated against the live catalog at write time; the catalog is dynamic and may be
  offline. Unknown ids are tolerated and handled at dispatch via fallback — see §9.)
- `PowerCategorySchema = z.enum(['minimal','light','moderate','strong','heavy','maximum'])`.
- `ByCategorySchema = z.object({ minimal, light, moderate, strong, heavy, maximum }).partial()` of
  `ModelRefSchema`.
- `RolePolicySchema = z.object({ byCategory: ByCategorySchema.optional(), constant: ModelRefSchema.optional(), default: ModelRefSchema.optional() }).strict()`.
- `ModelPolicySchema = z.object({ execution: RolePolicySchema, validation: RolePolicySchema, planning: RolePolicySchema }).partial().strict()`.
- `ModelPolicyNullableSchema = ModelPolicySchema.nullable()` — mirrors the `ValueCharterNullableSchema`
  pattern in `project.schema.ts` (full policy, explicit `null` to clear, or absent to leave untouched).

### 5.2 Storage

- **Per-project:** add a `model_policy` column to `projects` (nullable JSON text, parsed on read like
  `value_charter` from migration 014). New migration `016-model-policy.ts` (next in sequence after
  `015-wsjf-audit.ts`).
- **Database-wide default:** a singleton settings row. The same `016` migration creates an `app_settings`
  table with a single row (`id = 1`) and a `model_policy_default` nullable JSON column. The table is a
  deliberately minimal key-area for global defaults; this design adds only the model-policy default and does
  not turn it into a general settings framework.

Both columns default to `NULL`, so the migration is a no-op for existing data and preserves current behavior
until a policy is written.

## 6. Resolution algorithm

Owned entirely by `src/services/model-policy.service.ts` (the single owner of both layers, the category
bijection, and the merge). Callers never see the layering.

`resolveModel(projectId, role, taskId?) → { model: string } | { model: 'auto' } | null`

1. Load `project.model_policy` (may be `null`) and `app_settings.model_policy_default` (may be `null`).
2. Determine the slot key for this role:
   - `execution` / `validation`: if `taskId` is given and the task has a `jobSize` tier, map tier → category
     and use `byCategory[category]`. If the task has no `jobSize` (unscored), there is no category — use the
     role `default` only.
   - `planning`: use `constant` (or `byCategory[category]` only if a category-routed planning policy is
     configured and a `taskId`/category is available; otherwise `constant`/`default`).
3. **Per-slot merge** (project preferred over global, computed independently per slot):
   ```
   effective.byCategory[cat] = project[role].byCategory[cat] ?? global[role].byCategory[cat]
   effective.constant        = project[role].constant        ?? global[role].constant
   effective.default         = project[role].default         ?? global[role].default
   ```
4. Resolve in order: `effective.byCategory[cat]` (or `effective.constant` for non-routed) → `effective.default`
   → `null`.
5. Return value:
   - concrete id → `{ model: id }`
   - `'auto'` → `{ model: 'auto' }` (caller resolves against the live catalog — see §7.3)
   - nothing found → `null` (caller passes no `model:` to `Agent`, inheriting the session model).

The function is pure given its three inputs (policy layers + task `jobSize`) and is unit-tested across the
matrix: project-only, global-only, both (per-slot merge), neither, unscored task, `auto` at each layer,
`byCategory` vs `constant` collision.

## 7. Runtime model discovery

### 7.1 Catalog service

New `src/services/model-catalog.service.ts`:

- Fetches the live catalog from the Anthropic Models API (`GET https://api.anthropic.com/v1/models`) using
  `ANTHROPIC_API_KEY` from the environment.
- Returns `ModelCatalogEntry[]`: `{ id, display_name, family, created_at }`.
- Caches the result in-process with a short TTL (default 10 minutes) to avoid hammering the API across a loop
  run; exposes a `refresh()` to bust the cache.
- **Graceful degrade:** if the key is absent, the request fails, or the network is unreachable, fall back to a
  small built-in static list of known families and mark the catalog `stale: true`. Discovery never throws to
  the caller.

### 7.2 `list_models` MCP tool / surfaces

- **MCP:** read-only `list_models` tool (conditionally registered when a `modelCatalogService` is wired,
  mirroring how `topology_check` / `wsjf_health` are conditionally registered in `src/mcp/server.ts`).
  Returns the catalog plus the `stale` flag.
- **CLI:** `tasks models list`.
- **API:** `GET /models`.

### 7.3 Resolving `auto` at dispatch

When `resolveModel` returns `{ model: 'auto' }`, the orchestrator skill:

1. Calls `list_models` (cached).
2. Picks the catalog model whose implied power best fits the slot's category. Ranking is a best-effort
   heuristic over catalog metadata (family tier + generation/version + `created_at`); the orchestrator's own
   judgment fills gaps for unfamiliar families. For non-category roles, `auto` selects a sensible mid/high
   model per the role (e.g. planner → strongest available).
3. Passes the chosen id as `Agent` `model:`.

Because `auto` reads the live catalog every dispatch, a project left on `auto` adopts new model classes the
day they appear — no re-interview.

## 8. Adaptive interview — `/tasks:set-models`

A new skill mirroring the `/tasks:new-project` charter-interview pattern (one decision at a time via
`AskUserQuestion`).

**Target selection (first question):**
- `--global` → edits `app_settings.model_policy_default`.
- `--project <id>` (default when invoked against a project) → edits that project's `model_policy`.

**Flow:**
1. Call `list_models` → runtime catalog. If `stale`, warn that suggestions are based on a static fallback list.
2. For each category-routed role (`execution`, then `validation`), walk the six categories **ascending**
   (`minimal` → `maximum`). For each category, ask one `AskUserQuestion` whose options are:
   - the discovered models (most relevant first, per the ranking heuristic),
   - **"Let me decide (auto)"** → stores the `auto` sentinel,
   - ("Other" is always available via the harness for a raw id paste).
3. **Suggestions update after each pick:** the recommended (first) option for category N is derived from the
   model chosen for category N−1, enforcing a **monotonic capability ladder** — a larger category is never
   suggested a weaker model than a smaller one. `auto` slots are skipped in the ladder (they carry no fixed
   capability).
4. For `planning` (constant by default), ask once for a single model (or `auto`). Offer an "advanced: route
   planning by category too" branch only if requested.
5. Show the assembled policy back for confirmation, then persist via `update_project` (project) or
   `set_model_defaults` (global).

**Non-interactive escape hatch** (scripting / CI): CLI flags set slots directly, e.g.
`tasks project set-models <id> --execution-heavy <model-id> --validation-default auto`, and
`tasks settings set-models --planning-constant <model-id>` for the global layer.

## 9. Skill integration & dispatch fallback

Each dispatch site resolves its model immediately before the `Agent` call:

- `loop.md` Step 4 / `loop-dag.md` §3b: `resolve_model(project_id, 'execution', task_id)`.
- `loop.md` Step 7 / `loop-dag.md` §3d: `resolve_model(project_id, 'validation', task_id)`.
- `decompose.md` recon/planner/critic, `audit.md`, integration-auditor: `resolve_model(project_id, 'planning')`.

Resolution result handling:
- `{ model: id }` → pass `model: id` to `Agent`.
- `{ model: 'auto' }` → resolve via `list_models` per §7.3, pass the chosen id.
- `null` → pass no `model:` (inherit session model).

**Dispatch-time fallback (the harness risk).** The Claude Code `Agent` tool documents its `model` parameter
with the aliases `sonnet | opus | haiku`. Whether a freshly-discovered model class id is directly
dispatchable as a subagent depends on the harness accepting that id. The skill therefore: attempts the
dispatch with the resolved id; if the harness rejects the model, it logs a one-line warning, falls back to
**no `model:`** (session model), and continues. This must be verified during planning — the data model and
interview are unaffected by the outcome; only the dispatch-time fallback path is.

**Run-arg override (loop only).** `--execution-model <ref>` / `--validation-model <ref>` /
`--planning-model <ref>` force a single model (concrete id or `auto`) for that role for the whole run,
bypassing per-category resolution. The override is recorded in LOOP-RUN.md frontmatter for auditability
(new optional fields `execution_model` / `validation_model` / `planning_model`, omitted when unset).

`resolve_model` is conditionally registered (like the catalog tool). When unavailable, skills behave exactly
as today (no `model:` passed) — this is the universal backward-compatible fallback.

## 10. Surfaces summary

| Surface | Additions |
|---------|-----------|
| Schema | `src/schemas/model-policy.schema.ts` (`ModelPolicySchema`, `ModelRefSchema`, `PowerCategorySchema`, nullable variant). |
| DB | Migration `016-model-policy.ts`: `projects.model_policy` JSON column + `app_settings` table with `model_policy_default`. |
| Services | `model-policy.service.ts` (resolution + merge + category bijection, single owner), `model-catalog.service.ts` (discovery + cache + degrade). |
| MCP | `model_policy` on `get_project`/`update_project`; `get_model_defaults`/`set_model_defaults`; read-only `list_models`; read-only `resolve_model` (all conditionally registered). |
| CLI | `tasks project set-models` (+ non-interactive flags), `tasks settings set-models`, `tasks models list`, `model_policy` shown in project view. |
| API | `model_policy` on project routes; `GET`/`PUT /settings/model-policy`; `GET /models`. |
| Skills | `/tasks:set-models` (interview); `resolve_model` integration in `loop.md`, `loop-dag.md`, `decompose.md`, `audit.md`; run-arg overrides + LOOP-RUN.md fields. |

## 11. Backward compatibility

- New columns default `NULL`; migration is a no-op for existing rows.
- With no project policy and no DB default, `resolve_model` returns `null` for every role → skills pass no
  `model:` → identical to today.
- New tools are conditionally registered; absence is handled by the existing "tool unavailable → fall back"
  convention already documented in the loop skills.

## 12. Testing

- **`model-policy.service`** unit matrix: project-only / global-only / both (per-slot merge) / neither;
  scored vs unscored task; `auto` at each layer; `byCategory` vs `constant` collision; every category → tier
  bijection entry; missing category → `default` → `null` fall-through.
- **`model-catalog.service`** unit: parse a sample `/v1/models` payload; cache TTL behavior; degrade path
  (no key / network error → static list + `stale: true`, never throws).
- **Schema** unit: valid/invalid `ModelRef`, category enum, strict-mode rejection of unknown keys, nullable
  variant round-trip.
- **Migration** test: forward creates both column + table; round-trip preserves a written policy; existing
  rows read back `NULL`.
- **MCP/CLI/API** surface tests for read/write of both layers and `resolve_model` output shape.
- **Interview** is exercised manually (AskUserQuestion is interactive); the persistence path it calls
  (`update_project` / `set_model_defaults`) is covered by surface tests.

## 13. Open questions / to verify during planning

1. **Harness model acceptance** — confirm which model ids the Claude Code `Agent` tool's `model` parameter
   accepts for subagent dispatch (aliases only vs. full ids vs. new classes). Drives only the §9 fallback,
   not the data model.
2. **Models API auth in all run modes** — confirm `ANTHROPIC_API_KEY` is available where the catalog is
   needed (CLI, MCP stdio, MCP remote). If not, the static-fallback path covers it but suggestions degrade.
3. **`auto` ranking heuristic** — pin the exact metadata fields and ordering rule used to map a category's
   implied power onto a live catalog entry, including the tie-break for brand-new families.
4. **Planning role granularity** — ship `planning` as `constant`-only first, with category routing as a
   documented follow-on, unless category routing for planning is wanted in v1.

## 14. Rollout

1. Schema + migration + `model-policy.service` + tests (no behavior change; nothing reads it yet).
2. `model-catalog.service` + `list_models` + degrade tests.
3. `resolve_model` MCP tool + per-project/global read-write surfaces (MCP/CLI/API).
4. Skill integration in `loop.md` / `loop-dag.md` (execution + validation) behind the conditional-tool
   fallback; LOOP-RUN.md fields + run-arg overrides.
5. `/tasks:set-models` interview.
6. Extend to `decompose.md` / `audit.md` / integration-auditor (`planning` role).
