## Summary

<!-- 1-3 sentences explaining what this PR does and why. -->

## Related issue

<!-- Link the issue this PR closes or relates to, e.g. `Closes #123` or `Refs #123`. -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Chore
- [ ] Breaking change

## Checklist

- [ ] Tests pass locally
- [ ] Coverage doesn't drop
- [ ] Docs updated if behavior changed
- [ ] Follows existing code style
- [ ] Atomic commits (one logical change per commit, clear subject lines)

## Risk assessment

<!-- What could break? Which subsystems are touched (CLI, MCP, REST, DB schema)? Any migrations or backfills required? Roll-back plan? -->

## Quality

- [ ] Affected layers (check all that apply): `api` / `cli` / `mcp` / `slack` / `services` / `events` / `repositories` / `db` / `schemas` / `types` / `utils` / `config` / docs / CI.
- [ ] Runtime boundaries touched (Zod schemas, MCP tool input, Slack signature handling, SSE event filtering, SQL/FTS query construction) — noted in the PR description.
- [ ] Test level matches the change (route → integration; service → service test; repository → repo + integration; util → unit; state-machine / dependency-cycle / pagination change → property test under `**/__tests__/*.property.test.ts`).
- [ ] Local quality gates ran: `npm run quality` (build, tests, lint, **format:check**, lint:deps, depcruise, prod audit).
- [ ] Strict-flag conventions honored for new/changed code: `exactOptionalPropertyTypes` (omit `undefined` keys via conditional-spread / `omitUndefined`, never widen DTOs to `| undefined`) and `noUncheckedIndexedAccess` (guard-and-bind indexed access — no blanket `arr[i]!`). See `docs/TYPESCRIPT_QUALITY_AUDIT_2026.md` §G / §784.
- [ ] Security-sensitive surfaces (auth, secrets, SQL/FTS query construction, Slack signature verification, MCP tool argument handling, SSE event leakage) — flagged in the PR description if touched.

<!-- See `docs/CODE_QUALITY_ROADMAP.md` for the full quality contract and the "Ongoing Review Checklist" section. -->

## Migration changes (only if this PR touches `src/db/migrations/`)

- [ ] Runs inside the serialized migration flow (registered with the existing Umzug pipeline; no ad-hoc connections).
- [ ] Safe for existing production data (no `DROP TABLE` / `ALTER TABLE ... DROP COLUMN` on populated columns without a backfill plan).
- [ ] Defaults / backfills correct for `NULL` and legacy rows.
- [ ] Foreign keys and indexes preserved (or explicitly recreated after a table rebuild).
- [ ] Down migration restores the prior schema/data contract — or the migration is explicitly forward-only and noted in the commit body and `docs/RELEASE.md`.
- [ ] Backup/restore note added to `docs/RELEASE.md` if the migration rewrites tables, drops data, or otherwise needs operator awareness.
- [ ] Targeted data-semantics test added under `src/db/__tests__/` for any non-schema-only change (backfills, computed columns, table rebuilds).

## Screenshots (if UI)

<!-- Drag-and-drop screenshots or recordings here. Delete this section if not applicable. -->
