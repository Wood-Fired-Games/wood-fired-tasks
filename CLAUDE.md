# CLAUDE.md

> See [AGENTS.md](AGENTS.md) for the canonical, vendor-neutral agent entry
> point. This file exists so Claude Code automatically discovers the project
> context — it is an **adapter** with no unique facts.

## What to read first

1. [AGENTS.md](AGENTS.md) — first-read navigation hub.
2. [docs/AGENT_CONTEXT.md](docs/AGENT_CONTEXT.md) — the contract that
   defines what counts as canonical agent context here.
3. [.agent-context.json](.agent-context.json) — machine-readable manifest.

## Maintenance

- This file MUST stay a thin pointer. The contract is in
  [docs/AGENT_CONTEXT.md](docs/AGENT_CONTEXT.md) §6.2.
- The freshness check (`npm run agent-context:check`) verifies that every
  link target exists; the manifest classifies this file as `authority: adapter`.
- Project-specific Claude Code config (slash commands, hooks, MCP client
  wiring) lives in `.claude/` (gitignored). Do not mirror facts here.
