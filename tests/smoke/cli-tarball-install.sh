#!/usr/bin/env bash
#
# cli-tarball-install.sh — validate the CLI against the actual `npm pack`
# tarball install (not against npm link's symlinked working tree).
#
# Background: wood-fired-tasks #335 (cli-symlink-smoke.sh) and #337
# (cli-surface-coverage.sh) both validate the CLI against `npm link`, which
# symlinks the entire working tree into the global node_modules. Any file
# missing from package.json's `files` array still resolves through that
# link, so a packaging gap (e.g. a freshly-added dist file not picked up
# by the include globs) would pass both gates and only break for real users
# who install from npm.
#
# This script (#338) closes that gap: it runs `npm pack` to produce the
# exact tarball that would be uploaded to the registry, installs it into
# a clean tmpdir via `npm install --omit=dev <tarball>`, prepends that
# tmpdir's .bin to PATH, and re-runs the same #335 + #337-style
# assertions against the *packaged* binary. The realpath check (step 3)
# is the load-bearing assertion that proves we're hitting the packaged
# dist/, not the dev tree's dist/.
#
# Acceptance criteria (wood-fired-tasks #338):
#   1. `npm pack` produces wood-fired-tasks-X.Y.Z.tgz at repo root.
#   2. `npm install --prefix <tmp> --omit=dev <tarball>` succeeds.
#   3. `realpath $(which tasks)` resolves under <tmp>/node_modules/<pkg>/dist/.
#   4. Smoke + per-command surface assertions pass against that binary.
#   5. Cleanup removes BOTH <tmp> AND the .tgz on EXIT (success or failure).
#
# Total wall time target: <= 2 min on CI's ubuntu-latest.

set -euo pipefail

# ----- locate the package root -------------------------------------------------
# Resolve the script's real directory so it works from any CWD (and via
# symlinks). Then walk up to the package root (where package.json lives).
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_root="$(cd "${script_dir}/../.." && pwd)"

if [ ! -f "${pkg_root}/package.json" ]; then
  echo "ERROR: package.json not found at ${pkg_root}/package.json" >&2
  exit 1
fi

cd "${pkg_root}"

start_ts=$(date +%s)

# ----- read pkg name + version + bin name from package.json --------------------
expected_version="$(node -e "process.stdout.write(require('./package.json').version)")"
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

echo "[tarball] package:           ${pkg_name}"
echo "[tarball] expected version:  ${expected_version}"
echo "[tarball] bin name:          ${bin_name}"

if [ ! -f "${pkg_root}/${bin_target}" ]; then
  echo "ERROR: bin target missing: ${pkg_root}/${bin_target}" >&2
  echo "       Run 'npm run build' before invoking this script." >&2
  exit 1
fi

# ----- cleanup trap ------------------------------------------------------------
# Runs on ANY exit (success, assertion failure, signal). Removes BOTH the
# temp install dir AND the produced tarball — leaving either behind would
# pollute the dev tree (the tarball would be picked up by future `npm pack`
# globs) and waste runner disk in CI.
tmp=""
tarball=""
pack_log=""
install_log=""
cleanup() {
  # Capture exit code FIRST — before any cleanup command can overwrite $?.
  # The trap is installed exactly once; auxiliary log files live in
  # script-scope vars so cleanup can sweep them without re-registering
  # the trap (which would clobber $? with the new trap-string evaluation).
  local rc=$?
  if [ -n "${pack_log}" ] && [ -f "${pack_log}" ]; then
    rm -f "${pack_log}" || true
  fi
  if [ -n "${install_log}" ] && [ -f "${install_log}" ]; then
    rm -f "${install_log}" || true
  fi
  if [ -n "${tmp}" ] && [ -d "${tmp}" ]; then
    echo "[tarball] cleanup: rm -rf ${tmp}"
    rm -rf "${tmp}" || true
  fi
  if [ -n "${tarball}" ] && [ -f "${pkg_root}/${tarball}" ]; then
    echo "[tarball] cleanup: rm -f ${pkg_root}/${tarball}"
    rm -f "${pkg_root}/${tarball}" || true
  fi
  exit "${rc}"
}
trap cleanup EXIT

# ----- Step 1: npm pack --------------------------------------------------------
# `npm pack` writes the tarball into the CWD and prints its filename on the
# LAST line of stdout. We capture stdout, take the last non-empty line, and
# verify the resulting file exists and is non-empty. Stderr is allowed to
# contain `npm notice` lines — we only consume stdout for the filename.
echo "[tarball] step 1: npm pack"
pack_log="$(mktemp)"
if ! npm pack >"${pack_log}" 2>&1; then
  echo "ERROR: npm pack failed:" >&2
  cat "${pack_log}" >&2
  exit 1
fi
# The tarball filename is the last non-empty line of `npm pack` stdout.
tarball="$(grep -E '\.tgz$' "${pack_log}" | tail -n 1 | tr -d '[:space:]')"
if [ -z "${tarball}" ]; then
  echo "ERROR: could not parse tarball filename from npm pack output:" >&2
  cat "${pack_log}" >&2
  exit 1
fi
if [ ! -s "${pkg_root}/${tarball}" ]; then
  echo "ERROR: tarball missing or empty: ${pkg_root}/${tarball}" >&2
  exit 1
fi
tarball_size="$(wc -c <"${pkg_root}/${tarball}" | tr -d '[:space:]')"
echo "[tarball]   produced: ${tarball} (${tarball_size} bytes)"

# ----- Step 2: clean install into a temp directory -----------------------------
# `npm install --prefix <tmp> --omit=dev <tarball>` materialises the package
# exactly as a real user `npm i -g wood-fired-tasks` would receive it. The
# --omit=dev flag mirrors what global installs do by default and avoids
# pulling devDependencies (and their many transitive packages).
tmp="$(mktemp -d)"
echo "[tarball] step 2: npm install --prefix ${tmp} --omit=dev ${tarball}"
install_log="$(mktemp)"
if ! npm install --prefix "${tmp}" --omit=dev "${pkg_root}/${tarball}" >"${install_log}" 2>&1; then
  echo "ERROR: npm install (tarball) failed:" >&2
  cat "${install_log}" >&2
  exit 1
fi
echo "[tarball]   installed into: ${tmp}"

# ----- Step 3: PATH + realpath assertion (the load-bearing check) --------------
# Prepend the temp install's .bin to PATH for the rest of the script. Then
# resolve `command -v <bin>` through realpath and assert the result lives
# under <tmp>/node_modules/<pkg>/dist/. If the assertion fires, we're hitting
# the dev tree (or a stale global link), not the packaged tarball.
export PATH="${tmp}/node_modules/.bin:${PATH}"
echo "[tarball] step 3: PATH prepended with ${tmp}/node_modules/.bin"

resolved_link="$(command -v "${bin_name}" || true)"
if [ -z "${resolved_link}" ]; then
  echo "ERROR: 'command -v ${bin_name}' returned nothing after tarball install." >&2
  echo "       PATH: ${PATH}" >&2
  ls -la "${tmp}/node_modules/.bin/" >&2 || true
  exit 1
fi
resolved_real="$(realpath "${resolved_link}")"
expected_prefix="${tmp}/node_modules/${pkg_name}/dist/"
echo "[tarball]   resolved (link): ${resolved_link}"
echo "[tarball]   resolved (real): ${resolved_real}"
echo "[tarball]   expected prefix: ${expected_prefix}"
case "${resolved_real}" in
  "${expected_prefix}"*)
    echo "[tarball]   PASS — realpath confirms packaged binary"
    ;;
  *)
    echo "ERROR: realpath assertion FAILED — the resolved binary is NOT under" >&2
    echo "       the tarball install's dist/. This means PATH resolution is" >&2
    echo "       picking up a stale npm link or a dev-tree binary." >&2
    echo "       expected prefix: ${expected_prefix}" >&2
    echo "       actual realpath: ${resolved_real}" >&2
    exit 1
    ;;
esac

# ----- counters / failure registry ---------------------------------------------
total=0
pass_count=0
fail_count=0
failures=()

# parse_commands_from_help <help-text>
# Emits one command name per line by extracting entries under the "Commands:"
# block. Mirrors the helper in tests/smoke/cli-surface-coverage.sh (#337) —
# kept inline so this smoke is self-contained.
parse_commands_from_help() {
  local help_text="$1"
  printf '%s\n' "${help_text}" | awk '
    /^Commands:/ { in_cmds = 1; next }
    in_cmds {
      if ($0 ~ /^[[:space:]]*$/) { in_cmds = 0; next }
      if ($0 ~ /^  [^ ]/) {
        sub(/^[[:space:]]+/, "", $0);
        split($0, parts, /[[:space:]]+/);
        print parts[1];
      }
    }
  '
}

# Run a command, capture stdout+stderr separately, return exit code via $?.
run_cmd() {
  local out_file="$1"
  local err_file="$2"
  shift 2
  if [ "${1:-}" = "--" ]; then shift; fi
  set +e
  "$@" >"${out_file}" 2>"${err_file}"
  local rc=$?
  set -e
  return ${rc}
}

# assert_help_for "<label>" "<expected-usage-prefix>" -- <cmd...>
#   Runs <cmd...>, asserts: exit 0, stdout non-empty, stdout contains a line
#   starting with "<expected-usage-prefix>". Increments counters; continues
#   past failures so we see ALL broken commands in one run.
assert_help_for() {
  local label="$1"
  local expected_usage="$2"
  shift 2
  if [ "${1:-}" = "--" ]; then shift; fi

  total=$((total + 1))

  local out_file err_file
  out_file="$(mktemp)"
  err_file="$(mktemp)"

  local rc=0
  run_cmd "${out_file}" "${err_file}" -- "$@" || rc=$?

  local size
  size="$(wc -c <"${out_file}" | tr -d '[:space:]')"

  local failed=0
  local reason=""

  if [ "${rc}" -ne 0 ]; then
    failed=1
    reason="exit code ${rc} (expected 0)"
  elif [ "${size}" -eq 0 ]; then
    failed=1
    reason="stdout empty (expected non-empty help text)"
  elif ! grep -qE "^${expected_usage}( |$)" "${out_file}"; then
    failed=1
    reason="stdout missing line starting with '${expected_usage}'"
  fi

  if [ "${failed}" -eq 1 ]; then
    fail_count=$((fail_count + 1))
    failures+=("${label}")
    echo "[tarball] FAIL  ${label}  (${reason})" >&2
    {
      echo "----- ${label}: stdout -----"
      cat "${out_file}"
      echo "----- ${label}: stderr -----"
      cat "${err_file}"
      echo "----- end ${label} -----"
    } >&2
  else
    pass_count=$((pass_count + 1))
    echo "[tarball] PASS  ${label}"
  fi

  rm -f "${out_file}" "${err_file}"
}

# ----- Step 4: assertions ------------------------------------------------------
# These mirror the assertions in #335 (cli-symlink-smoke.sh) and #337
# (cli-surface-coverage.sh) — but executed against the packaged install,
# not the npm-link symlink. Per the orchestrator's brief: skip nested
# recursion (already covered by #337); top-level surface + realpath are
# sufficient to catch the packaging-gap class of bugs this gate exists for.

# Assertion 1: <bin> --version equals package.json version.
echo "[tarball] step 4a: ${bin_name} --version == ${expected_version}"
total=$((total + 1))
version_out="$("${bin_name}" --version 2>/dev/null || true)"
version_out_trimmed="$(printf '%s' "${version_out}" | tr -d '[:space:]')"
if [ "${version_out_trimmed}" = "${expected_version}" ]; then
  pass_count=$((pass_count + 1))
  echo "[tarball]   PASS — version is '${version_out_trimmed}'"
else
  fail_count=$((fail_count + 1))
  failures+=("--version")
  echo "[tarball]   FAIL — expected '${expected_version}', got '${version_out_trimmed}'" >&2
fi

# Assertion 2: <bin> --help exits 0 with >= 10 lines.
echo "[tarball] step 4b: ${bin_name} --help exits 0 AND >= 10 lines"
total=$((total + 1))
set +e
help_out="$("${bin_name}" --help 2>&1)"
help_rc=$?
set -e
help_lines="$(printf '%s\n' "${help_out}" | wc -l)"
if [ "${help_rc}" -eq 0 ] && [ "${help_lines}" -ge 10 ]; then
  pass_count=$((pass_count + 1))
  echo "[tarball]   PASS — help produced ${help_lines} lines"
else
  fail_count=$((fail_count + 1))
  failures+=("--help")
  echo "[tarball]   FAIL — exit=${help_rc}, lines=${help_lines}" >&2
  printf '%s\n' "${help_out}" >&2
fi

# Assertion 3: <bin> (no args) exits non-zero with "Usage:" on stderr.
echo "[tarball] step 4c: ${bin_name} (no args) exits != 0 AND stderr ~ /Usage:/"
total=$((total + 1))
no_args_stderr_file="$(mktemp)"
no_args_stdout_file="$(mktemp)"
set +e
"${bin_name}" >"${no_args_stdout_file}" 2>"${no_args_stderr_file}"
no_args_rc=$?
set -e
no_args_stderr="$(cat "${no_args_stderr_file}")"
if [ "${no_args_rc}" -ne 0 ] && printf '%s' "${no_args_stderr}" | grep -q 'Usage:'; then
  pass_count=$((pass_count + 1))
  echo "[tarball]   PASS — exit=${no_args_rc}, stderr contains 'Usage:'"
else
  fail_count=$((fail_count + 1))
  failures+=("(no args)")
  echo "[tarball]   FAIL — exit=${no_args_rc}, stderr=" >&2
  printf '%s\n' "${no_args_stderr}" >&2
fi
rm -f "${no_args_stderr_file}" "${no_args_stdout_file}"

# Assertion 4: per-command surface — iterate top-level commands discovered
# from `<bin> --help` and assert each `<bin> <cmd> --help` exits 0 with
# "Usage: <bin> <cmd>" on its first line. Nested recursion is skipped per
# the brief (already covered by #337 against the link install).
echo "[tarball] step 4d: discovering top-level commands from '${bin_name} --help'"
top_help="$("${bin_name}" --help 2>&1)"
mapfile -t top_cmds < <(parse_commands_from_help "${top_help}")
if [ "${#top_cmds[@]}" -eq 0 ]; then
  echo "ERROR: parsed 0 top-level commands from '${bin_name} --help'." >&2
  printf '%s\n' "${top_help}" >&2
  exit 1
fi
echo "[tarball]   discovered ${#top_cmds[@]} top-level commands"

for cmd in "${top_cmds[@]}"; do
  # Skip Commander's auto-registered `help` — matches the #337 policy.
  if [ "${cmd}" = "help" ]; then
    echo "[tarball] SKIP  ${cmd}  (Commander auto-registered)"
    continue
  fi
  assert_help_for "${cmd}" "Usage: ${bin_name} ${cmd}" -- "${bin_name}" "${cmd}" --help
done

# ----- summary -----------------------------------------------------------------
end_ts=$(date +%s)
elapsed=$(( end_ts - start_ts ))

echo ""
echo "[tarball] ${pass_count}/${total} commands passed"
echo "[tarball] elapsed: ${elapsed}s"

if [ "${fail_count}" -gt 0 ]; then
  echo ""
  echo "FAILED COMMANDS (${fail_count}):" >&2
  for f in "${failures[@]}"; do
    echo "  - ${f}" >&2
  done
  exit 1
fi

echo "ALL TARBALL-INSTALL CHECKS PASSED"
