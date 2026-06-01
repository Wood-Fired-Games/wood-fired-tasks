---
name: new-project
description: Charter-interview a Wood Fired Tasks project — a skippable, one-question-at-a-time setup that captures the project's value charter (mission, ranked value themes, time pressure, risk posture, out-of-scope) so WSJF scoring can derive Business Value from real priorities. Use when starting a new project, setting a project's goal/charter, or when asked to run the project interview.
argument-hint: [project_id-or-name]
disable-model-invocation: false
---

# New Project Charter Interview

Captures a project's **value charter** through a short, skippable interview, then
persists it via the `wood-fired-tasks:update_project` MCP tool. The charter is
what lets WSJF scoring turn "which task matters more" into a relative,
charter-anchored Business Value instead of a guess. The whole interview is
optional: **skipping leaves no charter, and fallback (priority-based) scoring
still works** — nothing here ever blocks task creation or the loop.

This skill is **conversational and STOP-and-wait**: it asks exactly one question
at a time via `AskUserQuestion`, waits for the answer, and only then moves on. It
never batches questions and never invents answers.

## Preflight: identity + MCP tools

**Resolve a real identity** before any write — do NOT pass the literal `"user"`
(that destroys cross-machine audit attribution). In priority order:
(1) `git config user.email`, (2) `$USER`, (3) `claude-<model>-<purpose>` (e.g.
`claude-opus-4.8-new-project`). Pick once at the top of the invocation and
capture it as `$ACTOR`.

This skill calls tools on the `wood-fired-tasks` MCP server. Shorthand
`wood-fired-tasks:<tool>` corresponds to harness name
`mcp__wood-fired-tasks__<tool>`. On `InputValidationError`, load the tools via
`ToolSearch` (`select:mcp__wood-fired-tasks__get_project,mcp__wood-fired-tasks__update_project,mcp__wood-fired-tasks__list_projects,mcp__wood-fired-tasks__list_tasks`)
and retry.

## The value charter (what you are producing)

You are filling in a single JSON object that the `update_project` tool stores in
the project's `value_charter`. Its exact shape:

```jsonc
{
  "mission": "one or two sentences — the project's wedge / what it is for",
  "value_themes": [
    { "name": "Theme name", "weight": 13, "description": "what this theme covers" }
  ],
  "time_context": "the dominant time pressure (deadline window, season, none)",
  "risk_posture": "how much risk the project tolerates / what it must not break",
  "out_of_scope": ["explicit low-value or off-limits work", "..."],
  "interview_version": 1,
  "updated_at": "<ISO 8601 timestamp at write time>"
}
```

Rules the server enforces (respect them as you build the object):

- Each `value_themes[].weight` MUST be a **Fibonacci tier**: `1, 2, 3, 5, 8, 13`.
  No other integer is accepted (e.g. `4` is rejected).
- At most 20 themes; 2–4 is the sweet spot.
- `mission` is required and non-empty if a charter is written at all.
- `interview_version` is `1` for a brand-new charter. (Re-interview that bumps
  this version is a separate concern handled when the charter already exists.)

## Steps

1. **Resolve the project**
   - Take the project id or name from `$ARGUMENTS`. If absent, call
     `wood-fired-tasks:list_projects` and ask the user (via `AskUserQuestion`)
     which project to charter, then STOP and wait for the choice.
   - Call `wood-fired-tasks:get_project` for the chosen project. If it already
     has a `value_charter`, tell the user a charter exists and ask whether to
     **overwrite**, **leave it untouched**, or **abort** (via `AskUserQuestion`,
     STOP and wait). Only proceed to overwrite on explicit confirmation.

2. **Offer the skip up front**
   - Via `AskUserQuestion`, ask: "Set up a value charter now, or skip?" with
     options like `Set up charter` / `Skip for now`. STOP and wait.
   - If the user skips: **do not write any charter.** Confirm that the project
     will use priority-based fallback scoring and that the interview can be run
     again later. End the skill here — this is a valid, complete outcome.

3. **Mission / wedge** (one question)
   - Via `AskUserQuestion`, ask for the project's mission in one or two
     sentences: "In a sentence or two, what is this project for — its wedge?"
   - STOP and wait. Record the answer as `mission`.

4. **Auto-detect candidate value themes, then confirm**
   - BEFORE asking the user to invent themes, gather signal:
     - Call `wood-fired-tasks:list_tasks` for the project and skim task titles /
       descriptions for recurring concerns (e.g. "performance", "onboarding",
       "billing", "reliability").
     - If a repo is in context, skim its top-level structure / README for the
       same.
   - Propose **2–4 candidate themes** derived from that signal. Present them via
     `AskUserQuestion` (multi-select or confirm/edit), e.g. "I detected these
     candidate value themes — keep, drop, or add to them?" STOP and wait.
   - If you found no signal, ask the user to name 2–4 themes directly.
   - The result is a confirmed list of theme names + a one-line description each.

5. **Rank the themes** (one question) → Fibonacci weight mapping
   - Via `AskUserQuestion`, ask the user to **rank** the confirmed themes from
     most to least important. STOP and wait.
   - Map the ranking to Fibonacci `weight` values, highest rank gets the highest
     tier, descending down the scale. Use this mapping:

     | # of themes | Weights by rank (1st → last)  |
     |-------------|-------------------------------|
     | 2 themes    | `13, 5`                        |
     | 3 themes    | `13, 8, 3`                     |
     | 4 themes    | `13, 8, 5, 2`                  |

     For other counts, assign descending Fibonacci tiers from `13` downward,
     keeping each weight in `{1,2,3,5,8,13}` and never repeating a higher tier
     for a lower-ranked theme. Ties may share a weight only if the user
     explicitly says two themes are equally important.

6. **Time pressure** (one question)
   - Via `AskUserQuestion`, ask about the dominant time pressure: a hard
     deadline window, a season, or none. STOP and wait. Record as `time_context`.

7. **Risk posture** (one question)
   - Via `AskUserQuestion`, ask how much risk the project tolerates and what it
     must not break (e.g. "ship fast, accept rough edges" vs. "must not break
     production data"). STOP and wait. Record as `risk_posture`.

8. **Out-of-scope / low-value** (one question)
   - Via `AskUserQuestion`, ask for explicit low-value or off-limits work — the
     things this project should NOT spend value on. STOP and wait. Record as the
     `out_of_scope` string array (may be empty).

9. **Assemble + confirm the charter**
   - Build the charter object from the recorded answers:
     - `mission` (Step 3)
     - `value_themes`: each confirmed theme (Step 4) with its rank-derived
       Fibonacci `weight` (Step 5) and its one-line `description`
     - `time_context` (Step 6), `risk_posture` (Step 7), `out_of_scope` (Step 8)
     - `interview_version`: `1`
     - `updated_at`: the current time in ISO 8601 (e.g. `2026-06-01T12:00:00Z`)
   - Show the assembled charter to the user and ask for final confirmation via
     `AskUserQuestion` (Confirm / Edit). STOP and wait. Loop back to the relevant
     step on an edit request.

10. **Write the charter**
    - Call `wood-fired-tasks:update_project` with:
      - the project id, and
      - `value_charter`: the confirmed charter object.
    - If the server rejects it (e.g. a non-Fibonacci weight slipped through),
      read the structured error, fix the offending field, and retry once.

11. **Confirm**
    - Display:
      - Project name + id
      - The mission
      - The ranked value themes with their weights
      - A note that WSJF scoring will now derive Business Value from this charter
        (and that the interview can be re-run later to update it)

## Skip / fallback behavior

- Skipping at Step 2 — or aborting at any STOP-and-wait prompt — writes **no
  charter**. The project keeps `value_charter` unset and WSJF falls back to
  priority-based scoring. This is fully supported; never force a charter.
- A charter is **all-or-skip at the project level**: either you write a complete,
  valid charter object or you write nothing. Do not persist a half-filled charter.

## Notes

- One question at a time, always STOP and wait for the answer before the next
  question. Never present the whole question set at once.
- Auto-detect-then-confirm: propose themes from real task/repo signal rather than
  asking for a blank-slate list.
- Theme weights are Fibonacci only (`1, 2, 3, 5, 8, 13`); rank order drives the
  tier assignment.
- The charter is written through `update_project`; this skill does not create the
  project itself.
