#!/usr/bin/env bash
#
# cli-surface-coverage.sh — per-command surface coverage matrix.
#
# Background: wood-fired-bugs #334 fixed a silent-CLI bug; #335 added the
# top-level smoke (cli-symlink-smoke.sh) covering `tasks --version|--help|<no args>`.
# THIS script (#337) extends coverage to EVERY registered subcommand: it parses
# the help banner to discover commands dynamically (so the matrix can't drift
# from the source) and asserts that each `tasks <cmd> --help` (and one level
# of nesting where applicable) renders without going silent.
#
# Acceptance criteria (wood-fired-bugs #337):
#   1. Discover the registered command list by parsing `tasks --help` (no
#      hardcoded list).
#   2. For each top-level command: assert `tasks <cmd> --help` exits 0,
#      produces non-empty stdout, and contains literal "Usage: tasks <cmd>".
#   3. For nested commands (detected dynamically — if `tasks <cmd> --help`
#      has its own "Commands:" block, recurse one level), apply the same
#      assertions to `tasks <cmd> <sub> --help`.
#   4. Continue past failures so we see ALL broken commands in one run;
#      finish with "N/N commands passed" and exit non-zero on any failure.
#
# Skip rules:
#   - `help` is auto-registered by Commander to print other commands' help;
#     skipping it removes noise without losing real coverage. The skip is
#     deliberate and documented in-script (this comment + a continue below).
#
# Total wall time target: <= 30s locally, well under the 90s/Node-version
# budget called out in the AC.

set -euo pipefail

# ----- locate the package root -------------------------------------------------
# Resolve the script's real directory so it works from any CWD (and via
# symlinks). Then walk up to the package root.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_root="$(cd "${script_dir}/../.." && pwd)"

if [ ! -f "${pkg_root}/package.json" ]; then
  echo "ERROR: package.json not found at ${pkg_root}/package.json" >&2
  exit 1
fi

cd "${pkg_root}"

start_ts=$(date +%s)

# ----- read bin name + bin target from package.json ----------------------------
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

echo "[surface] package:           ${pkg_name}"
echo "[surface] bin name:          ${bin_name}"

if [ ! -f "${pkg_root}/${bin_target}" ]; then
  echo "ERROR: bin target missing: ${pkg_root}/${bin_target}" >&2
  echo "       Run 'npm run build' before invoking this script." >&2
  exit 1
fi

# ----- cleanup trap -----------------------------------------------------------
# Runs on ANY exit (success, assertion failure, signal). Best-effort unlink so
# we don't leave a global symlink dangling on the dev box / CI runner.
cleanup() {
  local rc=$?
  echo "[surface] cleanup: npm unlink -g ${pkg_name}"
  npm unlink -g "${pkg_name}" >/dev/null 2>&1 || true
  exit "${rc}"
}
trap cleanup EXIT

# ----- pre-link: drop any stale global link ------------------------------------
npm unlink -g "${pkg_name}" >/dev/null 2>&1 || true

# ----- npm link ----------------------------------------------------------------
echo "[surface] running: npm link"
if ! npm link >/tmp/cli-surface-coverage-link.log 2>&1; then
  echo "ERROR: npm link failed:" >&2
  cat /tmp/cli-surface-coverage-link.log >&2
  exit 1
fi

# ----- PATH check --------------------------------------------------------------
resolved="$(command -v "${bin_name}" || true)"
if [ -z "${resolved}" ]; then
  echo "ERROR: 'which ${bin_name}' returned nothing after npm link." >&2
  echo "       npm prefix -g: $(npm prefix -g)" >&2
  echo "       PATH: ${PATH}" >&2
  exit 1
fi
echo "[surface] resolved bin:      ${resolved}"

# ----- helpers ----------------------------------------------------------------

# parse_commands_from_help <help-text>
# Emits one command name per line by extracting the lines under the "Commands:"
# block. Commander indents each entry by two spaces, then prints the command
# name (possibly followed by `[options]`, `<args>`, or descriptions). We take
# the FIRST whitespace-separated token. Stops when it hits a blank line that
# separates the Commands section from anything below (in practice the section
# is the last block in `--help`, but we handle the general case).
parse_commands_from_help() {
  local help_text="$1"
  printf '%s\n' "${help_text}" | awk '
    /^Commands:/ { in_cmds = 1; next }
    in_cmds {
      # blank line ends the section
      if ($0 ~ /^[[:space:]]*$/) { in_cmds = 0; next }
      # must be indented (Commander uses two leading spaces). Continuation
      # lines for long descriptions are indented much deeper — filter them
      # by requiring the first non-space character to start at column 3
      # (i.e. exactly two leading spaces, not more).
      if ($0 ~ /^  [^ ]/) {
        # print the first token after the leading spaces
        sub(/^[[:space:]]+/, "", $0);
        split($0, parts, /[[:space:]]+/);
        print parts[1];
      }
    }
  '
}

# Run a command, capture stdout+stderr separately, return exit code via $?.
# Usage: run_cmd <out-file> <err-file> -- <cmd...>
run_cmd() {
  local out_file="$1"
  local err_file="$2"
  shift 2
  # shift past `--` marker if present
  if [ "${1:-}" = "--" ]; then shift; fi
  set +e
  "$@" >"${out_file}" 2>"${err_file}"
  local rc=$?
  set -e
  return ${rc}
}

# assert_help_for "<label>" "<expected-usage-prefix>" -- <cmd...>
#   Runs <cmd...>, asserts: exit 0, stdout non-empty, stdout contains
#   "<expected-usage-prefix>" anchored to start of a line. Increments
#   pass/fail counters. Prints a diagnostic block on failure (but does
#   not abort — caller continues so we surface ALL failures in one run).
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
    # Anchor at start-of-line; allow either end-of-line or a space follow
    # so we don't false-match a flag's description that happens to mention
    # the command name. Commander always emits "Usage: tasks <cmd> ..." on
    # its own line as the first line of --help output.
    failed=1
    reason="stdout missing line starting with '${expected_usage}'"
  fi

  if [ "${failed}" -eq 1 ]; then
    fail_count=$((fail_count + 1))
    failures+=("${label}")
    echo "[surface] FAIL  ${label}  (${reason})" >&2
    {
      echo "----- ${label}: stdout -----"
      cat "${out_file}"
      echo "----- ${label}: stderr -----"
      cat "${err_file}"
      echo "----- end ${label} -----"
    } >&2
  else
    pass_count=$((pass_count + 1))
    echo "[surface] PASS  ${label}"
  fi

  # Echo the stdout for the caller via a side channel: assert_help_for stashes
  # the captured stdout in a file the caller can read via $LAST_HELP_OUT. The
  # caller uses this to look for a nested "Commands:" block without re-running.
  LAST_HELP_OUT="${out_file}"
  LAST_HELP_ERR="${err_file}"
  LAST_HELP_RC="${rc}"
}

# ----- discover top-level commands ---------------------------------------------
echo "[surface] discovering top-level commands from '${bin_name} --help'"
top_help="$("${bin_name}" --help 2>&1)"
mapfile -t top_cmds < <(parse_commands_from_help "${top_help}")

if [ "${#top_cmds[@]}" -eq 0 ]; then
  echo "ERROR: parsed 0 top-level commands from '${bin_name} --help'." >&2
  echo "----- begin --help output -----" >&2
  printf '%s\n' "${top_help}" >&2
  echo "----- end --help output -----" >&2
  exit 1
fi

echo "[surface] discovered ${#top_cmds[@]} top-level commands"

# ----- counters / failure registry ---------------------------------------------
total=0
pass_count=0
fail_count=0
failures=()

# ----- step B + C: per-command --help and nested-command recursion -------------
for cmd in "${top_cmds[@]}"; do
  # Skip Commander's auto-registered `help` command — running `tasks help --help`
  # works but adds noise without unique coverage (Commander writes that handler
  # internally; there is no application code path behind it to regress).
  if [ "${cmd}" = "help" ]; then
    echo "[surface] SKIP  ${cmd}  (Commander auto-registered)"
    continue
  fi

  assert_help_for "${cmd}" "Usage: ${bin_name} ${cmd}" -- "${bin_name}" "${cmd}" --help

  # If the help we just captured contains a "Commands:" section, recurse one
  # level. Re-using LAST_HELP_OUT avoids a second invocation. The same parser
  # works on a nested help banner (Commander emits the same indented format).
  # Note: skip recursion entirely if the parent failed — its output is unreliable.
  if [ "${LAST_HELP_RC}" -ne 0 ]; then
    continue
  fi

  if grep -q '^Commands:' "${LAST_HELP_OUT}"; then
    sub_help="$(cat "${LAST_HELP_OUT}")"
    mapfile -t sub_cmds < <(parse_commands_from_help "${sub_help}")
    for sub in "${sub_cmds[@]}"; do
      if [ "${sub}" = "help" ]; then
        echo "[surface] SKIP  ${cmd} ${sub}  (Commander auto-registered)"
        continue
      fi
      assert_help_for "${cmd} ${sub}" "Usage: ${bin_name} ${cmd} ${sub}" \
        -- "${bin_name}" "${cmd}" "${sub}" --help
    done
  fi
done

# ----- summary -----------------------------------------------------------------
end_ts=$(date +%s)
elapsed=$(( end_ts - start_ts ))

echo ""
echo "[surface] ${pass_count}/${total} commands passed"
echo "[surface] elapsed: ${elapsed}s"

if [ "${fail_count}" -gt 0 ]; then
  echo ""
  echo "FAILED COMMANDS (${fail_count}):" >&2
  for f in "${failures[@]}"; do
    echo "  - ${f}" >&2
  done
  exit 1
fi

echo "ALL SURFACE-COVERAGE CHECKS PASSED"
