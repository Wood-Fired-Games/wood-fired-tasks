---
phase: 20-testing-depth
plan: 01
subsystem: testing
tags: [knip, github-actions, ci, dependency-detection]

requires:
  - phase: 19-observability
    provides: stable codebase with 598 tests
provides:
  - knip unused dependency detection with lint:deps script
  - GitHub Actions CI pipeline with test and deps jobs
  - Clean dependency tree (removed @fastify/cors, fastify-plugin)
affects: [20-testing-depth, ci]

tech-stack:
  added: [knip]
  patterns: [CI pipeline with parallel jobs, dependency auditing]

key-files:
  created:
    - knip.json
    - .github/workflows/ci.yml
  modified:
    - package.json
    - .gitignore

key-decisions:
  - "Removed @fastify/cors and fastify-plugin as genuinely unused dependencies (not imported anywhere in src/)"
  - "pino-pretty excluded via ignoreDependencies — convention-loaded by pino at runtime, not statically importable"

patterns-established:
  - "lint:deps script: run knip --dependencies for local unused dep checks"
  - "CI parallel jobs: test and deps run independently for faster feedback"

requirements-completed: [TEST-03]

duration: 3min
completed: 2026-02-17
---

# Phase 20-01: Unused Dependency Detection Summary

**Knip unused dependency detection with CI enforcement via GitHub Actions parallel jobs**

## Performance

- **Duration:** 3 min
- **Completed:** 2026-02-17
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Installed knip and configured with project entry points and pino-pretty exclusion
- Detected and removed genuinely unused @fastify/cors and fastify-plugin dependencies
- Created GitHub Actions CI workflow with parallel test and deps jobs
- `npm run lint:deps` exits 0 on clean project

## Task Commits

Each task was committed atomically:

1. **Task 1: Install knip and configure** - `7c221f9` (feat) + `7fdc03d` (chore: deps)
2. **Task 2: Create GitHub Actions CI workflow** - `7c221f9` (feat: included in task 1 commit)

## Files Created/Modified
- `knip.json` - Knip configuration with entry points, project scope, and pino-pretty exclusion
- `.github/workflows/ci.yml` - CI pipeline with test and deps jobs
- `package.json` - Added lint:deps script, removed unused deps, added knip dev dependency
- `.gitignore` - Added Stryker output directories (reports/, .stryker-tmp/)

## Decisions Made
- Removed @fastify/cors and fastify-plugin — knip correctly identified these as unused; grep confirmed no imports in src/
- pino-pretty excluded with documented rationale (convention-loaded by pino, not statically importable)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed unused dependencies instead of just excluding**
- **Found during:** Task 1 (knip configuration)
- **Issue:** knip reported @fastify/cors and fastify-plugin as unused
- **Fix:** Verified with grep they are not imported anywhere; ran npm uninstall
- **Files modified:** package.json, package-lock.json
- **Verification:** `npm run lint:deps` exits 0, `npm test` passes
- **Committed in:** 7fdc03d

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Correct behavior per plan instructions — remove truly unused deps.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- knip configured and CI ready for phase 20-03 (Stryker will add more dev deps)
- lint:deps available for ongoing dependency hygiene

---
*Phase: 20-testing-depth*
*Completed: 2026-02-17*
