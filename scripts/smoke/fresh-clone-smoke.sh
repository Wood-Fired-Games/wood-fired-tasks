#!/usr/bin/env bash
#
# fresh-clone-smoke.sh — exercise the documented first-user flow end-to-end
# against a TEMP database, the way a brand-new clone would.
#
# It mirrors the README "Quick Start" exactly:
#   migrate (honors DATABASE_PATH) → build → start the API →
#   mint a PAT (`tasks db mint-token`) →
#   `npm run cli -- --json project-create` → `npm run cli -- create` →
#   `npm run cli -- list`.
#
# Auth model (v2.0, #799/#801/#802): the legacy X-API-Key / API_KEYS auth path
# was REMOVED server-side — requests bearing only X-API-Key now get 401. The
# identity-seeder no longer seeds users from API_KEYS; on every boot it
# unconditionally seeds two service-account users (`slack-bot`, `mcp-bot`). This
# smoke therefore authenticates the CLI the supported way: it mints a Personal
# Access Token against the always-seeded `mcp-bot` service account and passes it
# via `--token "$PAT"` (highest auth precedence: --token > credentials > env).
# It does NOT set or depend on API_KEYS for authentication.
#
# Safety: uses a throwaway `mktemp -d` DATABASE_PATH. It NEVER touches the real
# ./data directory or any production database, and it binds a non-default PORT
# so it does not clash with a server you may already be running on :3000.
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

# --- throwaway env: temp DB, non-default port --------------------------------
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wft-smoke.XXXXXX")"
SMOKE_PORT="${SMOKE_PORT:-31731}"          # non-default to avoid clashing with :3000
SERVER_PID=""
PAT=""                                      # minted after the server is healthy

export DATABASE_PATH="${SMOKE_DIR}/tasks.db"
export PORT="${SMOKE_PORT}"
export HOST="127.0.0.1"
export API_BASE_URL="http://localhost:${SMOKE_PORT}"
# Point the CLI's credentials file at the (empty) temp dir so a real cached PAT
# in ~/.config/wood-fired-tasks/credentials can't win/leak into the auth chain
# (--token > credentials file > env). We pass the minted PAT via --token, which
# wins precedence outright; the empty dir keeps the smoke fully isolated.
export WFT_CREDENTIALS_PATH="${SMOKE_DIR}/credentials"
# Leave NODE_ENV unset (development). We deliberately do NOT set API_KEYS: the
# server boots fine without it in dev, and v2.0 removed the legacy X-API-Key /
# API_KEYS auth path entirely (step 3c below proves X-API-Key now gets 401). The
# CLI authenticates with a minted PAT (step 3b), not a static key.

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

# --- 3b. mint a PAT against the always-seeded `mcp-bot` service account ------
# v2.0's identity-seeder seeds `mcp-bot` (is_service_account=1) into the temp DB
# on boot. `tasks db mint-token` opens DATABASE_PATH directly (no HTTP), resolves
# --user against display_name, and prints the token once on stdout: "Token: ...".
echo "-- mint PAT (db mint-token --user mcp-bot) --"
MINT_OUT="$(npm run --silent cli -- db mint-token --user mcp-bot --name "fresh-clone-smoke-pat")" \
  || { echo "${MINT_OUT}" >&2; fail "mint-token failed"; }
PAT="$(printf '%s\n' "${MINT_OUT}" | grep -E '^Token: ' | head -n 1 | sed 's/^Token: //' | tr -d '[:space:]')"
[[ -n "${PAT}" ]] || fail "could not parse 'Token:' line from mint-token output: ${MINT_OUT}"
echo "   minted PAT (len=${#PAT})"

# --- 3c. NEGATIVE: prove v2.0 rejects legacy X-API-Key auth with 401 --------
# An authenticated endpoint hit with ONLY a (legacy) X-API-Key header must now
# return 401 — the legacy key path was removed server-side. This guards against
# a regression that silently re-enables static-key auth.
echo "-- assert X-API-Key rejected with 401 --"
XKEY_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "X-API-Key: smoke-key" "${API_BASE_URL}/api/v1/tasks")"
[[ "${XKEY_STATUS}" == "401" ]] \
  || fail "expected 401 for X-API-Key-only request, got HTTP ${XKEY_STATUS}"
echo "   X-API-Key correctly rejected (HTTP 401)."

# --- 4. create a project via the DOCUMENTED CLI, capture its id -------------
echo "-- project-create --"
PROJ_JSON="$(npm run --silent cli -- --json --token "${PAT}" project-create --name "Smoke Project")" \
  || fail "project-create failed"
PROJECT_ID="$(printf '%s' "${PROJ_JSON}" | jq -r '.metadata.id')"
[[ "${PROJECT_ID}" =~ ^[0-9]+$ ]] || fail "could not parse project id from: ${PROJ_JSON}"
echo "   created project id=${PROJECT_ID}"

# --- 5. create a task in that project ---------------------------------------
echo "-- create task --"
TASK_JSON="$(npm run --silent cli -- --json --token "${PAT}" create \
  --title "Smoke task" --project "${PROJECT_ID}" --created-by "smoke")" \
  || fail "create task failed"
TASK_ID="$(printf '%s' "${TASK_JSON}" | jq -r '.metadata.id')"
[[ "${TASK_ID}" =~ ^[0-9]+$ ]] || fail "could not parse task id from: ${TASK_JSON}"
echo "   created task id=${TASK_ID}"

# --- 6. list tasks in the project, assert our task is present ---------------
echo "-- list --"
LIST_JSON="$(npm run --silent cli -- --json --token "${PAT}" list --project "${PROJECT_ID}")" \
  || fail "list failed"
FOUND="$(printf '%s' "${LIST_JSON}" | jq -r --argjson id "${TASK_ID}" \
  '[.data[] | select(.id == $id)] | length')"
[[ "${FOUND}" == "1" ]] || fail "task ${TASK_ID} not found in list output: ${LIST_JSON}"
echo "   listed project ${PROJECT_ID}: task ${TASK_ID} present."

echo "== All steps OK: project=${PROJECT_ID} task=${TASK_ID} =="
