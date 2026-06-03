---
name: create-task
description: Creates a new task with configurable project, priority, and assignee. Use when user wants to add a task, create work items, or plan new work.
argument-hint: [title]
disable-model-invocation: false
---

# Create Task Workflow

Creates a new task in the Wood Fired Tasks system with full configuration options.

## Preflight: identity + MCP tools

**Resolve a real identity** before the `created_by` field — do NOT pass the literal `"user"` (that destroys cross-machine audit attribution). In priority order: (1) `git config user.email`, (2) `$USER`, (3) `claude-<model>-<purpose>` (e.g. `claude-opus-4.7-create-task`). Pick once at top of invocation and capture as `$CREATED_BY`.

This skill calls tools on the `wood-fired-tasks` MCP server. Shorthand `wood-fired-tasks:<tool>` ↔ harness name `mcp__wood-fired-tasks__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-tasks__create_task,mcp__wood-fired-tasks__list_projects`) and retry.

## Steps

1. **Parse Title**
   - Extract title from $ARGUMENTS

2. **Gather Task Details**

   Ask user for or extract from context:

   - **project**: Use `wood-fired-tasks:list_projects` to show available projects if not specified
   - **priority**: Default 'medium'. Valid values: low, medium, high, urgent
   - **assignee**: Optional. If not specified, leave unset
   - **description**: Optional. If not specified, leave unset
   - **estimated_minutes**: Optional. Estimated work duration in minutes
   - **due_date**: Optional. ISO 8601 format (e.g., 2026-02-15T12:00:00Z)
   - **tags**: Optional. Comma-separated list (e.g., feature, enhancement, refactor)

3. **Score the task (WSJF single-create classification)**

   > **Opt-out — skip this whole step if WSJF scoring is unwanted.** Scoring is
   > opt-in and adds a per-task LLM classification pass (extra cost + latency +
   > nondeterminism). To opt out — the user doesn't use WSJF, the project has no
   > value charter, or this is a quick one-off — **omit `wsjf_submission` from
   > the `create_task` call** and jump to Step 4. The task is created unscored
   > and ordered by its `priority` field, exactly as before WSJF existed. This
   > is the create-time analogue of the skippable `/tasks:new-project` charter
   > interview; nothing downstream breaks on an unscored task.

   This step produces a `wsjf_submission` so the new task lands ranked, not
   unscored. It follows the [wsjf-rubric.md](wsjf-rubric.md) classification
   contract — **emit closed-enum classifications + verbatim evidence spans,
   NEVER numbers**. The server recomputes the four Fibonacci components and the
   WSJF ratio; it rejects any evidence span that is not a verbatim substring of
   the task text or charter. This step **NEVER blocks task creation** (see
   Fallback below).

   1. **Fetch the parent charter (live).** Call `wood-fired-tasks:get_project`
      for the selected `project_id` and read `value_charter`. The charter's
      `value_themes` (each a `{name, weight}` with a Fibonacci weight) are the
      **live enum** that `themeName` is sourced from and the yardstick for User
      Business Value. Use the values as they currently are in the project — do
      not cache or invent themes.

   2. **Classify against charter themes.** Per the rubric, emit a
      `WsjfClassification` for the task:
      - `themeName`: the exact `name` of the live charter `value_themes` entry
        this task serves (verbatim match — do not invent a theme), or `null` if
        there is no charter (see Empty-charter fallback). User Business Value is
        then **charter theme weight × alignment**: the server resolves that
        theme's `weight` from the live charter and computes UBV via
        `ubvFromThemeAlignment(theme.weight, alignment)` — you never emit the
        weight or the resulting number, only the `themeName` + `alignment`.
      - `alignment`: one of `none | weak | direct | core`.
      - `severity`: one of `none | tech_debt | security | data_loss | compliance`.
      - `decay`: `null` when the task text carries a real deadline date (the
        server scores Time Criticality from the parsed deadline); otherwise one
        of `flat | slow | fast`.
      - `jobSizeTier`: a single tier `1 | 2 | 3 | 5 | 8 | 13` that MUST sit
        inside the server's Job Size band (see the rubric's Job Size table).
      - `evidence`: four **verbatim** spans (`value`, `timeCriticality`,
        `riskOpportunity`, `jobSize`), each quoted exactly from the task
        title/description/acceptance criteria or the charter.

      **Objective components from text/graph.** You do not score the cost-of-delay
      numbers; the server derives its own deterministic features (days-until
      a parsed deadline date in the text, transitive dependents from the task
      graph, files-touched / keyword priors over the text) and computes Value,
      Time Criticality, Risk/Opportunity, and the Job Size band from them. Your
      job is the classification + verbatim spans that anchor those features.
      For a single task, anchor **relative to the project's existing scored
      tasks and the charter**, not an absolute scale.

   3. **Empty-charter fallback (record it in evidence).** When the project has
      **no** charter (`value_charter` null/empty) there are no `value_themes` to
      source `themeName` from, so set `themeName: null` and take the
      **signal-based path**: derive `alignment` / `severity` / `decay` from the
      task text signals alone. With no theme there is no weight, so UBV degrades
      to the alignment-only floor (`ubvFromThemeAlignment` with weight `1`)
      instead of charter theme weight × alignment. You MUST RECORD the fallback
      in the evidence spans — quote the task-text signal you classified from and
      state it stood in for an absent charter theme (e.g. an evidence span that
      names the in-text signal rather than a charter theme). The server still
      recomputes; the recorded fallback makes the score auditable as
      signal-derived rather than charter-derived.

   4. **Submit, with bounded retry then priority fallback (NEVER block).** Pass
      the classification as `wsjf_submission` on the `create_task` call in Step 4.
      The server's deterministic gate may reject the submission with a structured
      per-violation error (e.g. an evidence span that is not a verbatim
      substring, a `jobSizeTier` outside the band, or a contradiction such as
      `jobSize` tier `1` with `value` tier `13`). On rejection:
      - **Bounded retry:** fix EVERY reported violation in one pass and resubmit.
        Retry at most **twice** (3 total attempts).
      - **Gate exhaustion → priority fallback:** if still rejected after the
        bounded retries, **create the task WITHOUT `wsjf_submission`** (unscored —
        the existing priority field orders it). Task creation MUST succeed; WSJF
        scoring is best-effort and never blocks the create.

4. **Create Task**

   Call `wood-fired-tasks:create_task` with all gathered parameters:
   - title: [parsed title]
   - description: [if provided]
   - priority: [selected priority, default 'medium']
   - project_id: [selected project_id]
   - assignee: [if provided]
   - estimated_minutes: [if provided]
   - due_date: [if provided]
   - tags: [if provided]
   - created_by: `$CREATED_BY` from Preflight (NOT the literal "user")
   - wsjf_submission: [the `{classification, features}` from Step 3, UNLESS the
     gate was exhausted — then omit it (priority fallback)]

   The server stamps the resulting `wsjf_score_history` row with
   `trigger='single_create'` so a single-create score is auditable distinctly
   from a decompose-batch score.

5. **Confirm Creation**

   Display:
   - Task ID
   - Title
   - Priority
   - Project name
   - Assignee (if set)

## Priority Values Reference

Canonical priority values (low → high): `low`, `medium`, `high`, `urgent`. There is no `critical` (use `urgent`) and no `normal` (use `medium`).

## Notes

- Default priority is medium
- All optional parameters can be omitted
- Created by user attribution always included
- Use ISO 8601 format for due dates
