---
slug: upgrade-vuln-prod-deps-audit-gate
created: 2026-05-20
task_id: 181
priority: urgent
tags: [security, dependencies, release-blocker]
---

# Upgrade vulnerable production dependencies and add audit gating

## Goal

Resolve 17 production `npm audit --omit=dev` advisories (8 high, 9 moderate). Direct
runtime vulnerable dep is `fastify@5.7.4` (advisories GHSA-573f-x89g-hqp9,
GHSA-444r-cwp2-x5xf, GHSA-247c-9743-5963). Add a CI gate that fails on
high/critical production advisories.

## Approach

1. Bump direct deps to patched versions:
   - `fastify` ^5.7.4 → ^5.8.5 (clears the 3 fastify advisories)
   - `@fastify/swagger-ui` ^5.2.5 → ^5.2.6 (pulls patched `@fastify/static@^9.1.2`)
   - `@modelcontextprotocol/sdk` ^1.26.0 → ^1.29.0 (pulls patched transitives)
   - Allow semver-compatible updates of other direct deps via `npm update`.
2. Regenerate `package-lock.json` with `rm -rf node_modules && npm install`.
3. Re-run `npm audit --omit=dev`. For any remaining high/critical advisories
   that direct upgrades cannot reach (transitives pinned by parent packages),
   add `overrides` in package.json to force patched versions.
4. Validate: `npm test` (909 tests baseline), `npm run build`, sanity-check
   API body-validation tests still pass after Fastify minor bump.
5. Wire CI audit gate into `.github/workflows/ci.yml` — add a `npm audit
   --omit=dev --audit-level=high` step in a new job (or as part of `deps`).
6. Document any moderate advisories that remain (commit message or
   SECURITY-NOTES.md).

## Acceptance

- `npm audit --omit=dev` reports 0 high and 0 critical.
- Moderates (if any) documented with applicability note.
- `npm test` passes (909 baseline).
- `npm run build` passes.
- CI workflow runs `npm audit --omit=dev --audit-level=high` on push/PR.
- Atomic commit.

## Notes

- Snapshot count from finder: 17 prod vulns (8 high). Verified locally same.
- Do not push, tag, or open a PR — coordinator handles after batch.
