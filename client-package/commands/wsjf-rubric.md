---
name: wsjf-rubric
description: The WSJF classification contract — the closed enums, the enum-to-Fibonacci tier maps, and the "emit classifications + verbatim evidence spans, never numbers" rule. Referenced (not invoked) by decompose and create-task when they score tasks. This is the SINGLE source of truth for how an agent classifies a task; the server computes the numbers.
disable-model-invocation: true
---

# WSJF Classification Rubric (the scoring contract)

This is the **classification contract** every WSJF-scoring skill obeys
(`decompose` batch scoring, `create-task` single scoring). It is a reference
document, not a runnable command. The rules and tables here are the **single
source of truth** for what an agent emits; the deterministic server functions in
`wsjf.service.ts` turn those classifications into the Fibonacci component scores
and the final WSJF ratio.

> **Canonical alignment.** The enum members and every tier-mapping table below
> mirror the server code byte-for-intent. If this doc and the deterministic
> functions ever disagree, the deterministic functions win — fix this doc to
> match, never the reverse.

---

## The one rule: emit classifications + verbatim spans, NEVER numbers

When you score a task you emit a **classification over closed enums** plus a
**verbatim evidence span** for each WSJF component. You do **NOT** emit any
Fibonacci number, any component score, or any final WSJF value. The server:

1. takes your enum classifications,
2. gathers its own deterministic features (deadline days, DAG fan-out, files
   touched, charter theme weight),
3. computes the four component scores and the WSJF ratio with the pure functions
   below, and
4. rejects your submission if any evidence span is empty or is **not a verbatim
   substring** of the source text / charter you were given.

Concretely, per task you emit a `WsjfClassification`:

- `themeName`: the exact name of a charter value theme (string) the task serves,
  or `null` when there is no charter. It MUST match a theme name verbatim; you
  do not invent themes.
- `alignment`: one of the AlignmentClass enum members (below).
- `severity`: one of the SeverityClass enum members (below).
- `decay`: one of the DecayClass enum members, OR `null`. Use `null` (and let
  the server use the parsed deadline) whenever the task text carries a real
  deadline date; otherwise pick a decay class.
- `jobSizeTier`: a single Fibonacci tier `1 | 2 | 3 | 5 | 8 | 13` that MUST fall
  inside the server's `jobSizeBand` (see the Job Size table). This is the one
  number-shaped field you choose, and it is bounded by the band — you are
  picking a tier inside a server-imposed window, not scoring freely.
- `evidence`: four verbatim spans, one per component
  (`value`, `timeCriticality`, `riskOpportunity`, `jobSize`), each quoted
  exactly from the task text or the charter.

Everything else (UBV, TC, RR, and the final ratio) is computed for you. Never
write a number into `value`, `timeCriticality`, or `riskOpportunity`.

---

## Closed enums

These are the ONLY legal values. Anything outside the set is rejected by the
gate.

### `Fib` — the Fibonacci tier set

```
1 | 2 | 3 | 5 | 8 | 13
```

Closed and ordered. No `4`, `6`, `7`, `9`, … — those are rejected.

### `AlignmentClass` — how well the task serves a charter value theme

```
none | weak | direct | core
```

### `SeverityClass` — the risk/severity bucket the task addresses

```
none | tech_debt | security | data_loss | compliance
```

### `DecayClass` — how fast cost-of-delay grows with no hard deadline

```
flat | slow | fast
```

Use a `DecayClass` only when the task has **no** parseable deadline date. When a
deadline date is present, emit `decay: null` and the server scores Time
Criticality from the days-until-deadline band instead.

---

## Relative anchoring — classify by COLUMN, not by row

WSJF scoring is **relative**, not absolute. You are ranking tasks against each
other, so anchor each component **down its column across the batch**, never by
reading one task in isolation:

- **Score one component (one column) across all candidate tasks before moving to
  the next.** Do all the `value` classifications together, then all the
  `timeCriticality`, etc. This forces a consistent yardstick per column.
- **Every cost-of-delay column MUST contain at least one `1`-tier anchor.** The
  smallest item in each of Value, Time Criticality, and Risk/Opportunity is your
  floor; if nothing in the batch is a `1` in a column, you have inflated that
  column and the batch gate will reject it.
- **A batch where a column is flat (all items identical / no spread) is
  degenerate** and is rejected by the variance floor. Real backlogs have spread;
  if your classifications don't, re-examine them.
- For a single task created on its own (`create-task`), anchor relative to the
  project's existing scored tasks and the charter, not to an absolute scale.

The batch invariants ("every cost-of-delay column has a `1` anchor AND variance
≥ floor") are enforced deterministically by the validation gate. Column-anchored
scoring is how you satisfy them on the first pass instead of getting re-prompted.

---

## Enum → Fibonacci tier maps (what the server computes from your classes)

You emit the classes on the left; the server computes the tier on the right.
These tables are informational — so you understand the consequences of a class —
but you never emit the right-hand number yourself.

### User Business Value (UBV) — `ubvFromThemeAlignment(weight, alignment)`

`weight` is the matched charter theme's Fibonacci weight. Alignment steps the
weight down:

| alignment | resulting tier            |
|-----------|---------------------------|
| `core`    | `weight` (unchanged)      |
| `direct`  | one step down from weight |
| `weak`    | two steps down from weight|
| `none`    | `1`                       |

One-step-down ladder: `13→8`, `8→5`, `5→3`, `3→2`, `2→1`, `1→1`. Two-steps-down
applies it twice. Worked: `(13,'core')→13`, `(13,'direct')→8`, `(13,'weak')→5`,
`(13,'none')→1`, `(5,'core')→5`, `(3,'direct')→2`.

With **no charter** (`themeName: null`), UBV falls back to a signal
classification recorded in evidence rather than a theme weight.

### Time Criticality (TC) — two paths

**Path A — a real deadline date is present (`decay: null`).**
Server scores from whole days until the deadline via `tcFromDaysUntil(days)`. `13`
is reserved for due-now / overdue:

| days until deadline | tier |
|---------------------|------|
| `<= 0` (overdue / due today / expired) | `13` |
| `1..7`              | `8`  |
| `8..90`             | `5`  |
| `91..180`           | `3`  |
| `181..365`          | `2`  |
| `> 365`             | `1`  |

**Path B — no hard deadline (you emit a `decay` class).**
Server scores via `tcFromDecayClass(decay)`, capped at `5` so a deadline-less
task can never out-rank a truly time-boxed one:

| decay  | tier |
|--------|------|
| `flat` | `1`  |
| `slow` | `3`  |
| `fast` | `5`  |

### Risk Reduction / Opportunity Enablement (RR) — `max(fanout, severity)`

RR is the **max** of two server-computed tiers: DAG fan-out and your severity
class.

Fan-out (`rrFromFanout(n)`, `n` = transitive dependents, server-derived):

| transitive dependents | tier |
|-----------------------|------|
| `0`                   | `1`  |
| `1`                   | `3`  |
| `2..3`                | `5`  |
| `4..7`                | `8`  |
| `>= 8`                | `13` |

Severity (`rrFromSeverity(severity)`, from your class):

| severity     | tier |
|--------------|------|
| `none`       | `1`  |
| `tech_debt`  | `3`  |
| `security`   | `8`  |
| `data_loss`  | `8`  |
| `compliance` | `8`  |

Final RR = `max(rrFromFanout, rrFromSeverity)`.

### Job Size band — `jobSizeBand(filesTouched, text)` → `[low, high]`

The server computes a **band** `[low, high]`; your emitted `jobSizeTier` MUST sit
inside it (inclusive). When `filesTouched` is known it dominates; otherwise
keyword priors over the task text apply.

`filesTouched` known (server-derived count):

| files touched | band      |
|---------------|-----------|
| `1`           | `[1, 2]`  |
| `2..3`        | `[2, 5]`  |
| `4..8`        | `[5, 8]`  |
| `> 8`         | `[8, 13]` |

`filesTouched` unknown → keyword priors (case-insensitive substring over text):

| keyword class                                       | band      |
|-----------------------------------------------------|-----------|
| `typo` / `config` / `copy`                          | `[1, 3]`  |
| `refactor` / `migrate` / `rewrite` / `new subsystem`| `[8, 13]` |
| default (no keyword)                                | `[1, 13]` |

Pick the `jobSizeTier` inside the band that best matches the verbatim Job Size
evidence span. A tier outside the band is rejected by the gate.

---

## The final ratio (server-only, for context)

```
WSJF = (value + timeCriticality + riskOpportunity) / max(jobSize, 1)
```

A `jobSize` of `0` is treated as `1`. Worked:
`{value: 13, timeCriticality: 5, riskOpportunity: 8, jobSize: 5} → 5.2`.
You never compute this — it is shown only so you understand that small,
high-value, time-critical, broadly-unblocking work rises to the top.

---

## Contradiction rules the gate enforces

The validation gate rejects internally inconsistent classifications. The canonical
example: a task classified as the **smallest** job (`jobSize` tier `1`) while
also the **highest** value (`value` tier `13`) is contradictory and rejected —
trivial work is almost never your single most valuable item. Re-examine the
evidence spans when this fires; usually one of the two classes is wrong.

---

## Checklist before you submit

- [ ] Every component has a **verbatim** evidence span (a real substring of the
      task text or charter) — no paraphrase, no empty string.
- [ ] `themeName` matches a charter theme name exactly, or is `null` only when
      there is no charter.
- [ ] `decay` is `null` when a deadline date exists; otherwise a `DecayClass`.
- [ ] `jobSizeTier` sits **inside** the server's Job Size band.
- [ ] You emitted **classifications only** — no Fibonacci numbers for value, time
      criticality, or risk/opportunity.
- [ ] Batch only: each cost-of-delay column has a `1` anchor and real spread
      (variance ≥ floor); columns scored down their column, not row-by-row.
