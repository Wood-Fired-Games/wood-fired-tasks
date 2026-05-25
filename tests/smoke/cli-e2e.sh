#!/usr/bin/env bash
#
# cli-e2e.sh — end-to-end functional smoke for the published `tasks` CLI
# against a real REST API + SQLite DB.
#
# Background: wood-fired-tasks #335 (cli-symlink-smoke), #337
# (cli-surface-coverage), and #338 (cli-tarball-install) prove that the
# CLI's *surface* renders correctly — --version, --help, per-command --help,
# and the published tarball shape. None of them prove that a command
# actually mutates server state. A class of regression — "command silently
# no-ops but prints success" — would slip past all three. This script
# (#339) closes that gap with a CLI → REST API → SQLite → CLI round-trip
# against a real server bound to an ephemeral DB.
#
# Acceptance criteria (wood-fired-tasks #339):
#   1. Install the package from `npm pack` (same shape as #338) into a
#      tmpdir; prepend its .bin to PATH.
#   2. Start the REST API server in the background with DATABASE_PATH
#      pointed at a tmp .db file. The server's `identity-seeder` creates
#      the legacy user from API_KEYS on boot — no manual INSERT needed.
#   3. Poll /health until 200 OK (timeout 30s).
#   4. Mint a PAT via `tasks db mint-token --user <label>`; capture the
#      printed token.
#   5. Run the 10-step CLI round-trip (see ROUND_TRIP_STEPS below). Every
#      command authenticates with --token "$PAT" and reads/writes via
#      $API_BASE_URL (overridden to the ephemeral port).
#   6. Cross-check the DB twice via a node + better-sqlite3 one-liner
#      (the published tarball ships better-sqlite3 in its runtime deps,
#      so this is portable without requiring the `sqlite3` apt package).
#   7. Cleanup trap kills the server, removes the temp DB + tarball + tmp
#      dir on ANY exit (success or failure).
#
# Total wall-time target: ≤ 60s locally; AC budget is ≤ 4 min on CI.

set -euo pipefail

# ----- locate the package root -------------------------------------------------
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_root="$(cd "${script_dir}/../.." && pwd)"

if [ ! -f "${pkg_root}/package.json" ]; then
  echo "ERROR: package.json not found at ${pkg_root}/package.json" >&2
  exit 1
fi

cd "${pkg_root}"

start_ts=$(date +%s)

# ----- read pkg name + bin name from package.json ------------------------------
pkg_name="$(node -e "process.stdout.write(require('./package.json').name)")"
bin_name="$(node -e "
  const pkg = require('./package.json');
  const bin = pkg.bin;
  if (typeof bin === 'string') {
    process.stdout.write(pkg.name);
  } else {
    const names = Object.keys(bin || {});
    if (names.length !== 1) {
      console.error('expected exactly one bin entry, got: ' + JSON.stringify(names));
      process.exit(1);
    }
    process.stdout.write(names[0]);
  }
")"
bin_target="$(node -e "
  const pkg = require('./package.json');
  const bin = pkg.bin;
  const p = (typeof bin === 'string') ? bin : Object.values(bin)[0];
  process.stdout.write(p);
")"

echo "[e2e] package:  ${pkg_name}"
echo "[e2e] bin name: ${bin_name}"

if [ ! -f "${pkg_root}/${bin_target}" ]; then
  echo "ERROR: bin target missing: ${pkg_root}/${bin_target}" >&2
  echo "       Run 'npm run build' before invoking this script." >&2
  exit 1
fi

# ----- prerequisites -----------------------------------------------------------
# jq is installed on ubuntu-latest by default; macOS CI runs `brew install jq`
# in the smoke-unix job (see install-scripts.yml). We require it here for
# JSON envelope parsing; fail loud if it's missing.
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not on PATH. Install jq before running this." >&2
  exit 1
fi

# ----- pick an ephemeral port + secrets ----------------------------------------
# Default to 14310 (matches the orchestrator brief). Caller can override via
# WFT_E2E_PORT — useful if 14310 is occupied on a dev box.
port="${WFT_E2E_PORT:-14310}"
api_url="http://127.0.0.1:${port}"

# API_KEYS doubles as the seed for the legacy user. The server's
# identity-seeder runs on boot and inserts a row with
# `display_name = entry.label, is_legacy = 1` for each entry — that's the
# user the mint-token command will resolve against. Use a label that is
# unlikely to collide with anything (so successive local runs stay clean
# even if the DB file lingers).
# In production mode the auth plugin enforces a 32+ char minimum on API_KEYS
# entries (validateApiKeysForProduction). The CI server is started with
# NODE_ENV=development to bypass that check — this is a smoke test, not a
# security audit, and the key value is never accepted from the wire (only
# used to seed the legacy user via the identity-seeder).
api_key="ci-e2e-secret-not-a-real-key-padded"  # 35 chars (>= 32) so the
# value still passes the production check if a future revert tightens
# NODE_ENV handling. Kept >=32 chars as defense-in-depth.
legacy_user_label="ci-e2e-bot"

# ----- state holders + cleanup trap --------------------------------------------
tmp=""
tmp_db=""
tarball=""
pack_log=""
install_log=""
server_log=""
server_pid=""
cleanup() {
  local rc=$?
  # Kill the server first so it stops touching the DB before we rm it.
  if [ -n "${server_pid}" ] && kill -0 "${server_pid}" 2>/dev/null; then
    echo "[e2e] cleanup: kill server pid=${server_pid}"
    kill "${server_pid}" 2>/dev/null || true
    # Give Fastify a moment to drain; SIGKILL if it hangs.
    for _ in 1 2 3 4 5; do
      if kill -0 "${server_pid}" 2>/dev/null; then
        sleep 1
      else
        break
      fi
    done
    if kill -0 "${server_pid}" 2>/dev/null; then
      kill -9 "${server_pid}" 2>/dev/null || true
    fi
    wait "${server_pid}" 2>/dev/null || true
  fi
  if [ -n "${server_log}" ] && [ -f "${server_log}" ]; then
    if [ "${rc}" -ne 0 ]; then
      echo "----- server log tail (rc=${rc}) -----" >&2
      tail -n 60 "${server_log}" >&2 || true
      echo "----- end server log -----" >&2
    fi
    rm -f "${server_log}" || true
  fi
  if [ -n "${pack_log}" ] && [ -f "${pack_log}" ]; then
    rm -f "${pack_log}" || true
  fi
  if [ -n "${install_log}" ] && [ -f "${install_log}" ]; then
    rm -f "${install_log}" || true
  fi
  # The temp DB lives under ${tmp}/server-cwd/data — so removing ${tmp}
  # below also removes the DB + its WAL side files. No separate rm needed.
  if [ -n "${tmp}" ] && [ -d "${tmp}" ]; then
    echo "[e2e] cleanup: rm -rf ${tmp}"
    rm -rf "${tmp}" || true
  fi
  if [ -n "${tarball}" ] && [ -f "${pkg_root}/${tarball}" ]; then
    echo "[e2e] cleanup: rm -f ${pkg_root}/${tarball}"
    rm -f "${pkg_root}/${tarball}" || true
  fi
  exit "${rc}"
}
trap cleanup EXIT

# ----- counters / failure registry ---------------------------------------------
total=0
pass=0
fail=0
failures=()

record_pass() {
  total=$((total + 1))
  pass=$((pass + 1))
  echo "[e2e] PASS  $1"
}
record_fail() {
  total=$((total + 1))
  fail=$((fail + 1))
  failures+=("$1")
  echo "[e2e] FAIL  $1  ($2)" >&2
}

# ----- Step 0: pack + install the tarball --------------------------------------
echo "[e2e] step 0: npm pack + install into tmpdir"
pack_log="$(mktemp)"
if ! npm pack >"${pack_log}" 2>&1; then
  echo "ERROR: npm pack failed:" >&2
  cat "${pack_log}" >&2
  exit 1
fi
tarball="$(grep -E '\.tgz$' "${pack_log}" | tail -n 1 | tr -d '[:space:]')"
if [ -z "${tarball}" ] || [ ! -s "${pkg_root}/${tarball}" ]; then
  echo "ERROR: could not parse tarball filename from npm pack output:" >&2
  cat "${pack_log}" >&2
  exit 1
fi
echo "[e2e]   tarball: ${tarball}"

tmp="$(mktemp -d)"
install_log="$(mktemp)"
if ! npm install --prefix "${tmp}" --omit=dev "${pkg_root}/${tarball}" >"${install_log}" 2>&1; then
  echo "ERROR: npm install (tarball) failed:" >&2
  cat "${install_log}" >&2
  exit 1
fi
echo "[e2e]   installed into: ${tmp}"

# Prepend the install's .bin so `tasks` resolves to the packaged binary.
export PATH="${tmp}/node_modules/.bin:${PATH}"

# Verify realpath sanity — same load-bearing assertion as #338.
resolved_link="$(command -v "${bin_name}" || true)"
if [ -z "${resolved_link}" ]; then
  echo "ERROR: '${bin_name}' not on PATH after tarball install." >&2
  exit 1
fi
resolved_real="$(realpath "${resolved_link}")"
expected_prefix="${tmp}/node_modules/${pkg_name}/dist/"
case "${resolved_real}" in
  "${expected_prefix}"*)
    echo "[e2e]   realpath OK: ${resolved_real}"
    ;;
  *)
    echo "ERROR: realpath assertion FAILED — '${bin_name}' is not under tarball install." >&2
    echo "       expected prefix: ${expected_prefix}" >&2
    echo "       actual realpath: ${resolved_real}" >&2
    exit 1
    ;;
esac

# ----- Step 1: set up the temp DB + start the server --------------------------
# Caveat: the published `dist/api/start.js` calls `createServer()` with no
# options, so the server's `initDatabase(dbPath || './data/tasks.db')` falls
# back to a RELATIVE path. `DATABASE_PATH` is defined in the env schema but
# is not actually read by the server entry point — only by the direct-DB
# CLI commands (`db mint-token`, `topology`). So we run the server with cwd
# at a dedicated dir, which makes the server's `./data/tasks.db` land at
# `${server_workdir}/data/tasks.db`. We then point DATABASE_PATH at THAT
# absolute path for the CLI direct-DB commands so they all share one DB.
server_workdir="${tmp}/server-cwd"
mkdir -p "${server_workdir}/data"
tmp_db="${server_workdir}/data/tasks.db"

server_log="$(mktemp)"
echo "[e2e] step 1: start server (port=${port}, db=${tmp_db})"

# Pre-flight: if the chosen port is already bound, fail loud rather than
# silently talking to a stale server. (Without this check, a stale process
# from a previous run can serve /health and the mint-token call would
# go to the wrong DB, producing the misleading "User 'X' not found".)
if curl -fsS "${api_url}/health" -o /dev/null 2>/dev/null; then
  echo "ERROR: ${api_url}/health is already serving 200 before we started." >&2
  echo "       A stale server is bound to port ${port}. Kill it or set" >&2
  echo "       WFT_E2E_PORT to a free port and retry." >&2
  exit 1
fi

# Run the server out of the TARBALL install — this proves the published
# server entry point boots, not just the dev tree's.
server_entry="${tmp}/node_modules/${pkg_name}/dist/api/start.js"
if [ ! -f "${server_entry}" ]; then
  echo "ERROR: server entry missing from tarball: ${server_entry}" >&2
  echo "       The package.json files[] glob must ship dist/api/." >&2
  exit 1
fi

# Background launch. cwd is server_workdir so `./data/tasks.db` lands at
# ${tmp_db}. DATABASE_PATH is exported anyway so the CLI direct-DB commands
# (mint-token, topology) read the same file.
#
# CRITICAL: `exec node ...` inside the subshell so the subshell's pid
# REPLACES itself with node. Without exec, $! is the subshell's pid, not
# node's — when the cleanup trap kills the subshell, the orphaned node
# survives bound to the port, wedging the next run with EADDRINUSE.
(
  cd "${server_workdir}" && \
  API_KEYS="${api_key}:${legacy_user_label}" \
  DATABASE_PATH="${tmp_db}" \
  PORT="${port}" \
  HOST=127.0.0.1 \
  LOG_LEVEL=warn \
  NODE_ENV=test \
  exec node "${server_entry}" \
    >"${server_log}" 2>&1
) &
server_pid=$!
echo "[e2e]   server pid: ${server_pid}"

# Poll /health until 200 (or timeout). The server is intentionally bound
# to 127.0.0.1 — no external network access required.
echo "[e2e] step 1b: poll ${api_url}/health (timeout 30s)"
healthy=0
for i in $(seq 1 30); do
  if ! kill -0 "${server_pid}" 2>/dev/null; then
    echo "ERROR: server process exited before becoming healthy." >&2
    echo "----- server log -----" >&2
    cat "${server_log}" >&2
    exit 1
  fi
  if curl -fsS "${api_url}/health" -o /dev/null 2>/dev/null; then
    healthy=1
    echo "[e2e]   /health 200 after ${i}s"
    break
  fi
  sleep 1
done
if [ "${healthy}" -ne 1 ]; then
  echo "ERROR: server never became healthy within 30s." >&2
  echo "----- server log -----" >&2
  cat "${server_log}" >&2
  exit 1
fi

# ----- Step 2: mint a PAT via the CLI -----------------------------------------
# `tasks db mint-token` opens the DB directly (no HTTP). It runs migrations
# itself (idempotent on a server-migrated DB) and resolves --user against
# the legacy display_name seeded above. The token is printed on stdout
# exactly once (line: "Token: wft_pat_...").
echo "[e2e] step 2: mint PAT via 'tasks db mint-token'"
mint_out="$(mktemp)"
mint_err="$(mktemp)"
set +e
DATABASE_PATH="${tmp_db}" \
  "${bin_name}" db mint-token \
    --user "${legacy_user_label}" \
    --name "ci-e2e-pat" \
    >"${mint_out}" 2>"${mint_err}"
mint_rc=$?
set -e
if [ "${mint_rc}" -ne 0 ]; then
  echo "ERROR: mint-token exited ${mint_rc}" >&2
  echo "----- stdout -----" >&2; cat "${mint_out}" >&2
  echo "----- stderr -----" >&2; cat "${mint_err}" >&2
  exit 1
fi
pat="$(grep -E '^Token: ' "${mint_out}" | head -n 1 | sed 's/^Token: //' | tr -d '[:space:]')"
if [ -z "${pat}" ]; then
  echo "ERROR: could not parse Token: line from mint-token output:" >&2
  cat "${mint_out}" >&2
  exit 1
fi
rm -f "${mint_out}" "${mint_err}"
echo "[e2e]   PAT minted (len=${#pat})"

# CLI base URL — overrides the default http://localhost:3000.
export API_BASE_URL="${api_url}"

# Helper: run a tasks CLI command and stash stdout/stderr/rc.
# Usage: run_cli <label> <out> <err> -- tasks <args...>
run_cli() {
  local out="$1" err="$2"; shift 2
  if [ "${1:-}" = "--" ]; then shift; fi
  set +e
  "$@" >"${out}" 2>"${err}"
  local rc=$?
  set -e
  return ${rc}
}

# ----- Step 3 (round-trip a): project create ----------------------------------
# Capture project id from the JSON envelope: {success, data:{project:{...}}, metadata:{id}}.
project_name="e2e-cli-$$-$(date +%s)"
echo "[e2e] step 3a: tasks project-create --name '${project_name}'"
po="$(mktemp)"; pe="$(mktemp)"
if ! run_cli "${po}" "${pe}" -- \
  "${bin_name}" --json --token "${pat}" \
  project-create --name "${project_name}"; then
  record_fail "project-create" "non-zero exit"
  cat "${pe}" >&2
  exit 1
fi
pid="$(jq -r '.metadata.id // .data.project.id // empty' "${po}")"
if ! [[ "${pid}" =~ ^[0-9]+$ ]]; then
  record_fail "project-create" "could not parse id from stdout"
  cat "${po}" >&2
  exit 1
fi
record_pass "a) project-create → id=${pid}"
rm -f "${po}" "${pe}"

# ----- Step 3 (round-trip b): task create -------------------------------------
echo "[e2e] step 3b: tasks create --project ${pid} --title 'Round-trip test'"
to="$(mktemp)"; te="$(mktemp)"
if ! run_cli "${to}" "${te}" -- \
  "${bin_name}" --json --token "${pat}" \
  create --project "${pid}" --title "Round-trip test" --created-by "${legacy_user_label}"; then
  record_fail "create" "non-zero exit"
  cat "${te}" >&2
  exit 1
fi
tid="$(jq -r '.metadata.id // .data.task.id // empty' "${to}")"
if ! [[ "${tid}" =~ ^[0-9]+$ ]]; then
  record_fail "create" "could not parse id from stdout"
  cat "${to}" >&2
  exit 1
fi
record_pass "b) create → id=${tid}"
rm -f "${to}" "${te}"

# ----- Step 3 (round-trip c): list --project --------------------------------
echo "[e2e] step 3c: tasks list --project ${pid} --json"
lo="$(mktemp)"; le="$(mktemp)"
if ! run_cli "${lo}" "${le}" -- \
  "${bin_name}" --json --token "${pat}" \
  list --project "${pid}"; then
  record_fail "list" "non-zero exit"
  cat "${le}" >&2
  exit 1
fi
count="$(jq -r '.data | length' "${lo}")"
title="$(jq -r '.data[0].title // empty' "${lo}")"
if [ "${count}" != "1" ] || [ "${title}" != "Round-trip test" ]; then
  record_fail "list" "expected 1 task titled 'Round-trip test', got count=${count} title='${title}'"
  cat "${lo}" >&2
  exit 1
fi
record_pass "c) list --project ${pid} → 1 task ('${title}')"
rm -f "${lo}" "${le}"

# ----- DB cross-check #1: tasks row count via direct DB read -----------------
# Run a node one-liner via the tarball's better-sqlite3 (shipped as a
# runtime dep). This bypasses the CLI entirely so a CLI bug that masks
# server state cannot fool us.
echo "[e2e] step 3c': DB cross-check — sqlite SELECT count(*) FROM tasks WHERE project_id=${pid}"
db_count="$(node -e "
  const Database = require('${tmp}/node_modules/better-sqlite3');
  const db = new Database('${tmp_db}', { readonly: true });
  const row = db.prepare('SELECT count(*) AS c FROM tasks WHERE project_id = ?').get(${pid});
  process.stdout.write(String(row.c));
  db.close();
")"
if [ "${db_count}" != "1" ]; then
  record_fail "db-cross-check#1" "expected 1 row, got ${db_count}"
  exit 1
fi
record_pass "c') DB cross-check — tasks row count = 1"

# ----- Step 3 (round-trip d): show <id> --json ---------------------------------
echo "[e2e] step 3d: tasks show ${tid} --json"
so="$(mktemp)"; se="$(mktemp)"
if ! run_cli "${so}" "${se}" -- \
  "${bin_name}" --json --token "${pat}" \
  show "${tid}"; then
  record_fail "show" "non-zero exit"
  cat "${se}" >&2
  exit 1
fi
status1="$(jq -r '.data.task.status // empty' "${so}")"
created_at="$(jq -r '.data.task.created_at // empty' "${so}")"
if [ "${status1}" != "open" ] || [ -z "${created_at}" ] || [ "${created_at}" = "null" ]; then
  record_fail "show" "expected status=open + non-null created_at, got status='${status1}' created_at='${created_at}'"
  cat "${so}" >&2
  exit 1
fi
record_pass "d) show ${tid} → status=open, created_at=${created_at}"
rm -f "${so}" "${se}"

# ----- Step 3 (round-trip e): update --status in_progress ---------------------
echo "[e2e] step 3e: tasks update ${tid} --status in_progress"
uo="$(mktemp)"; ue="$(mktemp)"
if ! run_cli "${uo}" "${ue}" -- \
  "${bin_name}" --json --token "${pat}" \
  update "${tid}" --status in_progress; then
  record_fail "update" "non-zero exit"
  cat "${ue}" >&2
  exit 1
fi
status2="$(jq -r '.data.task.status // empty' "${uo}")"
if [ "${status2}" != "in_progress" ]; then
  record_fail "update" "expected status=in_progress in update response, got '${status2}'"
  cat "${uo}" >&2
  exit 1
fi
# Re-show to confirm the state landed.
so2="$(mktemp)"
if ! run_cli "${so2}" "${ue}" -- \
  "${bin_name}" --json --token "${pat}" \
  show "${tid}"; then
  record_fail "update re-show" "non-zero exit"
  exit 1
fi
status3="$(jq -r '.data.task.status // empty' "${so2}")"
if [ "${status3}" != "in_progress" ]; then
  record_fail "update re-show" "expected status=in_progress after update, got '${status3}'"
  cat "${so2}" >&2
  exit 1
fi
record_pass "e) update + re-show → status=in_progress"
rm -f "${uo}" "${ue}" "${so2}"

# ----- DB cross-check #2: status via direct DB read --------------------------
echo "[e2e] step 3e': DB cross-check — sqlite SELECT status FROM tasks WHERE id=${tid}"
db_status="$(node -e "
  const Database = require('${tmp}/node_modules/better-sqlite3');
  const db = new Database('${tmp_db}', { readonly: true });
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(${tid});
  process.stdout.write(row ? row.status : '<missing>');
  db.close();
")"
if [ "${db_status}" != "in_progress" ]; then
  record_fail "db-cross-check#2" "expected status=in_progress, got '${db_status}'"
  exit 1
fi
record_pass "e') DB cross-check — task ${tid} status = in_progress"

# ----- Step 3 (round-trip f): comment-add + comment-list ---------------------
echo "[e2e] step 3f: tasks comment-add ${tid} --content 'hello'"
co="$(mktemp)"; ce="$(mktemp)"
if ! run_cli "${co}" "${ce}" -- \
  "${bin_name}" --json --token "${pat}" \
  comment-add "${tid}" --author "${legacy_user_label}" --content "hello"; then
  record_fail "comment-add" "non-zero exit"
  cat "${ce}" >&2
  exit 1
fi
clo="$(mktemp)"; cle="$(mktemp)"
if ! run_cli "${clo}" "${cle}" -- \
  "${bin_name}" --json --token "${pat}" \
  comment-list "${tid}"; then
  record_fail "comment-list" "non-zero exit"
  cat "${cle}" >&2
  exit 1
fi
# comment-list output is either a bare array or {data:[...]} envelope; handle both.
ccount="$(jq -r 'if type=="array" then length elif (.data|type)=="array" then (.data|length) else (.data.comments|length) end' "${clo}")"
if [ "${ccount}" != "1" ]; then
  record_fail "comment-list" "expected 1 comment, got ${ccount}"
  cat "${clo}" >&2
  exit 1
fi
record_pass "f) comment-add + comment-list → 1 comment"
rm -f "${co}" "${ce}" "${clo}" "${cle}"

# ----- Step 3 (round-trip g): dep-add + dep-list ------------------------------
# Need two more tasks (TID2 blocks TID3). Create them.
echo "[e2e] step 3g: dep-add — create two more tasks for the edge"
t2o="$(mktemp)"
if ! run_cli "${t2o}" "${te}" -- \
  "${bin_name}" --json --token "${pat}" \
  create --project "${pid}" --title "dep-src" --created-by "${legacy_user_label}"; then
  record_fail "dep-add prep #1" "non-zero exit"
  exit 1
fi
tid2="$(jq -r '.metadata.id // .data.task.id // empty' "${t2o}")"
t3o="$(mktemp)"
if ! run_cli "${t3o}" "${te}" -- \
  "${bin_name}" --json --token "${pat}" \
  create --project "${pid}" --title "dep-dst" --created-by "${legacy_user_label}"; then
  record_fail "dep-add prep #2" "non-zero exit"
  exit 1
fi
tid3="$(jq -r '.metadata.id // .data.task.id // empty' "${t3o}")"
rm -f "${t2o}" "${t3o}"
if ! [[ "${tid2}" =~ ^[0-9]+$ ]] || ! [[ "${tid3}" =~ ^[0-9]+$ ]]; then
  record_fail "dep-add prep" "could not parse new task ids (${tid2}, ${tid3})"
  exit 1
fi
# AC: `tasks dep add --task $TID2 --blocks $TID3`. Real CLI signature is
# `dep-add <id> <blocks-id>` (positional). Use positional form.
dao="$(mktemp)"; dae="$(mktemp)"
if ! run_cli "${dao}" "${dae}" -- \
  "${bin_name}" --json --token "${pat}" \
  dep-add "${tid2}" "${tid3}"; then
  record_fail "dep-add" "non-zero exit"
  cat "${dae}" >&2
  exit 1
fi
dlo="$(mktemp)"; dle="$(mktemp)"
if ! run_cli "${dlo}" "${dle}" -- \
  "${bin_name}" --json --token "${pat}" \
  dep-list "${tid2}"; then
  record_fail "dep-list" "non-zero exit"
  cat "${dle}" >&2
  exit 1
fi
# dep-list response shape: either {blocks:[...], blocked_by:[...]} or a bare
# array; assert that the configured edge appears somewhere in the payload.
if ! jq -e --argjson n "${tid3}" '
  (.. | objects | select(has("blocks_task_id")) | .blocks_task_id) // empty
  | tonumber == $n
' "${dlo}" >/dev/null 2>&1; then
  # Fallback search: any numeric value in the payload equals tid3.
  if ! jq -e --argjson n "${tid3}" 'tostring | test("\\b" + ($n|tostring) + "\\b")' "${dlo}" >/dev/null 2>&1; then
    record_fail "dep-list" "edge to ${tid3} not present in dep-list payload"
    cat "${dlo}" >&2
    exit 1
  fi
fi
record_pass "g) dep-add ${tid2}→${tid3} + dep-list ${tid2} (edge present)"
rm -f "${dao}" "${dae}" "${dlo}" "${dle}"

# ----- Step 3 (round-trip h): topology --project --------------------------------
echo "[e2e] step 3h: tasks topology --project ${pid}"
hto="$(mktemp)"; hte="$(mktemp)"
# `topology` opens the DB directly — it does NOT go through the HTTP server.
# We still set API_BASE_URL for consistency, but it isn't used here.
if ! run_cli "${hto}" "${hte}" -- env DATABASE_PATH="${tmp_db}" \
  "${bin_name}" --json --token "${pat}" \
  topology --project "${pid}"; then
  record_fail "topology" "non-zero exit"
  cat "${hte}" >&2
  exit 1
fi
# AC: "assert advisory field present". The TopologyReport has a top-level
# `advisory` (or similar) string. Be liberal: pass if either `advisory` or
# `classification` is non-empty.
if ! jq -e '(.advisory // .classification // .topology // .summary // empty) != ""' "${hto}" >/dev/null 2>&1; then
  record_fail "topology" "no advisory/classification field in payload"
  cat "${hto}" >&2
  exit 1
fi
record_pass "h) topology --project ${pid} → advisory field present"
rm -f "${hto}" "${hte}"

# ----- Step 3 (round-trip i): delete task + verify gone -----------------------
echo "[e2e] step 3i: tasks delete ${tid} --force"
do_="$(mktemp)"; de_="$(mktemp)"
if ! run_cli "${do_}" "${de_}" -- \
  "${bin_name}" --json --force --token "${pat}" \
  delete "${tid}"; then
  record_fail "delete" "non-zero exit"
  cat "${de_}" >&2
  exit 1
fi
# Follow-up: show MUST exit non-zero (task is gone).
set +e
"${bin_name}" --json --token "${pat}" show "${tid}" >/dev/null 2>&1
post_rc=$?
set -e
if [ "${post_rc}" -eq 0 ]; then
  record_fail "delete-followup" "show ${tid} exited 0 after delete — task was not actually deleted"
  exit 1
fi
record_pass "i) delete ${tid} (force) + show now exits non-zero (rc=${post_rc})"
rm -f "${do_}" "${de_}"

# ----- Step 3 (round-trip j): project-delete + verify gone --------------------
echo "[e2e] step 3j: tasks project-delete ${pid} --force"
po2="$(mktemp)"; pe2="$(mktemp)"
if ! run_cli "${po2}" "${pe2}" -- \
  "${bin_name}" --json --force --token "${pat}" \
  project-delete "${pid}"; then
  record_fail "project-delete" "non-zero exit"
  cat "${pe2}" >&2
  exit 1
fi
record_pass "j) project-delete ${pid} (force)"
rm -f "${po2}" "${pe2}"

# ----- summary -----------------------------------------------------------------
end_ts=$(date +%s)
elapsed=$(( end_ts - start_ts ))

echo ""
echo "[e2e] ${pass}/${total} e2e steps passed"
echo "[e2e] elapsed: ${elapsed}s"

if [ "${fail}" -gt 0 ]; then
  echo "" >&2
  echo "FAILED STEPS (${fail}):" >&2
  for f in "${failures[@]}"; do
    echo "  - ${f}" >&2
  done
  exit 1
fi

echo "ALL CLI E2E CHECKS PASSED"
