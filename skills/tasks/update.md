---
name: update
description: "Updates the Wood Fired Tasks CLI to the latest published version by running `tasks self-update`. Use when user wants to update tasks, upgrade the CLI, or acts on the status-line update hint (⬆ /tasks:update)."
disable-model-invocation: false
---

# Update Wood Fired Tasks

> ⚠️ **Trusted-operator / trusted-repo operation.** This skill runs
> `tasks self-update`, which shells out to a global npm install
> (`npm i -g wood-fired-tasks@latest`) and mutates the host's globally
> installed CLI. Run it ONLY against a checkout you trust and operate. A
> static-trust or security review of an **untrusted** checkout must **read,
> not run**, this flow — never execute self-update, install, or package
> flows while evaluating an unknown repo.

Updates the installed `tasks` CLI to the latest published version by running the
built-in `tasks self-update` command. This is the action target of the
status-line update notification (`⬆ /tasks:update`).

## Preflight

`tasks self-update` shells out to npm (`npm i -g wood-fired-tasks@latest`) — it
does NOT require an MCP tool. It works only for npm-global installs and never
uses sudo. If the binary is not on `PATH`, surface the error verbatim and
suggest the user re-run the project's install/setup step.

## Workflow

1. **Run the self-update command**
   - Execute `tasks self-update` in a shell.
   - This spawns `npm i -g wood-fired-tasks@latest` (no sudo) and, on success,
     replaces the globally installed CLI with the latest published version.

2. **Report the result**
   - On success: report the new installed version (the command prints it) and
     confirm the update completed.
   - On failure: report the command's stderr verbatim. Common causes are a
     missing/misconfigured npm global prefix or insufficient permissions —
     point the user at `tasks setup --fix-npm-prefix` so future updates run
     without elevation.

3. **Confirm next steps**
   - Note that the new version takes effect on the next `tasks` invocation /
     new session. No further action is needed.

## Example Usage

```
/tasks:update
```

Result: runs `tasks self-update`, upgrading the CLI to the latest published
version and reporting the new version number.
