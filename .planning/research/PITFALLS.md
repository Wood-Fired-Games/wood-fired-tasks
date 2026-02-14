# Pitfalls Research: Claude Code Skills & Cross-Platform Installer

**Domain:** Adding Claude Code skills and cross-platform installer to existing MCP-enabled task tracking service
**Context:** Subsequent milestone v1.2 - Adding skill files that reference MCP tools + Bash/PowerShell installer
**Researched:** 2026-02-13
**Confidence:** HIGH

## Critical Pitfalls

Mistakes that cause skill invocation failures, broken MCP connections, or installer failures on target platforms.

### Pitfall 1: Using Unqualified MCP Tool Names in Skills

**What goes wrong:**
Skill markdown files reference MCP tools with simple names like `create_task` or `list_tasks`, but Claude Code requires fully qualified tool names with the prefix `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`. When skills use unqualified names, Claude cannot find the tools even though the MCP server is correctly configured and connected. Skills fail with "tool not found" errors despite the server showing all tools available via `/mcp`.

**Why it happens:**
The MCP server defines tools with simple names (`create_task`, `get_task`, etc.) in its implementation. Developers write skill markdown referencing these same simple names, assuming Claude Code will auto-resolve them. However, Claude Code's MCP integration namespaces all tools to prevent collisions when multiple MCP servers are configured. A tool named `create_task` in server `wood-fired-bugs` becomes `mcp__plugin_tasks_wood-fired-bugs__create_task`. Documentation often shows simple tool names in examples, leading developers to copy the pattern without understanding the qualification requirement.

**Consequences:**
- Skills invoke but fail immediately with "tool not found"
- Error messages don't clearly indicate the qualification issue
- Developers waste time debugging MCP server configuration thinking it's not connected
- Users see "cannot complete action" without understanding the root cause
- Skills work in testing with simplified configs but fail in production with multiple MCP servers
- Skill must be completely rewritten with corrected tool names

**Prevention:**
- **ALWAYS** use fully qualified tool names in skill markdown: `mcp__plugin_tasks_wood-fired-bugs__create_task`
- Run `/mcp` command before writing skills to see exact tool names Claude Code expects
- Document tool naming convention in skill authoring guide: `mcp__plugin_<plugin>_<server>__<tool>`
- Use consistent naming: if server is `wood-fired-bugs`, plugin should be `tasks` for `mcp__plugin_tasks_wood-fired-bugs__*`
- Test skills in environment with multiple MCP servers to verify qualification works
- Add tool name reference section to each skill documenting the exact names used
- In installer, document that users can run `/mcp` to verify tool names after installation

**Detection:**
- Skills trigger but immediately fail with tool invocation errors
- `/mcp` command shows tools available but skill can't use them
- Error logs show "tool not found: create_task" when tool exists as `mcp__plugin_tasks_wood-fired-bugs__create_task`
- Skills work in minimal test environment but fail with additional MCP servers installed
- Claude Code prompts for tool approval but using wrong tool name

**Phase to address:**
Phase 9 (Skill Authoring) - Tool names must be correctly qualified from the start. Incorrect names require rewriting all skill markdown.

**Sources:**
- [Extend Claude with skills - Claude Code Docs](https://code.claude.com/docs/en/skills)
- [Using MCP Tools in Commands and Agents - Plugin Dev Reference](https://github.com/anthropics/claude-plugins-official/plugins/plugin-dev/skills/mcp-integration/references/tool-usage.md)
- [The Pulumi Blog on Claude Skills](https://www.pulumi.com/blog/top-8-claude-skills-devops-2026/)

---

### Pitfall 2: Writing MCP Server Logs to stdout Instead of stderr

**What goes wrong:**
The MCP server uses stdio transport and writes debug logs, info messages, or console.log() output to stdout. The stdio transport reserves stdout exclusively for JSON-RPC protocol messages (one per line, no embedded newlines). Any non-protocol output corrupts the message stream, causing -32000 "Connection closed" or "Unexpected token" parsing errors. Claude Code cannot connect to the MCP server even though the server starts successfully.

**Why it happens:**
Developers add `console.log()` debugging during development or use logging libraries with default stdout output. The MCP SDK documentation mentions stderr but doesn't enforce it, and console.log() is the default Node.js debugging habit. The server runs fine in isolation (stdio transport doesn't complain locally), but when Claude Code connects, any stdout pollution breaks JSON-RPC parsing. The error appears as a connection failure, not a logging issue, so developers troubleshoot the wrong problem.

**Consequences:**
- MCP server appears in Claude Code settings but shows "disconnected" or "error"
- `-32000 Connection closed` error without clear indication of cause
- Intermittent connection issues when logs happen to coincide with message traffic
- "Unexpected token" JSON parsing errors when log lines arrive mid-message
- Debug logs intended to help troubleshooting are the actual cause of failure
- Server works in testing (without Claude Code client) but fails in production

**Prevention:**
- **NEVER** use `console.log()` in MCP servers using stdio transport
- **ALWAYS** use `console.error()` for all logging (debug, info, error, everything)
- Configure Pino or other logging libraries to write to stderr: `pino({ dest: process.stderr })`
- Set environment variable in installer to disable debug logging in production: `NODE_ENV=production`
- Validate stdio protocol compliance: stdout must contain ONLY JSON-RPC messages (one per line)
- Add comment in server code: `// CRITICAL: stdio transport - ALL logs must use console.error() not console.log()`
- Test connection with logging enabled to verify stderr routing

**Detection:**
- Run `node dist/mcp/index.js` and verify output is ONLY JSON-RPC (no plaintext logs)
- `-32000` or parsing errors in Claude Code MCP connection
- Server process runs but Claude Code shows "disconnected"
- Logs appear on stdout when running server standalone
- Search codebase for `console.log` in MCP server code
- Grep for `pino()` without `dest: process.stderr` configuration

**Phase to address:**
Phase 8 (MCP Server Verification) - Must be fixed before skills can reference tools. Existing v1.1 server may already have this issue if console.log() was used during development.

**Sources:**
- [STDIO Transport - MCP Framework](https://mcp-framework.com/docs/Transports/stdio-transport/)
- [Debugging Model Context Protocol Servers](https://www.mcpevals.io/blog/debugging-mcp-servers-tips-and-best-practices)
- [MCP Server Troubleshooting Guide 2025](https://www.mcpstack.org/learn/mcp-server-troubleshooting-guide-2025)

---

### Pitfall 3: MCP Server Path in config.json Using Relative or Wrong Paths

**What goes wrong:**
The Claude Code MCP configuration in `~/.claude/config.json` specifies the command to start the MCP server with a path like `"command": "node"` and `"args": ["dist/mcp/index.js"]`. Relative paths resolve from Claude Code's working directory (not the project directory), causing "command not found" or "module not found" errors. The server appears configured but never starts, showing as "disconnected" with no helpful error message.

**Why it happens:**
Installer scripts copy skill files and configure MCP server without understanding where Claude Code will execute the command. Using `"command": "node dist/mcp/index.js"` works when testing from project root but fails when Claude Code runs it from a different working directory. npm-installed binaries (`tasks` CLI) work because they're in PATH, but project-relative paths don't. Developers test by manually running the command from the correct directory and it works, missing the real-world execution context.

**Consequences:**
- MCP server shows "disconnected" or "error" in Claude Code
- No clear error message about path resolution failure
- Works for developer who set it up, fails for other users
- Different behavior on different machines based on Claude Code installation location
- Skills can't invoke tools because server never connected
- Users manually starting server works, automatic startup fails

**Prevention:**
- **ALWAYS** use absolute paths in MCP server configuration
- Installer must compute absolute path: `"args": ["/home/user/wood-fired-bugs/dist/mcp/index.js"]`
- For npm-installed packages, use `npx` with package name: `"command": "npx"`, `"args": ["wood-fired-bugs-mcp"]`
- Alternative: use `$HOME` environment variable expansion if Claude Code supports it
- Test configuration by running from different working directories
- Installer should detect project path and write absolute path to config
- Document in README: "MCP config uses absolute paths to ensure Claude Code can start server from any location"

**Detection:**
- Claude Code shows MCP server as configured but "disconnected"
- Running the command from project root works, from elsewhere fails
- Error logs show "Cannot find module" or "ENOENT: no such file or directory"
- `config.json` contains relative paths in command or args
- Manual testing works, automated startup fails

**Phase to address:**
Phase 10 (Installer Script) - Installer must write correct absolute paths. Relative paths discovered during testing won't work for end users.

**Sources:**
- [Configuring MCP Tools in Claude Code - Scott Spence](https://scottspence.com/posts/configuring-mcp-tools-in-claude-code)
- [Claude Code CLI Best Practices](https://notes.muthu.co/2026/02/claude-code-cli-best-practices-checklist/)

---

### Pitfall 4: Shell Profile Detection - Writing to Wrong RC File

**What goes wrong:**
The installer script writes `export WOOD_FIRED_BUGS_API_KEY="..."` to `~/.bashrc` on Linux, but the user's default shell is zsh (which reads `~/.zshrc`) or fish (which reads `~/.config/fish/config.fish`). The environment variable is configured in bash profile but never loaded in the actual shell the user runs. Skills fail with "unauthorized" or "API key not set" errors despite the installer claiming successful setup.

**Why it happens:**
Installer scripts assume bash as default shell and blindly write to `~/.bashrc`. On macOS since Catalina (2019) and many modern Linux distros, zsh is the default shell. Some developers use fish. Each shell has different profile file locations and syntax. Detecting the current shell requires checking `$SHELL` environment variable, but this might not match the shell that will actually source the environment variable later. Testing on developer's machine (bash user) succeeds, fails for zsh/fish users.

**Consequences:**
- Environment variable never loaded despite installer success message
- MCP tools fail with "unauthorized" or authentication errors
- Works for developer, fails for users with different shells
- Different behavior on macOS (zsh) vs Linux (bash/zsh/fish)
- Users must manually add export to correct shell profile
- Installer claims success but setup is incomplete

**Prevention:**
- Detect shell with `$SHELL` environment variable: `echo $SHELL` returns `/bin/zsh`, `/bin/bash`, `/usr/bin/fish`
- Write to appropriate profile for detected shell:
  - **bash**: `~/.bashrc` (Linux) or `~/.bash_profile` (macOS login shell)
  - **zsh**: `~/.zshrc` (both macOS and Linux)
  - **fish**: `~/.config/fish/config.fish` (syntax: `set -Ux WOOD_FIRED_BUGS_API_KEY "value"`)
- Fallback: if shell unknown, write to `~/.profile` (sourced by most shells) and warn user
- Better approach: prompt user which shell they use instead of auto-detecting
- For fish, use `set -Ux` (universal export) instead of `export` syntax
- Remind user to reload shell: `source ~/.zshrc` or restart terminal
- Test installer on virtual machines with different shells (bash, zsh, fish)

**Detection:**
- Run `echo $WOOD_FIRED_BUGS_API_KEY` in fresh terminal and value is empty
- Installer modified `~/.bashrc` but `echo $SHELL` shows `/bin/zsh`
- MCP tools fail with authentication errors after "successful" installation
- Environment variable present when running `bash` manually but not in default shell
- Skills work after manual `export` but not in fresh terminal sessions

**Phase to address:**
Phase 10 (Installer Script) - Critical for Linux installer. Must handle bash, zsh, and fish. Wrong detection = broken installation for entire user segment.

**Sources:**
- [Moving to zsh, part 2: Configuration Files](https://scriptingosx.com/2019/06/moving-to-zsh-part-2-configuration-files/)
- [fish shell Tutorial](https://fishshell.com/docs/current/tutorial.html)
- [nvm profile detection issue](https://github.com/nvm-sh/nvm/issues/1837)

---

### Pitfall 5: Windows PowerShell Execution Policy Blocking Installer

**What goes wrong:**
The Windows installer is a `.ps1` PowerShell script that users download and attempt to run with `.\install.ps1`. PowerShell's default execution policy (often `Restricted` or `RemoteSigned`) prevents running scripts that aren't signed, showing "cannot be loaded because running scripts is disabled on this system." The installer doesn't run at all, leaving users stuck without guidance on how to proceed.

**Why it happens:**
PowerShell has security policies that block script execution by default on many Windows installations, especially corporate environments. Developers test on their own machines where execution policy is already `Unrestricted` or they run PowerShell as administrator (changing the policy globally). End users don't have admin rights or don't know how to change execution policy. The error message mentions execution policy but doesn't explain how to fix it. Users abandon installation.

**Consequences:**
- Installer completely blocked on default Windows configurations
- Error message is cryptic for non-PowerShell users
- Users don't know whether to run as admin, change policy, or use different method
- Corporate Windows machines often can't change execution policy (IT-enforced)
- Installer works on developer machine but fails for real users
- No graceful fallback or alternative installation method

**Prevention:**
- **Document** execution policy requirement prominently in README: "Windows users must run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`"
- Provide alternative installation method: manual steps without script
- Include batch file (`.bat`) wrapper that bypasses policy: `powershell -ExecutionPolicy Bypass -File .\install.ps1`
- Better: single-line installation: `powershell -ExecutionPolicy Bypass -Command "& {$(irm install.ps1)}"`
- Detect policy in script and provide helpful error: "Run: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`"
- Document admin rights NOT required (use `-Scope CurrentUser` not `-Scope LocalMachine`)
- Test on fresh Windows VM with default execution policy
- Provide video walkthrough for Windows installation with policy change

**Detection:**
- Running `.\install.ps1` produces "scripts is disabled on this system" error
- `Get-ExecutionPolicy` returns `Restricted` or `AllSigned`
- Installer works on dev machine but fails for test users
- Corporate Windows machines consistently reject installer
- Users report "can't run PowerShell script"

**Phase to address:**
Phase 10 (Installer Script) - Windows installer must document or work around execution policy. Critical for Windows adoption.

**Sources:**
- [PowerShell Execution Policy - Microsoft Learn](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)
- [PowerShell Beyond Windows: Cross-Platform Guide](https://medium.com/@josephsims1/powershell-beyond-windows-a-cross-platform-guide-2f6d6de473dd)

---

### Pitfall 6: Environment Variables Not Persisting After Installer Runs

**What goes wrong:**
The installer script sets `export WOOD_FIRED_BUGS_API_KEY="..."` in the shell profile (`~/.zshrc` or `~/.bashrc`), shows "Installation complete! Environment variable configured," but when the user runs skills in Claude Code, the MCP server can't access the environment variable and reports "API key not set." The variable works in new terminal sessions but not in the Claude Code environment where MCP server actually runs.

**Why it happens:**
Claude Code's MCP server process inherits environment from the Claude Code application, not from the user's shell profile. On macOS, GUI applications don't source shell profiles (`~/.zshrc`), so environment variables set there aren't available. On Linux, it depends on how Claude Code was launched (terminal vs. application menu). The installer modifies shell profile successfully, new terminal sessions load it, but Claude Code launched from GUI doesn't see it. Users verify with `echo $WOOD_FIRED_BUGS_API_KEY` in terminal (works) and assume it's configured, but Claude Code process doesn't have it.

**Consequences:**
- MCP tools fail with "unauthorized" despite variable being "configured"
- Works in terminal testing, fails in actual Claude Code usage
- Different behavior on macOS vs Linux vs Windows
- Variable present in shell, absent in Claude Code MCP server process
- Users frustrated by inconsistent environment variable behavior
- Installer claims success but setup doesn't work where it matters

**Prevention:**
- **macOS**: Document that GUI apps don't source shell profiles; recommend setting in `~/.MacOSX/environment.plist` (deprecated) or use LaunchAgent to set globally
- **Better for all platforms**: Configure environment variable in MCP server's config.json directly:
  ```json
  {
    "mcpServers": {
      "wood-fired-bugs": {
        "command": "node",
        "args": ["/path/to/dist/mcp/index.js"],
        "env": {
          "WOOD_FIRED_BUGS_API_KEY": "actual-key-value"
        }
      }
    }
  }
  ```
- Installer should write API key to MCP config `env` section, not rely on shell profile
- Still write to shell profile for CLI usage (terminal commands), but MCP config is critical
- Test by launching Claude Code from GUI (not terminal) and verify MCP server has variable
- Document: "Environment variables in shell profile work for terminal, MCP config for Claude Code"

**Detection:**
- Run `/mcp` in Claude Code and check if server shows "connected" or "auth error"
- MCP server logs show "WOOD_FIRED_BUGS_API_KEY is undefined"
- `echo $WOOD_FIRED_BUGS_API_KEY` in terminal works, but skills fail with auth error
- Restarting terminal loads variable, restarting Claude Code doesn't help
- Works when Claude Code launched from terminal, fails when launched from dock/menu

**Phase to address:**
Phase 10 (Installer Script) - Critical for MCP server authentication. Shell profile configuration is insufficient; must write to MCP config's `env` section.

**Sources:**
- [Managing API key environment variables in Claude Code](https://support.claude.com/en/articles/12304248-managing-api-key-environment-variables-in-claude-code)
- [Common Mistakes with .env Files](https://medium.com/byte-of-knowledge/common-mistakes-developers-make-with-env-files-1dbd72272eba)

---

### Pitfall 7: Cross-Platform Path Separators in Installer

**What goes wrong:**
The installer script constructs file paths using hardcoded `/` (forward slash) separators, which work on Linux and macOS but fail on Windows where paths use `\` (backslash). PowerShell commands like `Copy-Item "$HOME/.claude/commands/tasks/log-bug.md"` fail with "path not found" because PowerShell interprets forward slashes differently in some contexts. Paths get mangled, files end up in wrong locations, or operations fail completely.

**Why it happens:**
Bash and PowerShell handle path separators differently. While PowerShell often accepts forward slashes, certain operations (especially with `Copy-Item`, file system cmdlets) expect native backslashes or fail silently. Developers write `$HOME/.claude/commands` in Bash and `$env:USERPROFILE/.claude/commands` in PowerShell assuming equivalence, but path construction differs. Hardcoding separators seems simpler than using platform-specific path joining, but breaks cross-platform compatibility.

**Consequences:**
- Windows installer creates directories with wrong separators: `C:\Users\Name\.claude/commands`
- Files copied to incorrect locations or fail with "path not found"
- Different behavior on Windows vs. Linux for "identical" installer
- Installer appears to succeed but files are misplaced
- Skills not found by Claude Code because directory structure is wrong
- Difficult to debug because paths look correct in some contexts

**Prevention:**
- **PowerShell**: Use `Join-Path` cmdlet instead of string concatenation:
  ```powershell
  $skillDir = Join-Path $env:USERPROFILE ".claude" "commands" "tasks"
  ```
- **Bash**: Use forward slashes (native on Linux/macOS), no special handling needed:
  ```bash
  skill_dir="$HOME/.claude/commands/tasks"
  ```
- Don't assume `/` works everywhere; PowerShell prefers `\` for native cmdlets
- Test installer on actual Windows (not WSL) to verify path handling
- Use PowerShell's `[System.IO.Path]::Combine()` for guaranteed correct separators
- Avoid mixing `cmd.exe` path conventions with PowerShell paths

**Detection:**
- Windows installation creates `.claude/commands` as single directory name instead of nested path
- Files end up in `C:\Users\Name\.claude` instead of `C:\Users\Name\.claude\commands\tasks`
- `Test-Path` checks fail on Windows but work on Linux
- Skills not detected by Claude Code on Windows installation
- Manual path inspection shows forward slashes in Windows registry or filesystem

**Phase to address:**
Phase 10 (Installer Script) - Windows installer must use PowerShell path cmdlets. Linux installer can use standard forward slashes.

**Sources:**
- [PowerShell on Linux: Windows Script Compatibility](https://windowsforum.com/threads/powershell-on-linux-3-practical-paths-to-windows-script-compatibility.400301/)
- [PowerShell differences on non-Windows platforms](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/unix-support)

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Hardcoding `mcp__plugin_tasks_wood-fired-bugs__` prefix in skills | Faster skill authoring, no need to look up full names | If server name changes, all skills break; harder to test with different MCP configs | Never - always use correct full names from start |
| Using console.log() for debugging MCP server | Quick debugging during development | Breaks stdio transport when deployed; -32000 errors in production | Only in isolated test scripts, never in server code |
| Copying skill examples without testing MCP tool names | Fast skill prototyping based on examples | Skills reference wrong tool names and fail at runtime | Only in draft phase; must verify before commit |
| Installer assumes bash on Linux | Simpler installer logic, no shell detection | Fails for zsh/fish users (large user segment on modern distros) | Only if documenting "bash only" limitation clearly |
| Shell profile for all env vars | Standard pattern, works for CLI tools | GUI-launched apps (Claude Code) don't source profiles | Acceptable for CLI-only tools; must use MCP config `env` for Claude Code |
| Relative paths in MCP config | Shorter, more readable config | Breaks when Claude Code runs from different directory | Never - always use absolute paths in production config |

## Integration Gotchas

Common mistakes when integrating Claude Code skills with existing MCP server.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| MCP tool references in skills | Using simple tool names (`create_task`) from server implementation | Use fully qualified names from `/mcp` command output (`mcp__plugin_tasks_wood-fired-bugs__create_task`) |
| Skill directory structure | Creating flat `.md` files in `~/.claude/commands/` | Skills require directory with `SKILL.md` entrypoint; slash commands can be flat `.md` |
| allowed-tools in skill frontmatter | Listing tools without full qualification | Must use full MCP tool names: `mcp__plugin_tasks_wood-fired-bugs__*` for wildcards |
| API key configuration | Only setting in shell profile | Must set in MCP server config's `env` section for GUI-launched Claude Code |
| Testing skills locally | Testing with MCP server run manually in terminal | Must test with server auto-started by Claude Code config to catch environment issues |
| Installer verification | Checking if files copied and profile modified | Must test actual skill invocation in Claude Code after installation |

## Security Mistakes

Domain-specific security issues beyond general security practices.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Hardcoding API key in skill markdown | API key leaked in skill files, committed to git | Use environment variable reference only; installer sets actual key in user's environment |
| Writing API key to shell profile with 644 permissions | Key readable by all users on shared machine | Installer should create or verify restrictive permissions (600) on profile files |
| Including API key in MCP config JSON with default permissions | Key exposed in `~/.claude/config.json` readable by other processes | Set file permissions to 600 after writing; document security implication |
| Skill examples showing real API keys | Users copy-paste examples with keys into their own configs | Always use placeholder `YOUR_API_KEY_HERE` in examples and documentation |
| No validation of API key format in installer | Installer accepts any string, user enters invalid key | Validate API key format (pattern match) and optionally test connectivity before writing |
| API key transmitted in MCP protocol | Key visible in process arguments or logs | Pass via environment variable, never as command-line argument |

## UX Pitfalls

Common user experience mistakes when adding skills and installer.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Error message: "tool not found: create_task" | User thinks MCP server not configured correctly | Detect unqualified tool name and suggest full name: "Did you mean mcp__plugin_tasks_wood-fired-bugs__create_task?" |
| Installer completes but skills don't work | User assumes installation successful, wastes time debugging | Installer runs connectivity test at end: verify MCP server can be reached and responds |
| No feedback during skill execution | User doesn't know if skill is working or stuck | Skills should log progress: "Searching tasks...", "Found 5 results", "Creating task..." |
| Generic error when MCP server unreachable | User doesn't know if server is down, misconfigured, or network issue | Check specific failure: "MCP server not running. Start with: tasks serve" or "API key missing" |
| Installer assumes user knows shell | Users confused by "reload your shell" instruction | Provide explicit command: "Run: source ~/.zshrc (or restart terminal)" |
| Skills fail silently when API key wrong | User thinks service is down | Validate API key before MCP tool calls; provide clear auth error message |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Skill markdown created:** Often missing actual testing with `/skill-name` invocation in Claude Code
- [ ] **MCP config added:** Often missing `env` section with API key (relies on shell profile which doesn't work for GUI apps)
- [ ] **Installer writes to shell profile:** Often missing verification that correct shell detected (bash vs zsh vs fish)
- [ ] **Installer shows "success":** Often missing actual connectivity test (MCP server ping or health check)
- [ ] **Tool names in skills:** Often missing fully qualified names (uses simple names that fail at runtime)
- [ ] **Windows installer tested:** Often missing test on actual Windows (developer uses WSL which is Linux)
- [ ] **MCP server logging:** Often missing stderr routing (console.log() used, breaks stdio transport)
- [ ] **Cross-platform paths:** Often missing PowerShell path cmdlets (hardcoded `/` separators fail on Windows)
- [ ] **Skill documentation:** Often missing MCP tool list showing full qualified names for reference
- [ ] **Installer rollback:** Often missing cleanup on failure (leaves partial config, corrupted profile)

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Unqualified tool names in skills | LOW | 1. Run `/mcp` to get correct names. 2. Find-replace in all skill .md files. 3. Test each skill. (1-2 hours for 10 skills) |
| stdout logging in MCP server | LOW | 1. Replace console.log() with console.error(). 2. Rebuild. 3. Restart Claude Code to reconnect. (15 minutes) |
| Wrong shell profile detection | MEDIUM | 1. Provide manual instructions for all shells. 2. Users run shell-specific setup. 3. Update installer with detection. (2-4 hours dev + user support) |
| Relative paths in MCP config | LOW | 1. Update config.json with absolute paths. 2. Restart Claude Code. 3. Document absolute path requirement. (30 minutes) |
| Environment variable not in Claude Code | MEDIUM | 1. Add `env` section to MCP config. 2. Users re-run installer or manual edit. 3. Restart Claude Code. (1 hour + user re-setup) |
| Windows execution policy blocks installer | LOW | 1. Document policy change or bypass. 2. Provide alternative manual installation steps. 3. Create .bat wrapper. (1 hour) |
| Path separator issues on Windows | MEDIUM | 1. Rewrite PowerShell installer with Join-Path. 2. Users re-run installer (overwrites incorrect paths). 3. Test on Windows VM. (2-3 hours) |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Unqualified MCP tool names | Phase 9 (Skill Authoring) | Run each skill and verify tools invoke successfully; check skill .md files for `mcp__plugin_` prefix |
| stdout logging | Phase 8 (MCP Server Verification) | Run MCP server standalone; verify stdout contains ONLY JSON-RPC (no text logs); test Claude Code connection |
| MCP config paths | Phase 10 (Installer Script) | Install on fresh VM; verify config.json contains absolute paths; test MCP server auto-starts |
| Shell profile detection | Phase 10 (Installer Script) | Test installer on bash, zsh, fish; verify correct profile modified; run `echo $VAR` in fresh shell |
| Windows execution policy | Phase 10 (Installer Script) | Test on Windows with default Restricted policy; verify error message or bypass documented |
| Environment variable in Claude Code | Phase 10 (Installer Script) | Launch Claude Code from GUI (not terminal); verify MCP server has env var; test skill auth |
| Path separators on Windows | Phase 10 (Installer Script) | Run Windows installer; verify paths use backslashes; check files created in correct nested structure |

## Phase-Specific Research Flags

Phases likely to need deeper research based on findings.

| Phase | Research Flag | Why |
|-------|---------------|-----|
| Phase 8 (MCP Server Verification) | Deeper research needed | Verify existing v1.1 server doesn't use console.log(); test stdio transport compliance; may need refactoring |
| Phase 9 (Skill Authoring) | Standard patterns available | MCP tool usage well-documented in plugin-dev examples; follow established patterns with verified tool names |
| Phase 10 (Installer - Linux) | Moderate research needed | Shell detection logic for bash/zsh/fish; environment variable persistence across shells; testing on multiple distros |
| Phase 10 (Installer - Windows) | Deeper research needed | PowerShell execution policy handling; path separator issues; environment variable for GUI apps; testing on Windows |
| Phase 11 (Integration Testing) | Standard testing approaches | Verify skills invoke correctly; MCP server connects; installer produces working setup; E2E testing skills in Claude Code |

## Sources

### Claude Code Skills & MCP Integration
- [Extend Claude with skills - Claude Code Docs](https://code.claude.com/docs/en/skills)
- [The Pulumi Blog - Claude Skills for DevOps](https://www.pulumi.com/blog/top-8-claude-skills-devops-2026/)
- [Claude Code Evolution: MCP, Commands, Agents & Skills](https://claude-world.com/articles/claude-code-evolution/)
- [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Inside Claude Code Skills: Structure and Invocation](https://mikhail.io/2025/10/claude-code-skills/)
- [Claude Skills vs Slash Commands 2026](https://yingtu.ai/blog/claude-code-skills-vs-slash-commands)

### MCP Server Configuration & Transport
- [STDIO Transport - MCP Framework](https://mcp-framework.com/docs/Transports/stdio-transport/)
- [Debugging MCP Servers: Tips and Best Practices](https://www.mcpevals.io/blog/debugging-mcp-servers-tips-and-best-practices)
- [MCP Server Troubleshooting Guide 2025](https://www.mcpstack.org/learn/mcp-server-troubleshooting-guide-2025)
- [Configuring MCP Tools in Claude Code - Scott Spence](https://scottspence.com/posts/configuring-mcp-tools-in-claude-code)
- [Claude Code CLI Best Practices Checklist](https://notes.muthu.co/2026/02/claude-code-cli-best-practices-checklist/)

### Cross-Platform Installer & Environment Variables
- [PowerShell Beyond Windows: Cross-Platform Guide](https://medium.com/@josephsims1/powershell-beyond-windows-a-cross-platform-guide-2f6d6de473dd)
- [Installing PowerShell on Linux in 2026](https://thelinuxcode.com/installing-powershell-on-linux-in-2026-a-practical-opinionated-walkthrough/)
- [PowerShell differences on non-Windows platforms](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/unix-support)
- [Variables in any environment](https://cgjennings.ca/articles/environment-variables/)
- [Managing API key environment variables in Claude Code](https://support.claude.com/en/articles/12304248-managing-api-key-environment-variables-in-claude-code)

### Shell Profile Configuration
- [Moving to zsh, part 2: Configuration Files](https://scriptingosx.com/2019/06/moving-to-zsh-part-2-configuration-files/)
- [fish shell Tutorial](https://fishshell.com/docs/current/tutorial.html)
- [Shell Profile Detection Issue - nvm](https://github.com/nvm-sh/nvm/issues/1837)
- [Bash and Zsh Profile Files](https://ss64.com/mac/syntax-profile.html)
- [Startup scripts of Bash and Zsh](https://tanguy.ortolo.eu/blog/article25/shrc)

### Security & Best Practices
- [API Key Best Practices](https://support.claude.com/en/articles/9767949-api-key-best-practices-keeping-your-keys-safe-and-secure)
- [Common Mistakes with .env Files](https://medium.com/byte-of-knowledge/common-mistakes-developers-make-with-env-files-1dbd72272eba)
- [8 tips for securely using API keys](https://blog.streamlit.io/8-tips-for-securely-using-api-keys/)

---
*Pitfalls research for: Wood Fired Bugs v1.2 - Claude Code Skills & Installer*
*Researched: 2026-02-13*
*Confidence: HIGH - Based on official documentation, community best practices, and cross-platform compatibility research*
