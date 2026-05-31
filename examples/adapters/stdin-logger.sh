#!/usr/bin/env sh
# stdin-logger.sh — POSIX reference wft-router adapter (vendor-neutral).
#
# Same contract as stdin-logger.ts: the event JSON arrives on stdin, the rule's
# `with:` keys arrive as key=value argv entries, exit 0 = success, and the FIRST
# line printed to stdout is captured as an opaque session id. Diagnostics go to
# stderr so they never pollute the captured session id.
#
# SECURITY: argv values are UNTRUSTED task content. Never eval them and never
# pass them unquoted to another command. This example only echoes them.
set -eu

# Drain stdin (the event JSON) so the writer's pipe closes cleanly.
event="$(cat)"
printf '[stdin-logger.sh] event bytes: %s\n' "${#event}" >&2

target="default"
for pair in "$@"; do
  key="${pair%%=*}"
  val="${pair#*=}"
  printf '[stdin-logger.sh] %s=%s\n' "$key" "$val" >&2
  if [ "$key" = "target" ]; then
    target="$val"
  fi
done

# Opaque session id on stdout (first line). A real adapter returns its own.
printf 'stdin-logger-sh-%s-%s\n' "$target" "$(date +%s)"
