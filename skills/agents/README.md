Owner: Repository maintainers

# skills/agents/

Claude Code subagent definitions distributed alongside the `/tasks:*`
slash commands in `skills/tasks/`. `install.sh` and `install.ps1` copy
every `.md` file in this directory to `~/.claude/agents/` so the
subagents become invocable by Claude Code after install. See
[`docs/verifier-contract.md`](../../docs/verifier-contract.md) for the
authoritative protocol the `tasks-verifier` agent implements.
