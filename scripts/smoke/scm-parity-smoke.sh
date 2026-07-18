#!/usr/bin/env bash
#
# scm-parity-smoke.sh — GATE git-parity (SC2) for the pluggable-SCM migration.
#
# The loop skills were migrated off raw `git` shell-outs onto the `tasks scm`
# adapter (project "Pluggable Source Control"). SC2 requires that, in git mode,
# every evidence value the migrated loop now reads from `tasks scm <verb>` is
# **byte-identical** to the raw `git` command it replaced — otherwise the loop's
# commit/push/audit evidence would silently drift from git's own truth.
#
# This smoke proves that invariant end-to-end:
#
#   1. GIT-PARITY — in a throwaway `git init` fixture (with a bare "origin"
#      remote), run the exact verb sequence a loop drives —
#        baseline → stage → record → changed-files <base> → change-id → publish
#      — and assert each adapter evidence value equals the equivalent raw git
#      command run in the SAME fixture, byte-for-byte:
#        · scm baseline .data.id            == git rev-parse HEAD
#        · scm record  .data.changeId       == git rev-parse HEAD (post-commit)
#        · scm changed-files .data.files[]  == git diff --name-only <base>..HEAD
#        · scm change-id .data.ids          == the bare commit SHA(s)
#        · scm publish .data.changeId       == git rev-parse HEAD, and the bare
#                                              "origin" actually received it.
#      Any mismatch dumps both sides and exits non-zero.
#
#   2. SKILL-COPY DRIFT GUARD — the migrated loop skills have exactly ONE
#      committed source of truth: `skills/tasks/`. History shows a "dual-source
#      drift trap" where a second committed copy of these skills (the old
#      `client-package/commands/tasks/` mirror) silently drifted. This step
#      greps (`grep -rl`) the repo's client/package dirs for stray committed
#      copies of the loop skills; if a duplicate exists AND drifts from
#      `skills/`, it FAILS. If there is genuinely no mirror (the current state),
#      it asserts that absence explicitly so the guard is a real check, never a
#      silent no-op.
#
# Safety: everything happens inside a single `mktemp -d`; the fixture git repos
# are throwaway and no network is touched (the "remote" is a local bare repo).
#
# Usage:  ./scripts/smoke/scm-parity-smoke.sh
# Exits 0 ONLY when every git-mode value is byte-identical and no drifted
# skill-copy is found; non-zero (with a diff dump) otherwise.

set -euo pipefail

# --- locate repo root (script lives in scripts/smoke/) -----------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TASKS_BIN="${REPO_ROOT}/dist/cli/bin/tasks.js"

SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wft-scm-parity.XXXXXX")"

cleanup() {
  local code=$?
  rm -rf "${SMOKE_DIR}"
  if [[ ${code} -eq 0 ]]; then
    echo "SCM-PARITY SMOKE PASS — temp fixtures removed."
  else
    echo "SCM-PARITY SMOKE FAIL (exit ${code}) — temp fixtures removed." >&2
  fi
}
trap cleanup EXIT

fail() { echo "ERROR: $*" >&2; exit 1; }

# Assert two values are byte-identical; dump both on mismatch.
assert_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "${got}" != "${want}" ]]; then
    {
      echo "PARITY MISMATCH: ${label}"
      echo "  scm value : [${got}]"
      echo "  git value : [${want}]"
    } >&2
    fail "byte-parity assertion failed for ${label}"
  fi
  echo "   OK ${label}: ${got}"
}

# Run a `tasks scm` verb against the fixture and print its stdout envelope.
scm() { node "${TASKS_BIN}" scm "$@" --repo "${FIX}"; }

echo "== SCM git-parity smoke =="
echo "  (temp dir: ${SMOKE_DIR})"

# --- 0. preconditions --------------------------------------------------------
command -v jq >/dev/null 2>&1 || fail "jq is required (used to parse the §4.1 JSON envelope)"
[[ -f "${TASKS_BIN}" ]] || fail "built CLI missing at ${TASKS_BIN} — run 'npm run build' first"

# --- 1. build a throwaway git fixture with a bare 'origin' remote -----------
REMOTE="${SMOKE_DIR}/origin.git"
FIX="${SMOKE_DIR}/work"
git init -q --bare "${REMOTE}"
git init -q "${FIX}"
git -C "${FIX}" config user.email "smoke@wood-fired.test"
git -C "${FIX}" config user.name  "scm-parity-smoke"
git -C "${FIX}" config commit.gpgsign false
git -C "${FIX}" remote add origin "${REMOTE}"

# initial commit → establishes upstream and the parity <base>
printf 'alpha\n' > "${FIX}/a.txt"
git -C "${FIX}" add a.txt
git -C "${FIX}" commit -q -m "c1: seed"
BRANCH="$(git -C "${FIX}" rev-parse --abbrev-ref HEAD)"
git -C "${FIX}" push -q -u origin "${BRANCH}"
BASE="$(git -C "${FIX}" rev-parse HEAD)"
echo "-- fixture ready (branch=${BRANCH}, base=${BASE}) --"

# --- 2. baseline == git rev-parse HEAD --------------------------------------
echo "-- scm baseline --"
BASELINE_ID="$(scm baseline | jq -er '.data.id')"
assert_eq "baseline .data.id" "${BASELINE_ID}" "$(git -C "${FIX}" rev-parse HEAD)"

# --- 3. worker edits: modify a.txt, add b.txt -------------------------------
printf 'beta\n' >> "${FIX}/a.txt"
printf 'gamma\n' > "${FIX}/b.txt"

# --- 4. stage via adapter; assert the staged set matches git's index --------
echo "-- scm stage --"
STAGED="$(scm stage a.txt b.txt | jq -er '.data.staged | sort | join(",")')"
GIT_STAGED="$(git -C "${FIX}" diff --cached --name-only | sort | paste -sd, -)"
assert_eq "stage .data.staged" "${STAGED}" "${GIT_STAGED}"

# --- 5. record == the new HEAD sha ------------------------------------------
echo "-- scm record --"
RECORD_ID="$(scm record "c2: worker edit" | jq -er '.data.changeId')"
assert_eq "record .data.changeId" "${RECORD_ID}" "$(git -C "${FIX}" rev-parse HEAD)"

# --- 6. changed-files <base> paths == git diff --name-only <base>..HEAD ------
echo "-- scm changed-files --"
SCM_FILES="$(scm changed-files "${BASE}" | jq -er '.data.files | map(.path) | sort | join("\n")')"
GIT_FILES="$(git -C "${FIX}" diff --name-only "${BASE}..HEAD" | sort)"
assert_eq "changed-files paths" "${SCM_FILES}" "${GIT_FILES}"

# --- 7. change-id ids == the bare commit SHA(s) -----------------------------
echo "-- scm change-id --"
CHANGE_ID="$(scm change-id | jq -er '.data.ids | join(",")')"
assert_eq "change-id .data.ids" "${CHANGE_ID}" "$(git -C "${FIX}" rev-parse HEAD)"

# --- 8. publish == HEAD, and the bare remote actually received it -----------
echo "-- scm publish --"
PUBLISH_ID="$(scm publish | jq -er '.data.changeId')"
LOCAL_HEAD="$(git -C "${FIX}" rev-parse HEAD)"
assert_eq "publish .data.changeId" "${PUBLISH_ID}" "${LOCAL_HEAD}"
assert_eq "origin received publish" "$(git -C "${REMOTE}" rev-parse HEAD)" "${LOCAL_HEAD}"

echo "== git-parity: all adapter evidence byte-identical to raw git =="

# --- 9. skill-copy drift guard (dual-source drift trap) ---------------------
# The migrated loop skills have ONE committed source of truth: skills/tasks/.
# Grep the repo's client/package dirs for stray committed copies. `git ls-files`
# scopes the search to tracked source (never node_modules/, dist/, or the
# gitignored .claude/worktrees/ agent checkouts, which legitimately mirror
# skills/ and must not trip the guard).
echo "-- skill-copy drift guard --"

# Directories that have historically held (or could hold) an end-user skill
# mirror separate from skills/. client-package/ was the drift-trap culprit.
MIRROR_ROOTS=(client-package client packages apps)

# Distinctive frontmatter line that only a genuine COPY of the loop skill would
# carry (plain doc references to the loop do not reproduce it).
SKILL_SENTINEL='argument-hint: \[project-name\] \[--max-tasks N\]'

drift_found=0
mirror_copies_found=0

for root in "${MIRROR_ROOTS[@]}"; do
  [[ -d "${REPO_ROOT}/${root}" ]] || continue
  # Tracked .md files under this root, then grep -rl for the loop-skill sentinel.
  mapfile -t tracked_md < <(cd "${REPO_ROOT}" && git ls-files "${root}" 2>/dev/null | grep -E '\.md$' || true)
  [[ "${#tracked_md[@]}" -gt 0 ]] || continue
  while IFS= read -r rel; do
    [[ -n "${rel}" ]] || continue
    mirror_copies_found=1
    base="$(basename "${rel}")"
    canonical="${REPO_ROOT}/skills/tasks/${base}"
    if [[ ! -f "${canonical}" ]]; then
      echo "STRAY skill copy with no skills/tasks/ counterpart: ${rel}" >&2
      drift_found=1
      continue
    fi
    if ! diff -q "${canonical}" "${REPO_ROOT}/${rel}" >/dev/null 2>&1; then
      echo "DRIFTED skill copy: ${rel} differs from skills/tasks/${base}" >&2
      diff -u "${canonical}" "${REPO_ROOT}/${rel}" >&2 || true
      drift_found=1
    else
      echo "   note: mirror copy ${rel} present and in sync with skills/tasks/${base}"
    fi
  done < <(
    cd "${REPO_ROOT}" &&
      grep -rl -E "${SKILL_SENTINEL}" --include='*.md' "${tracked_md[@]}" 2>/dev/null || true
  )
done

if [[ "${drift_found}" -ne 0 ]]; then
  fail "stray/drifted client-package copy of the loop skills detected — reconcile with skills/tasks/"
fi

if [[ "${mirror_copies_found}" -eq 0 ]]; then
  echo "   OK no client-package loop-skill mirror exists — skills/tasks/ is the sole source of truth."
else
  echo "   OK client-package loop-skill mirror(s) present and all in sync with skills/tasks/."
fi

echo "== SCM parity smoke: git-parity byte-identical + no drifted skill copies =="
