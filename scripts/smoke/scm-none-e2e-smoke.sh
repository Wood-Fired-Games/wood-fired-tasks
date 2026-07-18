#!/usr/bin/env bash
#
# scm-none-e2e-smoke.sh — prove the none-mode (no-VCS) loop end-to-end and that
# its empty change-ids are ACCEPTED by the anti-fabrication / verifier evidence
# path (NOT fabrication-rejected). Closes SC3 (task #1545).
#
# WHAT THIS EXERCISES
# -------------------
# A loop running in a directory with NO source control (auto-detect -> none)
# drives the same `tasks scm <verb>` sequence any loop uses to capture evidence:
#
#   1. `tasks scm detect`               -> backend "none", source "auto"
#   2. `tasks scm baseline`             -> a `none:<digest>` manifest id (§5.5)
#   3. (edit a file / add a file)
#   4. `tasks scm changed-files <base>` -> the dirty paths
#   5. `tasks scm change-id`            -> **EMPTY** array (`{ids:[]}`), exit 0
#
# none-mode has no commit/changelist identifiers, so `change-id` legitimately
# returns an empty array. The spec (docs/superpowers/specs/2026-07-16-pluggable-
# scm-design.md §5.1 + loop-shared.md §B/§L) says this empty state is LEGITIMATE
# evidence, not a fabrication tell. This smoke proves that end-to-end by feeding
# the produced evidence — empty change-ids + the `none:<digest>` base + the
# changed-files paths — into the two evidence-acceptance guards and asserting
# each ACCEPTS it:
#
#   GUARD A — the §5.3 client-side anti-fabrication SHA hook
#     (docs/hooks/validate-sha.mjs). It scans an update_task payload's
#     `verification_evidence` for git-object ids and blocks fabricated SHAs.
#     Its BACKEND-AWARE DISPATCH note (§5.1/§5.3) says an explicitly empty
#     change-id array falls straight through to *allow*. We drive it from a
#     REAL git work tree (the repo root) so the git-probe path is genuinely
#     live, then assert: empty change-ids -> allow (exit 0, empty stdout).
#     A negative control (a fabricated 40-hex SHA in the same shape) MUST be
#     DENIED — proving the guard is active and the empty-array allow is real.
#
#   GUARD B — the persisted-evidence schema self-check the tasks-verifier runs
#     on its own output (`npm run -s validate:evidence` -> validateEvidence /
#     VerificationEvidenceSchema). We drive it with the none-mode NOT_VERIFIED
#     evidence shape the §B escape hatch emits and assert it validates OK.
#
# The assertion that MUST hold across both: empty change-ids in none-mode are
# ACCEPTED — no fabrication rejection.
#
# Safety: operates entirely inside a throwaway `mktemp -d` fixture that has NO
# `.git` (so auto-detect resolves to none). It never touches the real DB, never
# starts a server, and reads (never writes) the repo it runs from.
#
# Usage:
#   ./scripts/smoke/scm-none-e2e-smoke.sh
# Exits 0 on full success; non-zero (and prints the failing step) otherwise.

set -euo pipefail

# --- locate repo root (script lives in scripts/smoke/) -----------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TASKS_BIN="${REPO_ROOT}/dist/cli/bin/tasks.js"
SHA_HOOK="${REPO_ROOT}/docs/hooks/validate-sha.mjs"

# --- throwaway fixture (NO .git -> auto-detect => none) ----------------------
FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/scm-none-e2e.XXXXXX")"

cleanup() {
  local code=$?
  rm -rf "${FIXTURE}"
  if [[ ${code} -eq 0 ]]; then
    echo "SMOKE PASS — none-mode loop end-to-end; empty change-ids accepted."
  else
    echo "SMOKE FAIL (exit ${code}) — fixture removed." >&2
  fi
}
trap cleanup EXIT

fail() { echo "ERROR: $*" >&2; exit 1; }

# Run a scm verb against the fixture via the BUILT bin. `--repo "${FIXTURE}"`
# pins the repo root to the fixture so detection inspects ONLY the fixture dir.
scm() { node "${TASKS_BIN}" scm "$@" --repo "${FIXTURE}"; }

echo "== none-mode SCM end-to-end smoke =="
echo "  fixture: ${FIXTURE} (no .git -> auto-detect none)"

# --- 0. ensure the CLI is built ---------------------------------------------
if [[ ! -f "${TASKS_BIN}" ]]; then
  echo "-- build (dist bin missing) --"
  (cd "${REPO_ROOT}" && npm run --silent build) || fail "build failed"
fi
[[ -f "${TASKS_BIN}" ]] || fail "tasks bin not found at ${TASKS_BIN}"
[[ -f "${SHA_HOOK}"  ]] || fail "anti-fabrication SHA hook not found at ${SHA_HOOK}"
command -v jq >/dev/null 2>&1 || fail "jq is required but not installed"

# --- 1. seed the fixture with a couple of tracked files ---------------------
mkdir -p "${FIXTURE}/src"
printf 'export const answer = 41;\n' >"${FIXTURE}/src/app.ts"
printf '# none-mode fixture\n'       >"${FIXTURE}/README.md"

# --- 2. detect -> none (source auto) ----------------------------------------
echo "-- scm detect --"
DETECT_JSON="$(scm detect)" || fail "scm detect exited non-zero"
DET_BACKEND="$(printf '%s' "${DETECT_JSON}" | jq -r '.data.backend')"
DET_SOURCE="$(printf '%s'  "${DETECT_JSON}" | jq -r '.data.source')"
[[ "${DET_BACKEND}" == "none" ]] || fail "expected backend=none, got '${DET_BACKEND}' (${DETECT_JSON})"
[[ "${DET_SOURCE}"  == "auto" ]] || fail "expected source=auto, got '${DET_SOURCE}' (${DETECT_JSON})"
echo "   backend=none source=auto"

# --- 3. baseline -> none:<digest> -------------------------------------------
echo "-- scm baseline --"
BASELINE_JSON="$(scm baseline)" || fail "scm baseline exited non-zero"
BASE_ID="$(printf '%s' "${BASELINE_JSON}" | jq -r '.data.id')"
[[ "${BASE_ID}" =~ ^none:[0-9a-f]{64}$ ]] \
  || fail "expected a none:<64-hex-digest> baseline id, got '${BASE_ID}' (${BASELINE_JSON})"
echo "   baseline id=${BASE_ID}"

# --- 4. mutate the tree (edit one file, add another) ------------------------
printf 'export const answer = 42;\n' >"${FIXTURE}/src/app.ts"   # modify
printf 'export const extra = true;\n' >"${FIXTURE}/src/new.ts"  # add

# --- 5. changed-files <base> -> dirty paths ---------------------------------
echo "-- scm changed-files <base> --"
CHANGED_JSON="$(scm changed-files "${BASE_ID}")" || fail "scm changed-files exited non-zero"
CHANGED_COUNT="$(printf '%s' "${CHANGED_JSON}" | jq '.data.files | length')"
[[ "${CHANGED_COUNT}" -ge 1 ]] \
  || fail "expected >=1 changed file, got ${CHANGED_COUNT} (${CHANGED_JSON})"
# The edited file MUST appear in the dirty set.
HAS_APP="$(printf '%s' "${CHANGED_JSON}" \
  | jq -r '[.data.files[] | select(.path == "src/app.ts")] | length')"
[[ "${HAS_APP}" == "1" ]] \
  || fail "expected src/app.ts among changed files (${CHANGED_JSON})"
echo "   ${CHANGED_COUNT} changed path(s); src/app.ts present"

# --- 6. change-id -> EMPTY array, exit 0 ------------------------------------
echo "-- scm change-id --"
if ! CHANGEID_JSON="$(scm change-id)"; then
  fail "scm change-id exited non-zero — none-mode MUST exit 0 with an empty array"
fi
CID_OK="$(printf '%s'  "${CHANGEID_JSON}" | jq -r '.ok')"
CID_LEN="$(printf '%s' "${CHANGEID_JSON}" | jq '.data.ids | length')"
[[ "${CID_OK}"  == "true" ]] || fail "expected ok=true from change-id (${CHANGEID_JSON})"
[[ "${CID_LEN}" == "0"    ]] || fail "expected EMPTY change-id array, got length ${CID_LEN} (${CHANGEID_JSON})"
echo "   change-id ids=[] (empty), exit 0 — the none-mode legitimate state"

# Capture the empty ids + changed paths as JSON arrays to build evidence with.
CID_ARR="$(printf '%s'   "${CHANGEID_JSON}" | jq -c '.data.ids')"          # []
FILES_ARR="$(printf '%s' "${CHANGED_JSON}"  | jq -c '[.data.files[].path]')"

# ===========================================================================
# GUARD A — anti-fabrication SHA hook (§5.3): empty change-ids -> ACCEPTED.
# ===========================================================================
echo "-- GUARD A: anti-fabrication SHA hook accepts empty change-ids --"

# The §B VerifierInputs shape as it reaches the update_task PreToolUse hook:
# `commit_shas` (wire name; conceptually change-ids) is copied VERBATIM from the
# `tasks scm change-id` output above (an empty array), `base_sha` is the
# none:<digest> baseline, `file_changes` the dirty paths.
HOOK_PAYLOAD="$(jq -cn \
  --argjson ids "${CID_ARR}" \
  --argjson files "${FILES_ARR}" \
  --arg base "${BASE_ID}" \
  '{
     tool_name: "mcp__wood-fired-tasks__update_task",
     tool_input: {
       id: 1545,
       verification_evidence: {
         verdict: "NOT_VERIFIED",
         base_sha: $base,
         commit_shas: $ids,
         file_changes: $files
       }
     }
   }')"

# Drive the hook from the REAL repo root (a git work tree) so its git-object
# probe is genuinely live — an empty change-id array must STILL allow.
set +e
HOOK_OUT="$(printf '%s' "${HOOK_PAYLOAD}" | (cd "${REPO_ROOT}" && node "${SHA_HOOK}"))"
HOOK_RC=$?
set -e
[[ ${HOOK_RC} -eq 0 ]] || fail "SHA hook exited ${HOOK_RC} on empty-change-id evidence (expected 0)"
[[ -z "${HOOK_OUT}" ]] \
  || fail "SHA hook emitted a decision (expected empty=allow) on empty change-ids: ${HOOK_OUT}"
echo "   empty change-ids -> allow (exit 0, no decision) — NOT fabrication-rejected"

# Negative control: the SAME shape carrying a FABRICATED 40-hex SHA MUST be
# DENIED. This proves the guard is active (so the allow above is meaningful),
# not a no-op that rubber-stamps everything.
FAKE_SHA="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"   # 40 hex, absent from repo
NEG_PAYLOAD="$(jq -cn --arg sha "${FAKE_SHA}" \
  '{
     tool_name: "mcp__wood-fired-tasks__update_task",
     tool_input: {
       id: 1545,
       verification_evidence: { verdict: "PASS", commit_shas: [$sha] }
     }
   }')"
set +e
NEG_OUT="$(printf '%s' "${NEG_PAYLOAD}" | (cd "${REPO_ROOT}" && node "${SHA_HOOK}"))"
set -e
NEG_DECISION="$(printf '%s' "${NEG_OUT}" | jq -r '.hookSpecificOutput.permissionDecision' 2>/dev/null || true)"
[[ "${NEG_DECISION}" == "deny" ]] \
  || fail "negative control: fabricated SHA was NOT denied (guard inactive?): ${NEG_OUT}"
echo "   negative control: fabricated SHA -> deny (guard is live)"

# ===========================================================================
# GUARD B — persisted-evidence schema self-check accepts the none-mode
# NOT_VERIFIED shape the §B escape hatch emits.
# ===========================================================================
echo "-- GUARD B: verifier self-check (validate:evidence) accepts none-mode NOT_VERIFIED --"
# The persisted verification_evidence schema is `.strict()` and does NOT carry
# commit_shas/base_sha/file_changes (those live in the ephemeral VerifierInputs
# envelope, not the persisted object). This is exactly the shape the §B escape
# hatch writes when there are no change-ids to grade against.
PERSISTED_EVIDENCE='{"verdict":"NOT_VERIFIED","checks":[],"verifier_session_id":"verifier-1545-none-e2e","verified_at":"2026-07-17T00:00:00Z"}'
set +e
VE_OUT="$(printf '%s' "${PERSISTED_EVIDENCE}" | (cd "${REPO_ROOT}" && npm run -s validate:evidence) 2>&1)"
VE_RC=$?
set -e
[[ ${VE_RC} -eq 0 ]] \
  || fail "validate:evidence rejected the none-mode NOT_VERIFIED shape (rc=${VE_RC}): ${VE_OUT}"
echo "   validate:evidence OK — none-mode NOT_VERIFIED evidence is schema-valid"

echo "== All steps OK: detect=none baseline=${BASE_ID} change-ids=[] accepted by both guards =="
