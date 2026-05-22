# Onboarding smoke test

Owner: Repository maintainers
Status: Authoritative. Paired with the scripted check at
[`scripts/agent-context/__tests__/onboarding-smoke.test.ts`](../scripts/agent-context/__tests__/onboarding-smoke.test.ts).

## Mission

Verify that a fresh AI agent — with no chat transcript, no task tracker
access, no vendor memory, and no production credentials — can navigate this
repo using only committed context files. Pair this manual procedure with the
scripted assertions to detect regressions in the onboarding surface defined
by [`AGENTS.md`](../AGENTS.md), [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md),
and [`docs/NAVIGATION.md`](NAVIGATION.md).

## Scripted vs human modes

- **Scripted** ([`scripts/agent-context/__tests__/onboarding-smoke.test.ts`](../scripts/agent-context/__tests__/onboarding-smoke.test.ts)):
  asserts every path referenced by a probe exists, every command resolves to
  an `npm` script or a `node_modules/.bin` binary, and each probe stays
  within the small-read budget. Runs in vanilla Node 22, no MCP client, no
  network, no `.env`, no `~/.claude.json`.
- **Human / AI reviewer:** scores the actual file-pick quality on each
  probe. The scripted check guarantees the suggested files exist; the
  reviewer judges whether an unseeded agent landed on them in the right
  order.

## Probe scenarios

Each probe begins from a clean clone with no chat history. "First reads"
means the file reads the agent issues after opening [`AGENTS.md`](../AGENTS.md).

### probe-api — REST endpoint

- **Prompt:** "Add a REST endpoint `GET /tasks/:id/history`."
- **Expected first reads:** `AGENTS.md` → `docs/INTERFACES.md` →
  `docs/API.md` → `src/api/routes/tasks/index.ts` → an existing test in
  `src/api/__tests__/`.
- **Pass:** agent edits `src/api/routes/tasks/index.ts` (or a sibling route
  file) after consulting the API surface index. Mentions
  `docs/INTERFACES.md` regeneration in the plan.

### probe-mcp — new MCP tool

- **Prompt:** "Add a new MCP tool `archive_task`."
- **Expected first reads:** `AGENTS.md` → `docs/MCP.md` →
  `src/mcp/tools/task-tools.ts` → an existing test in
  `src/mcp/__tests__/`.
- **Pass:** agent edits `src/mcp/tools/task-tools.ts` and a matching
  service under `src/services/`, citing `docs/MCP.md` for the tool naming
  convention.

### probe-cli — new CLI subcommand

- **Prompt:** "Add a `tasks export` CLI subcommand."
- **Expected first reads:** `AGENTS.md` → `docs/CLI.md` →
  `src/cli/bin/tasks.ts` → `src/cli/commands/` → `src/cli/__tests__/`.
- **Pass:** agent adds a new file under `src/cli/commands/`, wires it into
  `src/cli/bin/tasks.ts` via `program.addCommand`, and references the
  `npm run cli -- <subcommand>` invocation pattern.

### probe-db — schema migration

- **Prompt:** "Add a migration adding a `priority` column to `tasks`."
- **Expected first reads:** `AGENTS.md` → `docs/ARCHITECTURE.md` →
  `src/db/migrations/` → `src/db/migrate.ts` → `src/db/__tests__/`.
- **Pass:** agent creates a numbered file under `src/db/migrations/` with
  both `up` and `down`, runs `npm run migrate` in the plan, and updates
  `docs/ARCHITECTURE.md` if the data-flow boundary moves.

### probe-slack — slash command response

- **Prompt:** "Add a `/bugs status` Slack slash command response."
- **Expected first reads:** `AGENTS.md` → `docs/SLACK.md` →
  `src/slack/commands/tasks-command.ts` → `slack-app-manifest.yml`.
- **Pass:** agent edits `src/slack/commands/tasks-command.ts` (single
  dispatcher), updates `slack-app-manifest.yml` only if scopes change, and
  references the Slack triplet env vars from `docs/WORKFLOWS.md`.

### probe-docs — docs-only change

- **Prompt:** "Add a new section to the README explaining the SSE protocol."
- **Expected first reads:** `AGENTS.md` → `docs/AGENT_CONTEXT.md` →
  `README.md` → `docs/API.md` (SSE section).
- **Pass:** agent edits `README.md` only, confirms the file's line budget
  in `docs/AGENT_CONTEXT.md`, and plans to run
  `npm run agent-context:check` and `npm run lint`.

### probe-release — version bump and release

- **Prompt:** "Cut a v1.1.0 release."
- **Expected first reads:** `AGENTS.md` → `docs/RELEASE.md` →
  `CHANGELOG.md` → `package.json`.
- **Pass:** agent updates `package.json` `version` and `CHANGELOG.md` in
  the same change, plans to run `npm run pack:check` and
  `npm run prepublishOnly`.

## Scoring rubric

For each probe, score one of:

- **PASS** — agent read the expected files first, in roughly the listed
  order, then started editing the correct surface.
- **PASS WITH NOTES** — agent landed on the right files but in a different
  order, or made one defensible extra read (e.g. opening
  `docs/NAVIGATION.md` before the surface doc).
- **FAIL** — agent read unrelated files, asked for context that already
  ships in the repo, or edited the wrong surface.

**Project-level pass criterion:** ≥ 6 of 7 probes must be PASS or PASS
WITH NOTES.

## No-vendor-tools mode

The scripted test runs in a vanilla Node 22 environment with no vendor MCP
client, no `.env`, no `~/.claude.json`, and no network egress. The human
procedure can be executed in any chat-style interface — paste each prompt
verbatim into a fresh session and observe the first file reads.

If an agent fails repeatedly on probes its peers pass, the failure is
almost certainly in that vendor's adapter file or system prompt, not in
the authoritative content. See
[`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md) §6 (vendor-neutral vs
vendor-specific boundary) and replace any vendor file that carries unique
project facts with a thin pointer.

## When to run it

- Before opening a PR that touches any of:
  [`AGENTS.md`](../AGENTS.md), [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md),
  [`docs/REPO_MAP.md`](REPO_MAP.md),
  [`docs/ARCHITECTURE.md`](ARCHITECTURE.md),
  [`docs/WORKFLOWS.md`](WORKFLOWS.md),
  [`docs/INTERFACES.md`](INTERFACES.md),
  [`docs/NAVIGATION.md`](NAVIGATION.md), or `.agent-context.json`.
- As part of release prep — pair it with
  [`docs/RELEASE.md`](RELEASE.md).

## How to run the scripted check

```
npx vitest run scripts/agent-context/__tests__/onboarding-smoke.test.ts
```

A passing run prints one `it` line per probe-scenario assertion plus the
top-level "declares exactly seven probe scenarios" check. Failures point
at the specific probe and the offending path or command.

## Pointers

| Topic                                | File                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| Navigation hub                       | [`AGENTS.md`](../AGENTS.md)                               |
| Authoritative contract               | [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md)               |
| Task-oriented file map               | [`docs/NAVIGATION.md`](NAVIGATION.md)                     |
| Command sheet                        | [`docs/WORKFLOWS.md`](WORKFLOWS.md)                       |
| Surface inventory                    | [`docs/INTERFACES.md`](INTERFACES.md)                     |
| Release process                      | [`docs/RELEASE.md`](RELEASE.md)                           |
