# Phase 21: UX Polish - Context

**Gathered:** 2026-02-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Polish the CLI experience with progress indicators for slow operations, consistent colored output across all commands, and shell completions for bash and zsh. The CLI already uses chalk with NO_COLOR support in formatters.ts — this phase standardizes and extends that foundation.

</domain>

<decisions>
## Implementation Decisions

### Progress indicator style
- Use @clack/prompts spinner (already a dependency) for consistency with existing interactive prompts
- Show spinner for any network request to the REST API that takes longer than 2 seconds
- Spinner shows operation description (e.g., "Creating task...", "Fetching tasks...")
- Suppress spinner in --json mode and when stdout is not a TTY (piped output)
- No progress bars — operations are either instant or waiting on network; there's no meaningful percentage to show

### Color consistency
- Keep existing color scheme in formatters.ts (blue=open, yellow=in_progress, green=done, gray=closed, red=blocked, magenta=backlogged)
- Audit all 24 CLI commands to ensure they use formatStatus/formatPriority/shouldUseColor from formatters.ts instead of direct chalk calls
- Success messages: chalk.green consistently
- Error messages: chalk.red consistently
- Warning messages: chalk.yellow consistently
- Info/hint messages: chalk.gray consistently
- Ensure all chalk usage goes through shouldUseColor() guard — no direct chalk calls that bypass NO_COLOR

### Shell completions
- Use Commander.js built-in completion support if available, otherwise generate static completion scripts
- Complete commands and subcommands (tasks create, tasks list, etc.)
- Complete flags (--status, --priority, --assignee, --json, --force, etc.)
- Complete enum values for --status and --priority flags (the 6 statuses, 4 priorities)
- Dynamic completion for task IDs and project names is nice-to-have but not required (would need API calls)
- Provide install instructions for both bash and zsh in a `tasks completions` command
- Output completion script to stdout so users can pipe: `tasks completions bash > ~/.bash_completion.d/tasks`

### Claude's Discretion
- Exact spinner timing threshold (2 seconds is guidance, adjust if it feels wrong in practice)
- Whether to wrap the API client calls or the command handlers for spinner integration
- Specific wording of spinner messages
- Completion script installation path recommendations

</decisions>

<specifics>
## Specific Ideas

- The existing @clack/prompts dependency provides spinner functionality — reuse it rather than adding ora or another spinner library
- The formatters.ts file already has the shouldUseColor() pattern — extend it, don't replace it
- Commander.js (already in use) has some completion support — investigate before building custom
- Stuart is the sole CLI user on Ubuntu — bash and zsh are the only shells that matter

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 21-ux-polish*
*Context gathered: 2026-02-17*
