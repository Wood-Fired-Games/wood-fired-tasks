---
name: set-models
description: Adaptive model-policy interview for Wood Fired Tasks — links a Claude model to each pipeline role (execution, validation, planning), routing execution/validation by the six power categories (Minimal · Light · Moderate · Strong · Heavy · Maximum) with monotonically-rising suggestions after each pick, then persists the resulting ModelPolicy to the project layer (update_project) or the global default layer (set_model_defaults). Use when configuring which models the loop worker / verifier / planner run on, setting per-category model power, or when asked to run the model interview.
argument-hint: [--global | --project <id>]
disable-model-invocation: false
---

# Set Models — Adaptive Model-Policy Interview

Walks the user through assigning a Claude model to each **pipeline role** and
each **power category**, then persists the assembled `ModelPolicy` to the
chosen layer. The policy is what `resolve_model` later reads to pick the model
for every `/tasks:loop` worker (`execution`), `/tasks:loop` verifier
(`validation`), and `/tasks:decompose` / `/tasks:audit` planner (`planning`).

The design contract — `ModelPolicy` shape, the six power categories, the
`jobSize → category` bijection, runtime discovery, and the two-layer merge — is
the source of truth in
[`docs/superpowers/specs/2026-06-09-configurable-task-models-design.md`](../../docs/superpowers/specs/2026-06-09-configurable-task-models-design.md).
Where this skill and that spec could drift, the spec wins. Section
references below (§N) point into it.

> **Mental model.** You are filling in a small table: three roles × (for
> `execution` / `validation`) six power categories. You do it by asking the
> user one question at a time, offering the **live** model catalog plus an
> "auto" escape hatch, and you keep each subsequent suggestion at least as
> powerful as the last so the table reads as a sensible ascending ladder. You
> write exactly once, at the end, to the layer the user targeted.

---

## Roles and categories (§4)

Three roles are configured:

| Role | Drives | Category-routed? |
| --- | --- | --- |
| `execution` | `/tasks:loop` Step 4 worker; `/tasks:loop-dag` §3b worker | yes — by task power category |
| `validation` | `/tasks:loop` Step 7 verifier; `/tasks:loop-dag` §3d verifier | yes — by task power category |
| `planning` | `/tasks:decompose` recon/planner/critic; `/tasks:audit` agent; `/tasks:loop-dag` integration-auditor | no — a single constant model (or `auto`) |

The six **power categories** (a fixed 1:1 relabel of the six WSJF `jobSize`
Fibonacci tiers) express *how much model power a task warrants*, walked
**minimal → maximum**:

| Category key | Display name | jobSize tier |
| --- | --- | --- |
| `minimal` | Minimal | 1 |
| `light` | Light | 2 |
| `moderate` | Moderate | 3 |
| `strong` | Strong | 5 |
| `heavy` | Heavy | 8 |
| `maximum` | Maximum | 13 |

`auto` is a sentinel meaning "let `resolve_model` pick a live catalog model
matching the slot's implied power level at dispatch time" — it is NOT a model
id.

---

## Procedure

### 1. Load tools

`ToolSearch` for the wood-fired-tasks MCP tools this skill calls, then invoke
them by their loaded schemas:

- `mcp__wood-fired-tasks__list_models` — runtime catalog + `stale` flag.
- `mcp__wood-fired-tasks__resolve_model` — (optional) preview what a slot would
  resolve to.
- `mcp__wood-fired-tasks__get_project` — read the target project's current
  `model_policy` (project layer).
- `mcp__wood-fired-tasks__update_project` — persist a `ModelPolicy` to the
  **project** layer.
- `mcp__wood-fired-tasks__get_model_defaults` — read the **global** default
  `ModelPolicy` from `app_settings`.
- `mcp__wood-fired-tasks__set_model_defaults` — persist a `ModelPolicy` to the
  **global** layer.

If `ToolSearch` cannot find one of these, STOP and report which tool is
missing (the model-policy tools register only when the model services are
wired — see Task 11/15).

### 2. Resolve the target layer

Parse the argument:

- `--global` → the **global** default layer. Read the current policy with
  `get_model_defaults`; you will persist with `set_model_defaults`.
- `--project <id>` (or a bare project id/name) → the **project** layer. Resolve
  the project with `get_project`; read its current `model_policy`; you will
  persist with `update_project`.

If neither is given, ask the user which layer to configure (global default vs a
specific project) before continuing. Show the current per-category table (if
any policy already exists) so the user is editing, not blind-filling.

### 3. Discover the live model catalog (§7)

Call `list_models`. The result is the catalog the question options are drawn
from.

> **Stale warning.** If the result has `stale: true`, the runtime could not
> reach the Models API and the catalog is the small built-in static fallback
> list. **Warn the user explicitly** that the suggestions come from a static
> fallback and may not reflect the models actually available to the harness,
> then continue with the fallback list.

### 4. Walk `execution`, then `validation` (category-routed)

For role `execution`, then role `validation`, walk the six categories in
ascending order **minimal → light → moderate → strong → heavy → maximum**. Ask
**one `AskUserQuestion` per category**:

- **Options** = the discovered catalog models (live or fallback) **plus** a
  final `"Let me decide (auto)"` option that records the `auto` sentinel for
  that category.
- **Recommended (first/default) option** is derived from the **previous pick**
  in the same role to form a **monotonic capability ladder**: the recommended
  model for category *N* must be **≥** the capability of the model picked for
  category *N−1*. Concretely, after each pick, set the next category's
  recommended option to the lowest catalog model whose implied power is at
  least the last pick's power. For the first category (`minimal`) recommend the
  lowest-power catalog model.
- **`auto` is skipped in the ladder:** if the user picks `"Let me decide
  (auto)"` for a category, do NOT advance the ladder floor from it — carry the
  last *concrete* pick forward as the floor for the next recommendation.

Record each pick under `byCategory[<category>]` for the role. A category the
user explicitly leaves at `auto` stores the `auto` sentinel; categories may be
left unset to fall through to the role `default` / next layer (§4.4) — but the
ascending walk fills all six by default.

### 5. Ask the single planning question

For role `planning`, ask **one** question: a single model for the constant
planning slot, with the same `"Let me decide (auto)"` option. Record it as
`planning.constant`. Only if the user explicitly asks for per-category planning
routing, branch into the same six-category walk for `planning.byCategory`;
otherwise the constant governs (§5).

### 6. Confirm and persist

Assemble the `ModelPolicy`:

```json
{
  "execution":  { "byCategory": { "minimal": "…", "light": "…", "moderate": "…", "strong": "…", "heavy": "…", "maximum": "…" } },
  "validation": { "byCategory": { "minimal": "…", "light": "…", "moderate": "…", "strong": "…", "heavy": "…", "maximum": "…" } },
  "planning":   { "constant": "…" }
}
```

(Each leaf is a model id **or** the `auto` sentinel.) Echo the assembled policy
back as a per-category table and ask the user to confirm. On confirmation,
persist to the resolved layer:

- **project layer** → `update_project { id: <project id>, model_policy: <policy> }`.
- **global layer** → `set_model_defaults { model_policy: <policy> }`.

Do not write before the user confirms.

### 7. Echo the resolved table

After the write succeeds, print the resolved per-category table back so the
user sees the final state of every slot:

| Category | execution | validation |
| --- | --- | --- |
| Minimal | … | … |
| Light | … | … |
| Moderate | … | … |
| Strong | … | … |
| Heavy | … | … |
| Maximum | … | … |

…plus the single `planning` model. Note that `auto` entries will be resolved to
a concrete live model at dispatch time by `resolve_model`.

---

## Anti-fabrication note

Every model id you offer or persist must come from a `list_models` result that
returned in a prior turn — never invent or guess model ids. The only non-id
value permitted in a slot is the `auto` sentinel.
