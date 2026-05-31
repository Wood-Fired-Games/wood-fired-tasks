#!/usr/bin/env bash
#
# cli-symlink-smoke.sh — regression smoke test for the globally-linked `tasks` CLI.
#
# Background: wood-fired-tasks #334 fixed a silent-CLI bug where running the
# globally-linked `tasks` binary produced NO output because the entry guard
# (`import.meta.url === \`file://${process.argv[1]}\``) did not match when
# Node resolved `process.argv[1]` through an npm-link symlink. The fix uses
# the realpath-aware `src/utils/is-main.ts` helper. This smoke is the
# regression net: a future revert of that fix must FAIL this script on the
# `--version` assertion within seconds.
#
# Acceptance criteria (wood-fired-tasks #335):
#   1. `npm link` the local package (assumes `npm run build` has been run).
#   2. Assert `tasks --version` equals the version in package.json (no whitespace).
#   3. Assert `tasks --help` exits 0 and produces >= 10 lines of output.
#   4. Assert `tasks` (no args) exits non-zero with stderr containing "Usage:".
#   5. Clean up the link on exit (even on failure).
#
# Since v1.15 the package also ships a bundled `wft-router` bin, which shares
# the same #334-class entry-guard bug. Assertions 4-5 (numbered below) smoke
# that bin end-to-end through the same global symlink.
#
# Total wall time target: <= 30s on a normal dev box.

set -euo pipefail

# ----- locate the package root --------------------------------------------------
# Resolve the script's real directory so the test works from any CWD (and via
# symlinks). Then walk up to the package root (where package.json lives).
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_root="$(cd "${script_dir}/../.." && pwd)"

if [ ! -f "${pkg_root}/package.json" ]; then
  echo "ERROR: package.json not found at ${pkg_root}/package.json" >&2
  exit 1
fi

cd "${pkg_root}"

start_ts=$(date +%s)

# ----- read the expected version from package.json -----------------------------
# Use node so the assertion tracks future bumps automatically (the AC explicitly
# forbids hard-coding "1.0.0" — see task #335).
expected_version="$(node -e "process.stdout.write(require('./package.json').version)")"
pkg_name="$(node -e "process.stdout.write(require('./package.json').name)")"
bin_name="$(node -e "
  const pkg = require('./package.json');
  const bin = pkg.bin;
  if (typeof bin === 'string') {
    process.stdout.write(pkg.name);
  } else {
    // This smoke is the regression net for the \`tasks\` CLI specifically
    // (wood-fired-tasks #334/#335). The package now also exposes a \`wft-router\`
    // bin (smoked separately below), so select \`tasks\` explicitly rather than
    // assuming a single bin entry.
    const names = Object.keys(bin || {});
    if (!names.includes('tasks')) {
      console.error('expected a \"tasks\" bin entry, got: ' + JSON.stringify(names));
      process.exit(1);
    }
    process.stdout.write('tasks');
  }
")"

echo "[smoke] package:           ${pkg_name}"
echo "[smoke] expected version:  ${expected_version}"
echo "[smoke] bin name:          ${bin_name}"

# ----- ensure the dist artifact exists before linking --------------------------
# CI builds explicitly in a prior step. Locally, the script must not silently
# pass against a stale or missing dist/ — fail loud if the bin target is gone.
bin_target="$(node -e "
  const pkg = require('./package.json');
  const bin = pkg.bin;
  const path = (typeof bin === 'string') ? bin : (bin.tasks || Object.values(bin)[0]);
  process.stdout.write(path);
")"
if [ ! -f "${pkg_root}/${bin_target}" ]; then
  echo "ERROR: bin target missing: ${pkg_root}/${bin_target}" >&2
  echo "       Run 'npm run build' before invoking this smoke script." >&2
  exit 1
fi

# ----- cleanup trap ------------------------------------------------------------
# Runs on ANY exit (success, assertion failure, signal). Best-effort unlink so
# we don't leave a global symlink dangling on the dev box / CI runner.
cleanup() {
  local rc=$?
  echo "[smoke] cleanup: npm unlink -g ${pkg_name}"
  # Suppress noisy output; we don't care if the unlink fails (e.g. another
  # process already removed it). The trap's job is to make a best effort.
  npm unlink -g "${pkg_name}" >/dev/null 2>&1 || true
  exit "${rc}"
}
trap cleanup EXIT

# ----- pre-link: drop any stale global link from a previous run ----------------
# `npm link` will overwrite a pre-existing link silently, but if a prior run
# crashed mid-test the global link could point at a different checkout. Force
# a clean slate.
npm unlink -g "${pkg_name}" >/dev/null 2>&1 || true

# ----- npm link ---------------------------------------------------------------
echo "[smoke] running: npm link"
# Capture link output for diagnostics on failure but keep the foreground clean.
if ! npm link >/tmp/cli-symlink-smoke-link.log 2>&1; then
  echo "ERROR: npm link failed:" >&2
  cat /tmp/cli-symlink-smoke-link.log >&2
  exit 1
fi

# ----- PATH check --------------------------------------------------------------
# `npm link` places the bin into $(npm prefix -g)/bin which should already be
# on PATH for any normal shell that has npm working. Verify with `which`.
resolved="$(command -v "${bin_name}" || true)"
if [ -z "${resolved}" ]; then
  echo "ERROR: 'which ${bin_name}' returned nothing after npm link." >&2
  echo "       npm prefix -g: $(npm prefix -g)" >&2
  echo "       PATH: ${PATH}" >&2
  exit 1
fi
echo "[smoke] resolved bin:      ${resolved}"

# ----- Assertion 1: tasks --version --------------------------------------------
# This is the load-bearing assertion: it is the one that fails the moment
# someone reverts wood-fired-tasks #334's is-main fix. Capture stdout into a
# variable and trim any trailing whitespace before comparing.
echo "[smoke] assert 1: ${bin_name} --version  ==  ${expected_version}"
version_out="$("${bin_name}" --version 2>/dev/null || true)"
# Trim leading/trailing whitespace (including CR if some shell pipes injected one).
version_out_trimmed="$(printf '%s' "${version_out}" | tr -d '[:space:]')"
if [ "${version_out_trimmed}" != "${expected_version}" ]; then
  echo "ERROR: '${bin_name} --version' output mismatch." >&2
  echo "       expected: '${expected_version}'" >&2
  echo "       actual:   '${version_out}'   (trimmed='${version_out_trimmed}')" >&2
  echo "       This is the wood-fired-tasks #334 regression signal — the global" >&2
  echo "       symlink is invoking the CLI but the entry guard is not firing." >&2
  exit 1
fi
echo "[smoke]   PASS — version is '${version_out_trimmed}'"

# ----- Assertion 2: tasks --help  exit 0 AND >= 10 lines -----------------------
echo "[smoke] assert 2: ${bin_name} --help  exits 0 AND >= 10 lines"
set +e
help_out="$("${bin_name}" --help 2>&1)"
help_rc=$?
set -e
if [ "${help_rc}" -ne 0 ]; then
  echo "ERROR: '${bin_name} --help' exited ${help_rc} (expected 0)." >&2
  echo "----- begin help output -----" >&2
  printf '%s\n' "${help_out}" >&2
  echo "----- end help output -----" >&2
  exit 1
fi
help_lines="$(printf '%s\n' "${help_out}" | wc -l)"
if [ "${help_lines}" -lt 10 ]; then
  echo "ERROR: '${bin_name} --help' produced ${help_lines} lines (expected >= 10)." >&2
  echo "----- begin help output -----" >&2
  printf '%s\n' "${help_out}" >&2
  echo "----- end help output -----" >&2
  exit 1
fi
echo "[smoke]   PASS — help produced ${help_lines} lines"

# ----- Assertion 3: tasks (no args) exits non-zero, stderr contains "Usage:" ---
# Commander's default behaviour for a required-subcommand miss is to write the
# help banner to stderr and exit 1. Capture stdout/stderr separately so we can
# inspect them independently.
echo "[smoke] assert 3: ${bin_name} (no args)  exits != 0 AND stderr ~ /Usage:/"
no_args_stderr_file="$(mktemp)"
no_args_stdout_file="$(mktemp)"
# shellcheck disable=SC2064  # we intentionally expand the temp paths now.
trap "rm -f '${no_args_stderr_file}' '${no_args_stdout_file}'; cleanup" EXIT
set +e
"${bin_name}" >"${no_args_stdout_file}" 2>"${no_args_stderr_file}"
no_args_rc=$?
set -e
no_args_stderr="$(cat "${no_args_stderr_file}")"
if [ "${no_args_rc}" -eq 0 ]; then
  echo "ERROR: '${bin_name}' (no args) exited 0 — expected non-zero." >&2
  echo "       Silent-pass on missing-subcommand is exactly the bug this smoke prevents." >&2
  echo "----- stdout -----" >&2
  cat "${no_args_stdout_file}" >&2
  echo "----- stderr -----" >&2
  printf '%s\n' "${no_args_stderr}" >&2
  exit 1
fi
if ! printf '%s' "${no_args_stderr}" | grep -q 'Usage:'; then
  echo "ERROR: '${bin_name}' (no args) stderr did not contain 'Usage:'." >&2
  echo "       exit code: ${no_args_rc}" >&2
  echo "----- stderr -----" >&2
  printf '%s\n' "${no_args_stderr}" >&2
  exit 1
fi
echo "[smoke]   PASS — exit=${no_args_rc}, stderr contains 'Usage:'"

# ----- Assertion 4: bundled wft-router bin works through the symlink ------------
# wft-router ships inside this package (since v1.15) and is exposed as a second
# bin. It shares the exact #334-class entry-guard bug: its `isEntryPoint` guard
# compared import.meta.url (symlink-resolved) against argv[1] (the symlink),
# which made `main()` a silent no-op when invoked via the npm bin symlink. This
# block is the end-to-end regression net for that fix. Skipped automatically if
# the package does not declare a `wft-router` bin.
has_router="$(node -e "process.stdout.write(String(!!(require('./package.json').bin||{})['wft-router']))")"
if [ "${has_router}" = "true" ]; then
  router_resolved="$(command -v wft-router || true)"
  if [ -z "${router_resolved}" ]; then
    echo "ERROR: 'which wft-router' returned nothing after npm link." >&2
    exit 1
  fi
  echo "[smoke] assert 4: wft-router --version  exits 0 AND non-empty (no-op signal)"
  set +e
  router_ver="$(wft-router --version 2>/dev/null)"
  router_rc=$?
  set -e
  router_ver_trimmed="$(printf '%s' "${router_ver}" | tr -d '[:space:]')"
  if [ "${router_rc}" -ne 0 ] || [ -z "${router_ver_trimmed}" ]; then
    echo "ERROR: 'wft-router --version' failed (rc=${router_rc}, out='${router_ver}')." >&2
    echo "       Empty output via the symlink is the #334-class no-op regression." >&2
    exit 1
  fi
  echo "[smoke]   PASS — wft-router --version is '${router_ver_trimmed}'"

  echo "[smoke] assert 5: wft-router --validate <shipped example>  exits 0"
  set +e
  wft-router --validate "${pkg_root}/packages/wft-router/triggers.example.yaml" >/dev/null 2>&1
  router_validate_rc=$?
  set -e
  if [ "${router_validate_rc}" -ne 0 ]; then
    echo "ERROR: 'wft-router --validate <example>' exited ${router_validate_rc} (expected 0)." >&2
    exit 1
  fi
  echo "[smoke]   PASS — wft-router validated the shipped example config"
fi

# ----- done --------------------------------------------------------------------
end_ts=$(date +%s)
elapsed=$(( end_ts - start_ts ))
echo "[smoke] elapsed: ${elapsed}s"
echo "ALL SMOKE CHECKS PASSED"
