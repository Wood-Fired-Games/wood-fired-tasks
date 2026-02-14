# Project Research Summary

**Project:** Wood Fired Bugs v1.2 - Claude Code Skills & Cross-Platform Installer
**Domain:** Developer Tools - AI Agent Integration & Installation Automation
**Researched:** 2026-02-13
**Confidence:** HIGH

## Executive Summary

Wood Fired Bugs v1.2 extends the existing MCP-enabled task tracking service with Claude Code skills (teaching Claude how to use the system) and cross-platform installers for Linux and Windows. Research shows this is a straightforward integration: skills are markdown files with YAML frontmatter that reference MCP tools by fully qualified names, and installers are platform-specific scripts (Bash/PowerShell) that copy skills and configure the MCP server in Claude Code's config file.

The recommended approach uses no new npm dependencies. Skills live in `~/.claude/skills/tasks/` and reference existing MCP tools with the prefix `mcp__wood-fired-bugs__`. The installer generates a unique API key, writes it to both the MCP server's `env` configuration and the project `.env` file, tests connectivity, and confirms success. The Linux installer uses Bash with jq for JSON merging; the Windows installer uses PowerShell 7+ with native JSON cmdlets.

The critical risks are all related to incorrect configuration: using unqualified tool names in skills (causes "tool not found" errors), writing MCP server logs to stdout instead of stderr (breaks stdio transport), and setting environment variables only in shell profiles (doesn't work for GUI-launched Claude Code). All risks are preventable with careful attention to MCP protocol requirements and cross-platform environment variable handling, specifically using the MCP config's `env` section for API key rather than relying on shell profiles.

## Key Findings

### Recommended Stack

The stack requires zero new dependencies beyond what's already in Wood Fired Bugs v1.1. Skills are markdown files, MCP configuration is JSON, and installers use platform-native scripting.

**Core technologies:**
- **Markdown + YAML frontmatter** (skills) — Official Claude Code skill format, no execution runtime needed
- **JSON** (MCP config) — Claude Desktop's native configuration at `~/.config/Claude/claude_desktop_config.json` (Linux) or equivalent platform locations
- **Bash 4.0+** (Linux installer) — Universal on Linux/macOS, handles symlinks and directory creation with jq for JSON merging
- **PowerShell 7.0+** (Windows installer) — Microsoft's cross-platform shell with native JSON manipulation via `ConvertFrom-Json`/`ConvertTo-Json`
- **Node.js** (existing) — Already required for MCP server runtime via `@modelcontextprotocol/sdk`, no version change needed

**Critical version note:** PowerShell 7+ is NOT the same as Windows PowerShell 5.1. Scripts must target 7+ for cross-platform compatibility and modern JSON handling.

### Expected Features

Research identified 10 table stakes features and 10 differentiators, with clear anti-features to avoid.

**Must have (table stakes):**
- Basic workflow skills (create, list, update, show, delete tasks) — Users invoke these repeatedly
- MCP server auto-configuration — Manual JSON editing is unacceptable friction
- Environment variable setup for API key — Standard security practice, not hardcoded
- Connectivity test post-install — Validates installation worked before user tries skills
- Cross-platform support (Linux + Windows) — Developers use both platforms
- Skill namespace (`/tasks:*` commands) — Prevents collision with other skills
- Status transition skills (pick-up, done, blocked) — Common lifecycle operations
- Search and comment skills — Essential for collaborative task tracking
- Project context skill — Multi-project systems need project-level views

**Should have (competitive):**
- Skills use MCP tools exclusively (no REST) — Native Claude Code integration, leverages MCP's structured content
- Installer validates existing MCP config — Preserves other servers, prevents config corruption
- Installer backup before modification — Rollback if something breaks
- Health check integrated into installer — Validates service running and MCP tools accessible
- Skill argument templating — Power users can invoke `/tasks:show-task 123` instead of being prompted
- Interactive prompts for missing fields — Casual users prefer guidance

**Defer (v2+):**
- Batch operation skills — Wait for user feedback on need
- Custom workflow templates — Wait to see what workflows users actually want
- Plugin marketplace submission — After validating manual install works
- Docker Compose integration — Current assumption is service already running

### Architecture Approach

The architecture builds on v1.1's existing MCP server without changes. Skills live on the user's machine and reference MCP tools by name. The installer handles all setup: skill file copying, MCP configuration, environment variables, and connectivity testing.

**Major components:**
1. **Skill files (10 markdown files)** — Instructions for Claude; reference MCP tools like `mcp__wood-fired-bugs__create_task`
2. **MCP server configuration** — Global `~/.claude.json` or `~/.config/Claude/claude_desktop_config.json` with absolute paths and API key in `env` section
3. **Cross-platform installers** — Separate Bash (Linux) and PowerShell (Windows) scripts with platform detection, dependency verification, build steps, config merging, and connectivity testing
4. **Integration with existing MCP server** — No changes to v1.1 server; skills invoke 25 existing tools through Claude Code's MCP integration

**Key architectural facts:**
- Skills are static files, not executable code — Claude Code interprets them
- MCP tool names are fully qualified: `mcp__wood-fired-bugs__<tool_name>`
- MCP server configured globally for cross-project availability
- API key must be in MCP config's `env` section, not just shell profile (GUI apps don't source profiles)
- Absolute paths required in MCP config (Claude Code working directory unknown)

### Critical Pitfalls

1. **Using unqualified MCP tool names in skills** — Skills must reference `mcp__wood-fired-bugs__create_task`, not just `create_task`. Unqualified names cause "tool not found" errors. Prevention: Always run `/mcp` command first to see exact tool names Claude Code expects, document naming convention in skill authoring guide.

2. **Writing MCP server logs to stdout instead of stderr** — Stdio transport reserves stdout exclusively for JSON-RPC messages. Any `console.log()` output corrupts the stream, causing -32000 connection errors. Prevention: Use `console.error()` for ALL logging, configure Pino to write to stderr, validate stdout contains ONLY JSON-RPC.

3. **MCP server path using relative paths** — Relative paths in `~/.claude.json` resolve from Claude Code's working directory (not project directory), causing "module not found" errors. Prevention: Installer must compute and write absolute paths like `/home/user/wood-fired-bugs/dist/mcp/index.js`.

4. **Shell profile detection writing to wrong RC file** — Installer writing to `~/.bashrc` when user's shell is zsh (reads `~/.zshrc`) or fish (reads `~/.config/fish/config.fish`) means environment variable never loads. Prevention: Detect shell via `$SHELL`, write to appropriate profile, use fish-specific syntax for fish.

5. **Environment variables not persisting in Claude Code** — Shell profile environment variables work in terminal but not for GUI-launched Claude Code (doesn't source profiles). Prevention: Write API key to MCP config's `env` section, not just shell profile. This is the definitive location for MCP server environment.

## Implications for Roadmap

Based on research, suggested 3-phase structure with clear separation of verification, authoring, and installation:

### Phase 8: MCP Server Verification & Cleanup
**Rationale:** Must verify existing v1.1 MCP server doesn't have stdio transport violations before writing skills. Research identified stdout logging as critical pitfall causing -32000 errors.
**Delivers:** MCP server confirmed stdio-compliant (no console.log), logs routed to stderr, connectivity test passing.
**Addresses:** Pitfall 2 (stdout logging), prerequisite for skill invocation.
**Avoids:** Building skills that reference broken MCP server; discovering transport issues after skill authoring complete.

### Phase 9: Skill File Authoring
**Rationale:** Skills can be written once MCP server verified. Skills are static markdown, no code changes needed. Must use verified tool names from `/mcp` command output.
**Delivers:** 10 skill markdown files in `skills/` directory with correct tool names, namespace, examples, and procedures.
**Addresses:** Table stakes features (create, list, update, show, delete, project, dependency, comment, subtask, health), namespace prefix (`/tasks:*`), argument templating.
**Avoids:** Pitfall 1 (unqualified tool names) by using full names from start; Pitfall "skills without namespace" by installing to `tasks/` subdirectory.
**Uses:** Markdown format from STACK.md, skill structure from ARCHITECTURE.md (frontmatter + procedure + examples).

### Phase 10: Cross-Platform Installer Scripts
**Rationale:** Skills exist but users can't use them without installation. Installer complexity high due to cross-platform requirements, MCP config merging, and environment variable handling.
**Delivers:** Bash installer (Linux/macOS), PowerShell installer (Windows), both with dependency verification, config merging, API key generation, connectivity testing.
**Addresses:** Table stakes features (MCP auto-configuration, env var setup, connectivity test, backup & rollback), differentiators (config validation, health check).
**Avoids:** Pitfall 3 (relative paths) by computing absolute paths; Pitfall 4 (shell detection) by checking `$SHELL`; Pitfall 5 (execution policy) by documenting bypass; Pitfall 6 (env var persistence) by writing to MCP config `env` section.
**Uses:** Bash/PowerShell from STACK.md, installer architecture from ARCHITECTURE.md (detect, verify, build, copy, configure, test).

### Phase Ordering Rationale

- **Phase 8 first:** Can't test skills against broken MCP server. Verification is prerequisite.
- **Phase 9 second:** Skills require verified MCP server but are independent of installer. Can test manually before automation exists.
- **Phase 10 last:** Installer automates what was tested manually in Phase 9. Can validate against working skills.

**Dependency chain:** MCP verification → Skill authoring → Installer automation

**Parallel work opportunity:** None. Each phase depends on previous completion for testing.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 8 (MCP Server Verification):** Deeper research needed — Must audit existing v1.1 server for console.log() usage, verify stdio transport compliance, may need refactoring if violations found. Research showed this is common mistake.
- **Phase 10 (Windows Installer):** Deeper research needed — PowerShell execution policy handling, path separator issues, environment variable for GUI apps, testing on actual Windows (not WSL). More complex than Linux installer.

Phases with standard patterns (skip research-phase):
- **Phase 9 (Skill Authoring):** Standard patterns available — MCP tool usage well-documented in official skills repo and plugin-dev examples. Follow established markdown format with verified tool names.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Official Claude Code docs, established MCP SDK, standard shell scripting. No new dependencies to evaluate. |
| Features | HIGH | Clear differentiation from research: table stakes (10 core skills + installer), competitive (validation + health check), anti-features (GUI, auto-update, REST fallback). |
| Architecture | HIGH | Builds on working v1.1 MCP server. Skill format and MCP integration documented in official sources. Standard installer patterns. |
| Pitfalls | HIGH | All 7 critical pitfalls documented in official troubleshooting guides and community best practices. Prevention strategies verified. |

**Overall confidence:** HIGH

### Gaps to Address

- **MCP server tool name verification:** Must run `/mcp` command in Claude Code to capture exact tool names before writing skills. Research showed naming convention but need to verify actual output format.
- **Shell profile syntax for fish:** Research identified fish uses `set -Ux` instead of `export`, but installer may need to test actual fish configuration to verify syntax.
- **Windows PowerShell version detection:** Need to verify how installer detects PowerShell 5.1 vs 7+ and warns users if version insufficient. Research showed `#Requires -Version 7.0` directive but fallback behavior unclear.
- **Existing v1.1 server audit:** Must verify if current MCP server uses console.log() anywhere. Research flagged this as common mistake but unknown if present in this codebase.

These gaps are minor and resolvable during phase execution through testing and verification, not blockers.

## Sources

### Primary (HIGH confidence)
- [Extend Claude with skills - Claude Code Docs](https://code.claude.com/docs/en/skills) — Skill format, frontmatter, tool references
- [Connect to local MCP servers - Model Context Protocol](https://modelcontextprotocol.io/docs/develop/connect-local-servers) — MCP configuration, env section, absolute paths
- [STDIO Transport - MCP Framework](https://mcp-framework.com/docs/Transports/stdio-transport/) — stdout/stderr requirements, JSON-RPC protocol
- [GitHub - anthropics/skills](https://github.com/anthropics/skills) — Official skill examples, tool naming patterns
- [GitHub - PowerShell/PowerShell](https://github.com/PowerShell/PowerShell) — PowerShell 7 cross-platform features

### Secondary (MEDIUM confidence)
- [PowerShell 7 Cross-Platform Scripting Tips and Traps](https://jdhitsolutions.com/blog/scripting/7361/powershell-7-cross-platform-scripting-tips-and-traps/) — Path handling, cmdlet usage
- [Configuring MCP Tools in Claude Code - Scott Spence](https://scottspence.com/posts/configuring-mcp-tools-in-claude-code) — Config file locations, examples
- [MCP Server Troubleshooting Guide 2025](https://www.mcpstack.org/learn/mcp-server-troubleshooting-guide-2025) — Common pitfalls, error codes
- [Moving to zsh, part 2: Configuration Files](https://scriptingosx.com/2019/06/moving-to-zsh-part-2-configuration-files/) — Shell profile detection

### Tertiary (LOW confidence)
- [Claude Skills and CLAUDE.md: a practical 2026 guide](https://www.gend.co/blog/claude-skills-claude-md-guide) — Community guide, supplemental examples
- [Ultimate Guide to Claude MCP Servers & Setup | 2026](https://generect.com/blog/claude-mcp/) — Community tutorial, installation patterns

---
*Research completed: 2026-02-13*
*Ready for roadmap: yes*
