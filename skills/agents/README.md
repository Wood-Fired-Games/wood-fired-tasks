Owner: Repository maintainers

# skills/agents/

Claude Code subagent definitions distributed alongside the `/tasks:*`
slash commands in `skills/tasks/`. `wood-fired-tasks setup` (and
`tasks self-update`) copy the agent definitions in this directory to
`~/.claude/agents/` so the subagents become invocable by Claude Code;
`README.md` is excluded from the copy. See
[`docs/verifier-contract.md`](../../docs/verifier-contract.md) for the
authoritative protocol the `tasks-verifier` agent implements.
