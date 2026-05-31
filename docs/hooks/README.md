# Client-side hooks: `validate-sha.mjs`

> **Status: optional reference material, not core server code.** Nothing in this
> directory is loaded, imported, or required by the wood-fired-tasks MCP server
> or CLI. It is a copy-paste reference hook you opt into on the *client* machine
> where your agent runs.

## What it does

`validate-sha.mjs` is a **PreToolUse** guard. Before your MCP client lets an
agent call the wood-fired-tasks tools that record evidence, the hook scans the
evidence text for tokens that look like git commit SHAs and checks each one
against the **local git repository** with `git cat-file -t <sha>`:

- `add_comment` — scans the comment `content`.
- `update_task` — scans `verification_evidence` (stringified, since it may be a
  structured object/array).

If **any** candidate SHA does not exist in the repo the client is running in,
the hook **blocks** the tool call (a Claude Code `deny` decision). If every SHA
resolves — or there are no SHA-looking tokens, or the tool is unrelated — the
call is **allowed** with no decision (normal permission flow continues).

A "candidate SHA" is a standalone lowercase/uppercase hex run of 7-40
characters that is **not** embedded inside a longer alphanumeric word. Hex that
is part of a UUID, an API key, or a `snake_case` identifier is deliberately
**not** flagged, to avoid false positives.

## Why it must be client-side

The server **cannot** verify a SHA. A single tasks instance tracks work across
many repositories spread over many developer machines and CI runners. The
commit `a1b2c3d` that proves task #608 was done lives only in the checkout where
that work happened — the server has no access to it, and likely never will. The
only place a SHA-existence check is meaningful is **where the repo lives**,
i.e. on the client, in `process.cwd()`. So this guard ships as an optional
client hook, not as server validation.

## How to install (Claude Code)

1. Keep this repo checked out (or copy `validate-sha.mjs` somewhere stable).
2. Merge the snippet from [`claude-code-settings.example.json`](./claude-code-settings.example.json)
   into your `~/.claude/settings.json` or the project's `.claude/settings.json`.
   Fix the `command` path if you copied the script elsewhere.
3. The hook requires only Node (ESM) and `git` on `PATH` — **zero npm deps**.
4. Restart / re-read settings so Claude Code picks up the hook.

The hook is vendor-neutral at its core: it reads `{ tool_name, tool_input }` on
stdin and matches on the trailing tool segment, so it works behind any MCP
namespace prefix. The `settings.json` binding (matcher syntax, the
`hookSpecificOutput` deny shape) is the Claude-Code-specific part — adapt the
thin read/emit layer for other clients that support a PreToolUse-style hook.

### PreToolUse contract implemented

- **stdin** (from client): `{ "tool_name": "...", "tool_input": { ... }, ... }`
- **stdout to deny** (exit 0):
  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "..."
    }
  }
  ```
- **allow**: exit 0 with no JSON on stdout (normal permission flow applies).

## Honest limitation

This hook blocks **nonexistent** SHA tokens. It cannot:

- tell whether a real-but-wrong SHA is the *correct* commit for the claim;
- verify that a row count, dollar figure, exit code, or test pass count an agent
  writes into evidence is truthful;
- check SHAs against a repo that is not the client's current working directory.

If the client is not inside a git repo, the hook **skips** (allows) rather than
blocking — it cannot verify, so it does not pretend to. Treat it as one cheap
tripwire against the most common fabrication (a made-up commit hash), not as a
complete evidence-integrity system.
