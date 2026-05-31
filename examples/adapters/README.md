# Reference adapters for `agent_session_dispatch`

These are **vendor-neutral reference adapters** for the wft-router
`agent_session_dispatch` handler. The repo ships **zero blessed adapters** — an
adapter is a user-supplied executable the router invokes when a rule matches.
Copy one of these as the skeleton for your own.

See the full contract in
[docs/event-router-design.md → `agent_session_dispatch`](../../docs/event-router-design.md#agent_session_dispatch--extension-contract).

## The contract (summary)

- **Discovery.** The rule's `adapter:` name (matching `^[a-z][a-z0-9_-]*$`) is
  resolved by **basename** against the directories listed in
  `$WFT_ROUTER_ADAPTERS_PATH` (default: empty — adapters are opt-in). Symlinks
  escaping the directory are refused. Each directory must be **owned by the
  router user** and **not group/world-writable** (mode ≤ `0755`); the router
  skips directories that fail either check.
- **Input.** The triggering event arrives as **JSON on stdin**. Each `with:`
  key other than `adapter` is passed as one `key=value` **argv** entry (never
  spliced into a shell command).
- **Output.** Exit `0` = success; non-zero = failure (the router retries per
  `max_retries`). The **first line printed to stdout** is captured as an opaque
  session id and surfaced in the success log.
- **Environment.** Adapters run with a **scrubbed env** (`PATH`, `HOME`,
  `LANG`, `TZ`, the rule's own `token_env`, and any explicit `env:` block).

> **Security — adapter author requirements.** argv values are **untrusted task
> content** (a malicious task title is a trust-elevation vector). Adapters MUST
> NOT `eval` argv, MUST treat every argv value as an untrusted string, MUST NOT
> expand env vars from event content, and SHOULD validate length/charset before
> using a value in a shell command. The example adapters here only echo them.

## Files

| File | Runtime | Notes |
|---|---|---|
| `stdin-logger.ts` | Node (via `tsx`) | Minimal skeleton: logs argv + event size, prints a session id. Start here. |
| `webhook-bridge.ts` | Node (via `tsx`) | POSTs the event JSON to a `url=` argv target. (For a pure HTTP sink, prefer the built-in `webhook_post` handler.) |
| `stdin-logger.sh` | POSIX `sh` | Same contract as `stdin-logger.ts`, no Node required. |
| `stdin-logger.ps1` | PowerShell | Windows peer of `stdin-logger.sh`. |

The TypeScript and shell/PowerShell variants are **equals**, not a primary +
fallback — pick whichever matches your host.

## Use it

```sh
# 1. Put the adapter in a directory the router user owns, mode <= 0755.
mkdir -p ~/.local/share/wft-router/adapters
cp stdin-logger.sh ~/.local/share/wft-router/adapters/local-command
chmod 0755 ~/.local/share/wft-router/adapters/local-command ~/.local/share/wft-router/adapters

# 2. Opt the directory in.
export WFT_ROUTER_ADAPTERS_PATH=~/.local/share/wft-router/adapters

# 3. Reference it from a rule.
#    do: agent_session_dispatch
#    with:
#      adapter: local-command      # basename of the file above
#      target: my-project          # opaque to the router; meaningful to you
#      prompt: "task closed"
```

The adapter file's **basename** is the `adapter:` name. The `.ts` examples need
a shebang runner (`#!/usr/bin/env -S npx tsx`) or precompilation to `.js`; the
`.sh`/`.ps1` examples run directly once marked executable.
