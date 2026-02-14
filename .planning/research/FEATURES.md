# Feature Research

**Domain:** Claude Code Skills & Cross-Platform Installer for Task Tracking Service
**Researched:** 2026-02-13
**Confidence:** HIGH

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Basic workflow skills (log-bug, create-task, my-work, show-task) | Core task operations users invoke repeatedly; standard pattern in task tracking tools | LOW | Skills orchestrate existing MCP tools with minimal prompts |
| MCP server auto-configuration | Claude Code users expect installer to handle `claude_desktop_config.json` modification; manual JSON editing is friction | MEDIUM | Must merge with existing config, handle Windows/macOS paths, validate JSON |
| Environment variable setup for API key | Auth credential should be in env var, not hardcoded in skills; standard security practice | LOW | Installer writes to shell profile or system env depending on platform |
| Connectivity test post-install | Users expect validation that installation worked; prevents "installed but not working" confusion | LOW | Test skill invokes health check via MCP tool, reports success/failure |
| Cross-platform support (Linux + Windows) | Installer must work on developer's actual platforms; single-platform tools feel incomplete | MEDIUM | Separate Bash/PowerShell scripts with shared logic patterns |
| Skill namespace (/tasks:command) | Prevents collision with other skills; Claude Code best practice per official docs | LOW | Skills installed to `~/.claude/skills/tasks/` directory |
| Status transition skills (pick-up, done, blocked) | Users work in task lifecycle states; dedicated skills for common transitions reduce friction | LOW | Each skill is simple MCP tool call with status parameter |
| Search skill | Task tracking is useless without search; users expect to find tasks by keyword | LOW | Delegates to existing `search_tasks` MCP tool |
| Comment skill | Communication on tasks is table stakes for collaborative work tracking | LOW | Uses `add_comment` MCP tool with interactive prompt for comment text |
| Project context skill (project-status) | Multi-project systems need project-level views; agents need project overview | MEDIUM | Combines `list_tasks` filtered by project with `get_project` for metadata |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Skills use MCP tools exclusively (no REST calls) | Native Claude Code integration; skills leverage MCP's structured content, permission system, and error handling | LOW | Architectural decision already validated in v1.1 MCP server |
| Installer validates existing MCP config | Most installers blindly overwrite; ours preserves existing servers and prevents config corruption | HIGH | Must parse JSON, detect conflicts, merge safely, validate syntax |
| Unified installer detection (auto-detect platform) | User runs one command, installer adapts; competitors require manual platform selection | MEDIUM | Detect via `uname`/`$IsWindows`, invoke appropriate script |
| Skill argument templating ($ARGUMENTS substitution) | Users can invoke `/tasks:show-task 123` instead of being prompted; power users save keystrokes | LOW | Built into Claude Code skill system per official docs |
| Interactive prompts for missing fields | Skills prompt for required data when invoked without arguments; casual users prefer guidance | LOW | Use skill content to instruct Claude to ask for missing fields |
| Installer backup before modification | Backs up `claude_desktop_config.json` before changes; rollback if something breaks | MEDIUM | Copy to timestamped backup, restore on failure |
| Health check integrated into installer | Installer doesn't just copy files; validates service is running and MCP tools are accessible | MEDIUM | Requires service to be running; installer should provide troubleshooting if health fails |
| Skills include examples in description | Skill descriptions show usage examples; Claude can reference when suggesting skill invocation | LOW | Part of skill frontmatter `description` field |
| Skill permissions pre-configured | Skills specify `allowed-tools` to avoid repeated permission prompts for trusted MCP tools | LOW | Frontmatter feature from official docs; improves UX for repetitive workflows |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| GUI installer | "Visual tools are easier for non-technical users" | This is a developer tool for LLM agents; target users are comfortable with CLI. GUI adds dependency hell (Electron/Qt), platform fragmentation, testing burden. | Clear terminal output with progress indicators and troubleshooting messages |
| Auto-update checker in skills | "Keep skills fresh with latest features" | Network I/O on every skill invocation adds latency. Users control Claude Code environment; forced updates break workflows. | Document update command (`git pull` in skills directory) with changelog |
| Single "do-everything" skill | "One skill is simpler than many" | Loses discoverability (Claude can't pick the right tool). Violates single-responsibility. Harder to iterate on individual workflows. | Focused skills that do one thing well; Claude orchestrates combinations |
| REST API fallback in skills | "What if MCP server isn't configured?" | Adds HTTP client dependency to skills (impossible in markdown). Skills assume prerequisites met. | Installer validation ensures MCP server is configured; error message guides user if not |
| Embedded API key in skills | "Avoids environment variable setup" | Hardcoded secrets in `~/.claude/skills/` are a security anti-pattern. Skills are plain text; API key would be visible in backups. | Environment variable `WFB_API_KEY` set by installer; skills reference via MCP server env config |
| Skill file generation from OpenAPI | "Auto-generate skills from REST API spec" | Generated skills are verbose, generic, don't capture workflow intent. Hand-crafted skills encode domain knowledge (e.g., "log-bug" implies specific fields). | Curate workflows manually; 10 well-designed skills > 19 auto-generated ones |
| Installer modifies system Python/Node | "Ensure dependencies are available" | Users manage their own runtime environments. Modifying system packages causes conflicts. MCP server already installed (prerequisite). | Document prerequisites; installer validates they exist; fails gracefully with instructions if missing |

## Feature Dependencies

```
[Installer: Skill Copy]
    └──requires──> [Skills: Workflow Files Exist]

[Installer: MCP Config]
    └──requires──> [MCP Server: Published to npm]

[Skills: MCP Tool Invocation]
    └──requires──> [MCP Server: Running & Configured]
                       └──requires──> [API Service: Running]

[Installer: Connectivity Test]
    └──requires──> [Skills: Health Check Skill]
                       └──requires──> [MCP Server: check_health tool]

[Skills: Argument Substitution] ──enhances──> [Skills: Interactive Prompts]

[Installer: Unified Script] ──conflicts──> [Installer: Platform-Specific Only]
```

### Dependency Notes

- **Installer: Skill Copy requires Skills: Workflow Files Exist**: Skills must be written before installer can copy them
- **Installer: MCP Config requires MCP Server: Published to npm**: Config references `npx @modelcontextprotocol/server-wood-fired-bugs` which must exist in npm registry
- **Skills: MCP Tool Invocation requires MCP Server: Running & Configured**: Skills are useless without MCP server; installer must configure and test
- **Installer: Connectivity Test requires Skills: Health Check Skill**: Installer invokes health check skill to validate installation; skill must exist first
- **Skills: Argument Substitution enhances Skills: Interactive Prompts**: Users can provide arguments directly (`/tasks:show-task 123`) or be prompted if missing; both patterns complement each other
- **Installer: Unified Script conflicts with Installer: Platform-Specific Only**: Can't have both a single cross-platform script and platform-specific scripts; choose platform detection in launcher with platform-specific implementations

## MVP Definition

### Launch With (v1.2)

Minimum viable product — what's needed to validate the concept.

- [x] **Skills: Core Workflows** — log-bug, create-task, my-work, show-task, search (5 skills cover 80% of usage)
- [x] **Skills: Lifecycle Transitions** — pick-up, done, blocked (3 skills for status changes)
- [x] **Skills: Communication** — add-comment (1 skill for collaboration)
- [x] **Skills: Project Context** — project-status (1 skill for project overview)
- [x] **Installer: Linux (Bash)** — Covers primary deployment platform (Stuart's Ubuntu machine)
- [x] **Installer: Windows (PowerShell)** — Covers secondary platform (Stuart's Windows dev machine)
- [x] **Installer: Skill Copy** — Copies skill files to `~/.claude/skills/tasks/`
- [x] **Installer: MCP Config** — Modifies `claude_desktop_config.json` to add wood-fired-bugs server
- [x] **Installer: API Key Setup** — Prompts for API key, writes to appropriate shell profile
- [x] **Installer: Connectivity Test** — Validates MCP server can reach API service
- [x] **Installer: Backup & Rollback** — Backs up config before modification

### Add After Validation (v1.x)

Features to add once core is working.

- [ ] **Skills: Batch Operations** — Trigger when users say "mark tasks 1,2,3 as done" (wait for user feedback on need)
- [ ] **Skills: Smart Suggestions** — Skill descriptions rich enough for Claude to auto-invoke based on context (iterate based on usage patterns)
- [ ] **Installer: Dry Run Mode** — Show what would be changed without modifying files (add when users request it)
- [ ] **Installer: Uninstall** — Remove skills, clean up config, remove env var (add when users need to test fresh installs)
- [ ] **Skills: Dependency Visualization** — ASCII graph of task dependencies (add if users request it; current `dep-list` may be sufficient)

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] **Skills: Custom Workflow Templates** — User-defined skill templates for domain-specific workflows (v2: once we see what workflows users actually want)
- [ ] **Installer: Plugin Marketplace Submission** — Package as Claude Code plugin for distribution via Anthropic's marketplace (v2: after validating manual install works)
- [ ] **Skills: AI-Assisted Triage** — Skill that uses Claude's reasoning to suggest priority/status based on description (v2: experimental; may be over-engineered)
- [ ] **Installer: Docker Compose Integration** — Installer also sets up API service via Docker if not detected (v2: current assumption is service already running)

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Core workflow skills (log-bug, create-task, my-work, show-task, search) | HIGH | LOW | P1 |
| Lifecycle skills (pick-up, done, blocked) | HIGH | LOW | P1 |
| MCP server auto-configuration | HIGH | MEDIUM | P1 |
| Cross-platform installer (Linux + Windows) | HIGH | MEDIUM | P1 |
| Connectivity test | HIGH | LOW | P1 |
| Comment skill | MEDIUM | LOW | P1 |
| Project-status skill | MEDIUM | MEDIUM | P1 |
| Installer config validation & merge | HIGH | HIGH | P1 |
| Installer backup & rollback | MEDIUM | MEDIUM | P1 |
| Environment variable setup | HIGH | LOW | P1 |
| Skills with argument substitution | MEDIUM | LOW | P2 |
| Interactive prompts in skills | MEDIUM | LOW | P2 |
| Skill permissions pre-configuration | MEDIUM | LOW | P2 |
| Installer dry run mode | LOW | LOW | P2 |
| Installer uninstall | LOW | LOW | P2 |
| Batch operation skills | LOW | MEDIUM | P3 |
| Smart skill auto-invocation | MEDIUM | HIGH | P3 |
| Custom workflow templates | LOW | HIGH | P3 |
| Plugin marketplace packaging | LOW | HIGH | P3 |

**Priority key:**
- P1: Must have for launch (v1.2)
- P2: Should have, add when possible (v1.x)
- P3: Nice to have, future consideration (v2+)

## Competitor Feature Analysis

| Feature | GitHub CLI (`gh`) | Linear CLI (`linear-cli`) | Our Approach |
|---------|-------------------|---------------------------|--------------|
| Slash commands / skills | No native Claude Code skills; users write their own | No native Claude Code skills | Curated workflow skills included; installer sets them up |
| Installation | `brew install gh` or platform package managers | `npm install -g @linear/cli` | Custom installer that also configures Claude Code integration |
| Auth setup | `gh auth login` (interactive OAuth flow) | `linear-cli login` (API key prompt) | Installer prompts for API key, writes to env var |
| MCP integration | Community-built MCP servers exist (not official) | No official MCP server | Official MCP server included; installer configures it |
| Cross-platform | Official binaries for Linux/macOS/Windows | npm package works cross-platform | Bash for Linux, PowerShell for Windows (matches platform conventions) |
| Configuration | Writes to `~/.config/gh/config.yml` | Stores API key in `~/.linear/credentials` | Uses Claude Code's native `claude_desktop_config.json` + env var for API key |
| Workflow shortcuts | Aliases (`gh alias set`) for custom commands | No built-in workflow shortcuts | Skills are the workflow shortcuts; no separate alias system needed |
| Skill discoverability | N/A | N/A | Skills show in `/` menu with descriptions; Claude suggests them based on context |

## Sources

**Claude Code Skills & Slash Commands:**
- [Slash commands - Claude Code Docs](https://code.claude.com/docs/en/slash-commands)
- [GitHub - hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)
- [GitHub - wshobson/commands: Production-ready slash commands](https://github.com/wshobson/commands)
- [Claude Code Merges Slash Commands Into Skills (Medium)](https://medium.com/@joe.njenga/claude-code-merges-slash-commands-into-skills-dont-miss-your-update-8296f3989697)
- [Claude Code Skills vs Slash Commands 2026: Complete Guide (YingTu)](https://yingtu.ai/blog/claude-code-skills-vs-slash-commands)

**MCP Server Configuration:**
- [Connect to local MCP servers - Model Context Protocol](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- [Getting Started with Local MCP Servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [Ultimate Guide to Claude MCP Servers & Setup | 2026](https://generect.com/blog/claude-mcp/)

**Cross-Platform Installer Best Practices:**
- [Tips for Writing Cross-Platform PowerShell Code (PowerShell.org)](https://powershell.org/2019/02/tips-for-writing-cross-platform-powershell-code/)
- [PowerShell Beyond Windows: A Cross-Platform Guide (Medium)](https://medium.com/@josephsims1/powershell-beyond-windows-a-cross-platform-guide-2f6d6de473dd)
- [PowerShell 7 Cross-Platform Scripting Tips and Traps](https://jdhitsolutions.com/blog/scripting/7361/powershell-7-cross-platform-scripting-tips-and-traps/)
- [Developer Onboarding Best Practices (Document360)](https://document360.com/blog/developer-onboarding-best-practices/)
- [Best Practices for DevRel Programs That Actually Work in 2026](https://blog.stateshift.com/best-practices-for-devrel-programs/)

**Developer Tool Onboarding:**
- [How to Understand Global vs Local npm Packages (OneUpTime)](https://oneuptime.com/blog/post/2026-01-22-nodejs-global-vs-local-packages/view)
- [Downloading and installing packages globally (npm Docs)](https://docs.npmjs.com/downloading-and-installing-packages-globally/)

---
*Feature research for: Claude Code Skills & Cross-Platform Installer*
*Researched: 2026-02-13*
