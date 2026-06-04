#!/usr/bin/env bash
#
# fresh-clone-smoke.sh — exercise the documented first-user flow end-to-end
# against a TEMP database, the way a brand-new clone would.
#
# It mirrors the README "Quick Start" exactly:
#   migrate (honors DATABASE_PATH) → build → start the API →
#   `npm run cli -- --json project-create` → `npm run cli -- create` →
#   `npm run cli -- list`.
#
# Safety: uses a throwaway `mktemp -d` DATABASE_PATH and a non-secret local key
# (API_KEYS=smoke-key / API_KEY=smoke-key). It NEVER touches the real ./data
# directory or any production database, and it binds a non-default PORT so it
# does not clash with a server you may already be running on :3000.
#
# This is a MANUAL pre-publish smoke (not wired into CI) — a maintainer runs it
# from the repo root before cutting a release to prove the documented flow still
# works from a clean slate. See docs/SETUP.md → "Pre-publish smoke test".
#
# Usage:
#   ./scripts/smoke/fresh-clone-smoke.sh
# Exits 0 on full success; non-zero (and prints the failing step) otherwise.

set -euo pipefail

# --- locate repo root (script lives in scripts/smoke/) -----------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

# --- throwaway env: temp DB, non-secret key, non-default port ----------------
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wft-smoke.XXXXXX")"
SMOKE_PORT="${SMOKE_PORT:-31731}"          # non-default to avoid clashing with :3000
SERVER_PID=""

export DATABASE_PATH="${SMOKE_DIR}/tasks.db"
export API_KEYS="smoke-key"                # server: comma-separated admin keys
export API_KEY="smoke-key"                 # client/CLI: legacy key (same value)
export PORT="${SMOKE_PORT}"
export HOST="127.0.0.1"
export API_BASE_URL="http://localhost:${SMOKE_PORT}"
# Point the CLI's credentials file at the (empty) temp dir so a real cached PAT
# in ~/.config/wood-fired-tasks/credentials can't win the auth-precedence chain
# (--token > credentials file > env.API_KEY). With no file there, the CLI falls
# through to our env.API_KEY, exactly like a brand-new clone with no prior login.
export WFT_CREDENTIALS_PATH="${SMOKE_DIR}/credentials"
# Leave NODE_ENV unset (development): production mode rejects short API_KEYS
# (<32 chars), but the documented Quick Start uses a short local key. This smoke
# follows that same dev flow, so a non-secret "smoke-key" is accepted.

SERVER_LOG="${SMOKE_DIR}/server.log"

# --- teardown: kill the server, remove the temp dir -------------------------
cleanup() {
  local code=$?
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${SMOKE_DIR}"
  if [[ ${code} -eq 0 ]]; then
    echo "SMOKE PASS — temp DB removed, server stopped."
  else
    echo "SMOKE FAIL (exit ${code}) — temp DB removed, server stopped." >&2
  fi
}
trap cleanup EXIT

fail() { echo "ERROR: $*" >&2; exit 1; }

echo "== Fresh-clone smoke =="
echo "  DATABASE_PATH=${DATABASE_PATH}"
echo "  API_BASE_URL=${API_BASE_URL}"
echo "  (temp dir: ${SMOKE_DIR})"

# --- 1. migrate (honors DATABASE_PATH) --------------------------------------
echo "-- migrate --"
npm run --silent migrate || fail "migrate failed"

# --- 2. build (npm start runs node dist/...) --------------------------------
echo "-- build --"
npm run --silent build || fail "build failed"

# --- 3. start the API server in the background ------------------------------
# `npm start` is literally `node dist/api/start.js` (see package.json). We invoke
# the node entry point DIRECTLY rather than through the npm wrapper so the PID we
# track IS the server process — `kill`-ing an npm wrapper would orphan its node
# child and leave a server bound to the smoke port. This is the same binary the
# documented `npm start` runs.
echo "-- start server (port ${SMOKE_PORT}) --"
node dist/api/start.js >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

# wait for /health to come up (max ~30s)
HEALTH_URL="${API_BASE_URL}/health"
up=""
for _ in $(seq 1 60); do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    cat "${SERVER_LOG}" >&2 || true
    fail "server process exited during startup"
  fi
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    up="yes"; break
  fi
  sleep 0.5
done
[[ -n "${up}" ]] || { cat "${SERVER_LOG}" >&2 || true; fail "server did not become healthy"; }
echo "   server healthy."

# --- 4. create a project via the DOCUMENTED CLI, capture its id -------------
echo "-- project-create --"
PROJ_JSON="$(npm run --silent cli -- --json project-create --name "Smoke Project")" \
  || fail "project-create failed"
PROJECT_ID="$(printf '%s' "${PROJ_JSON}" | jq -r '.metadata.id')"
[[ "${PROJECT_ID}" =~ ^[0-9]+$ ]] || fail "could not parse project id from: ${PROJ_JSON}"
echo "   created project id=${PROJECT_ID}"

# --- 5. create a task in that project ---------------------------------------
echo "-- create task --"
TASK_JSON="$(npm run --silent cli -- --json create \
  --title "Smoke task" --project "${PROJECT_ID}" --created-by "smoke")" \
  || fail "create task failed"
TASK_ID="$(printf '%s' "${TASK_JSON}" | jq -r '.metadata.id')"
[[ "${TASK_ID}" =~ ^[0-9]+$ ]] || fail "could not parse task id from: ${TASK_JSON}"
echo "   created task id=${TASK_ID}"

# --- 6. list tasks in the project, assert our task is present ---------------
echo "-- list --"
LIST_JSON="$(npm run --silent cli -- --json list --project "${PROJECT_ID}")" \
  || fail "list failed"
FOUND="$(printf '%s' "${LIST_JSON}" | jq -r --argjson id "${TASK_ID}" \
  '[.data[] | select(.id == $id)] | length')"
[[ "${FOUND}" == "1" ]] || fail "task ${TASK_ID} not found in list output: ${LIST_JSON}"
echo "   listed project ${PROJECT_ID}: task ${TASK_ID} present."

echo "== All steps OK: project=${PROJECT_ID} task=${TASK_ID} =="
